'use strict';
// Everything that changes an app goes through AppService. Slow work (unpack,
// npm install, build, restore) runs as a background job; the app shows a
// "task" while it runs and the build output lands in the app log.
const fs = require('fs-extra');
const path = require('path');
const { extractZip } = require('./archive');
const { buildApp } = require('./build');
const { isPortFree } = require('./processes');
const database = require('./database');
const {
  APP_TYPES, DB_TYPES, SCHEDULES, HttpError, slugify, isValidId, isValidPgIdent, isValidEnvKey, run,
} = require('./util');

const RESERVED_ENV = new Set(['PORT', 'APP_PORT', 'PIPAAS_APP_ID', 'DATA_DIR', 'DATABASE_URL', 'SQLITE_PATH', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT']);

class AppService {
  constructor(cfg, registry, pm, backups, { log = console, runAs = null } = {}) {
    this.cfg = cfg;
    this.registry = registry;
    this.pm = pm;
    this.backups = backups;
    this.log = log;
    this.runAs = runAs;
    this.tasks = new Map();
    this.running = new Set();
  }

  appDir(id) { return path.join(this.cfg.appsDir, id); }

  volumeDir(id) { return path.join(this.cfg.volumesDir, id); }

  // ---------- views ----------

  view(id, host) {
    const app = this.registry.get(id);
    if (!app) return null;
    const proc = this.pm.info(id);
    const task = this.tasks.get(id) || null;
    const urlHost = this.cfg.publicHost || host || 'localhost';
    return {
      id,
      name: app.name,
      type: app.type,
      port: app.port,
      url: `http://${urlHost}:${app.port}`,
      dbType: app.dbType,
      dbInfo: database.publicDbInfo(app.dbInfo),
      desired: app.desired,
      status: task ? task.kind : proc.status,
      pid: proc.pid,
      startedAt: proc.startedAt,
      lastExit: proc.lastExit,
      task,
      lastError: app.lastError || null,
      version: app.version,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      backupSchedule: app.backupSchedule,
      startCommand: app.startCommand || '',
      envKeys: Object.keys(app.env || {}),
    };
  }

  list(host) {
    return this.registry.all().map((a) => this.view(a.id, host)).sort((a, b) => a.name.localeCompare(b.name));
  }

  mustGet(id) {
    if (!isValidId(id)) throw new HttpError(404, 'App not found');
    const app = this.registry.get(id);
    if (!app) throw new HttpError(404, 'App not found');
    return app;
  }

  assertIdle(id) {
    const t = this.tasks.get(id);
    if (t) throw new HttpError(409, `App is busy (${t.kind}), try again when it has finished`);
  }

  // ---------- ports ----------

  async checkPort(port, exceptId) {
    if (!Number.isInteger(port) || port < this.cfg.portStart || port > this.cfg.portEnd) {
      throw new HttpError(400, `Port must be between ${this.cfg.portStart} and ${this.cfg.portEnd}`);
    }
    const owner = this.registry.all().find((a) => a.port === port && a.id !== exceptId);
    if (owner) throw new HttpError(409, `Port ${port} is already used by "${owner.name}"`);
    if (!(await isPortFree(port))) {
      const mine = exceptId && this.registry.get(exceptId) && this.registry.get(exceptId).port === port;
      if (!mine) throw new HttpError(409, `Port ${port} is already used by another process`);
    }
  }

  async ports() {
    const byPort = new Map(this.registry.all().map((a) => [a.port, a]));
    const out = [];
    const checks = [];
    for (let p = this.cfg.portStart; p <= this.cfg.portEnd; p++) {
      const app = byPort.get(p);
      if (app) out.push({ port: p, available: false, usedBy: 'app', appName: app.name });
      else checks.push(isPortFree(p).then((free) => out.push({ port: p, available: free, usedBy: free ? null : 'system', appName: null })));
    }
    await Promise.all(checks);
    return out.sort((a, b) => a.port - b.port);
  }

  async freePort() {
    const used = new Set(this.registry.usedPorts());
    for (let p = this.cfg.portStart; p <= this.cfg.portEnd; p++) {
      if (!used.has(p) && (await isPortFree(p))) return p;
    }
    throw new HttpError(409, 'No free ports left in the configured range');
  }

  // ---------- jobs ----------

  runTask(id, kind, fn) {
    const task = { kind, since: new Date().toISOString() };
    this.tasks.set(id, task);
    const p = (async () => {
      try {
        await fn();
        this.registry.update(id, { lastError: null });
      } catch (err) {
        this.pm.note(id, `${kind} failed: ${err.message}`);
        this.log.error(`[${id}] ${kind} failed: ${err.message}`);
        if (this.registry.get(id)) this.registry.update(id, { lastError: { task: kind, message: err.message, at: new Date().toISOString() } });
      } finally {
        this.tasks.delete(id);
        this.running.delete(p);
      }
    })();
    this.running.add(p);
    return task;
  }

  /** Wait for background jobs (tests and shutdown). */
  async settle() {
    while (this.running.size) await Promise.all([...this.running]);
  }

  logWriter(id) {
    return (chunk) => {
      try { fs.appendFileSync(this.pm.logFile(id), chunk); } catch { /* ignore */ }
    };
  }

  async chownForApp(...dirs) {
    if (!this.runAs) return;
    for (const d of dirs) {
      if (await fs.pathExists(d)) await run('chown', ['-R', `${this.runAs.uid}:${this.runAs.gid}`, d]);
    }
  }

  async unpackUpload(file, dest) {
    await fs.ensureDir(dest);
    if (/\.html?$/i.test(file.originalname)) {
      await fs.move(file.path, path.join(dest, 'index.html'), { overwrite: true });
    } else {
      try {
        await extractZip(file.path, dest);
      } finally {
        await fs.remove(file.path);
      }
    }
  }

  // ---------- deploy ----------

  async deploy({ name, type, dbType = 'none', dbName, port, file }, host) {
    let handedOff = false;
    try {
      name = String(name || '').trim();
      if (!name) throw new HttpError(400, 'Name is required');
      if (name.length > 60) throw new HttpError(400, 'Name is too long (max 60 characters)');
      if (!APP_TYPES.includes(type)) throw new HttpError(400, `Type must be one of: ${APP_TYPES.join(', ')}`);
      if (!DB_TYPES.includes(dbType)) throw new HttpError(400, `Database must be one of: ${DB_TYPES.join(', ')}`);
      if (!file) throw new HttpError(400, 'A .zip or .html file is required');
      const id = slugify(name);
      if (!isValidId(id)) throw new HttpError(400, 'Name must contain letters or digits');
      if (this.registry.get(id) || this.tasks.has(id)) throw new HttpError(409, 'An app with this name already exists');

      let pgName = null;
      if (dbType === 'postgres') {
        if (!database.postgresAvailable()) throw new HttpError(400, 'PostgreSQL is not installed on this machine');
        pgName = dbName ? String(dbName).toLowerCase().replace(/[^a-z0-9_]/g, '_') : `pipaas_${id.replace(/-/g, '_')}`;
        if (!isValidPgIdent(pgName)) throw new HttpError(400, 'Invalid database name');
      }
      if (port) await this.checkPort(Number(port));
      const appPort = port ? Number(port) : await this.freePort();
      const now = new Date().toISOString();
      this.registry.set(id, {
        name, type, port: appPort, dbType, dbInfo: null, env: {}, startCommand: '', backupSchedule: 'off',
        desired: 'stopped', version: 1, createdAt: now, updatedAt: now, lastError: null,
      });
      await fs.remove(this.pm.logFile(id));
      this.pm.note(id, `Deploying ${name} (${type})`);

      handedOff = true;
      this.runTask(id, 'deploying', async () => {
        const dir = this.appDir(id);
        const vol = this.volumeDir(id);
        await fs.remove(dir);
        await this.unpackUpload(file, dir);
        await fs.ensureDir(vol);
        await fs.ensureDir(this.cfg.homeDir);
        let dbInfo = null;
        if (dbType === 'sqlite') {
          const fname = `${(dbName || 'data').replace(/[^a-z0-9_-]/gi, '') || 'data'}.db`;
          dbInfo = { type: 'sqlite', name: fname, path: path.join(vol, fname) };
        } else if (dbType === 'postgres') {
          this.pm.note(id, `Creating PostgreSQL database ${pgName}`);
          dbInfo = await database.createPostgres(pgName);
        }
        this.registry.update(id, { dbInfo });
        await this.chownForApp(dir, vol, this.cfg.homeDir);
        await buildApp(this.cfg, dir, this.registry.get(id), { runAs: this.runAs, onOutput: this.logWriter(id) });
        this.registry.update(id, { desired: 'running' });
        await this.pm.start(id);
      });
      return this.view(id, host);
    } finally {
      // The job owns the upload once it starts; otherwise it is left over from a refused request.
      if (file && !handedOff) await fs.remove(file.path).catch(() => {});
    }
  }

  // ---------- update ----------

  async update(id, { file, port }, host) {
    let app;
    let newPort;
    try {
      app = this.mustGet(id);
      this.assertIdle(id);
      newPort = port ? Number(port) : null;
      if (newPort && newPort !== app.port) await this.checkPort(newPort, id);
      if (!file && !(newPort && newPort !== app.port)) {
        throw new HttpError(400, 'Nothing to update: choose a file or a new port');
      }
    } catch (err) {
      if (file) await fs.remove(file.path).catch(() => {});
      throw err;
    }

    if (!file) {
      const wasRunning = app.desired === 'running';
      await this.pm.stop(id);
      this.registry.update(id, { port: newPort });
      if (wasRunning) await this.pm.start(id);
      return this.view(id, host);
    }

    this.runTask(id, 'updating', async () => {
      const dir = this.appDir(id);
      const old = path.join(this.cfg.appsDir, `.old-${id}`);
      await this.pm.stop(id);
      if (newPort) this.registry.update(id, { port: newPort });
      await fs.remove(old);
      if (await fs.pathExists(dir)) await fs.move(dir, old);
      try {
        await this.unpackUpload(file, dir);
        // v1.0 kept SQLite inside the app folder: carry it over.
        const db = app.dbInfo;
        if (db && db.type === 'sqlite' && db.path && db.path.startsWith(dir + path.sep)) {
          const prev = path.join(old, path.relative(dir, db.path));
          if (await fs.pathExists(prev)) await fs.copy(prev, db.path);
        }
        await this.chownForApp(dir);
        await buildApp(this.cfg, dir, this.registry.get(id), { runAs: this.runAs, onOutput: this.logWriter(id) });
      } catch (err) {
        this.pm.note(id, 'Update failed, putting the previous version back');
        await fs.remove(dir);
        if (await fs.pathExists(old)) await fs.move(old, dir);
        if (app.desired === 'running') await this.pm.start(id).catch(() => {});
        throw err;
      }
      await fs.remove(old);
      this.registry.update(id, { version: (app.version || 1) + 1, desired: 'running' });
      await this.pm.start(id);
    });
    return this.view(id, host);
  }

  // ---------- lifecycle ----------

  async start(id) {
    this.mustGet(id);
    this.assertIdle(id);
    this.registry.update(id, { desired: 'running' });
    await this.pm.start(id);
  }

  async stop(id) {
    this.mustGet(id);
    this.assertIdle(id);
    this.registry.update(id, { desired: 'stopped' });
    await this.pm.stop(id);
  }

  async restart(id) {
    this.mustGet(id);
    this.assertIdle(id);
    this.registry.update(id, { desired: 'running' });
    await this.pm.restart(id);
  }

  async remove(id) {
    const app = this.mustGet(id);
    this.assertIdle(id);
    await this.pm.stop(id);
    this.pm.forget(id);
    if (app.dbInfo && app.dbInfo.type === 'postgres') await database.dropPostgres(app.dbInfo);
    await this.backups.removeAll(id);
    await fs.remove(this.appDir(id));
    await fs.remove(this.volumeDir(id));
    await fs.remove(this.pm.logFile(id));
    await fs.remove(`${this.pm.logFile(id)}.1`);
    this.registry.remove(id);
  }

  async restoreAll() {
    for (const app of this.registry.all()) {
      if (app.desired !== 'running') continue;
      try {
        await this.pm.start(app.id);
        this.log.log(`[restore] started ${app.id}`);
      } catch (err) {
        this.log.error(`[restore] ${app.id}: ${err.message}`);
        this.pm.note(app.id, `Could not start at boot: ${err.message}`);
      }
    }
  }

  // ---------- settings ----------

  async setSettings(id, { env, startCommand }) {
    const app = this.mustGet(id);
    this.assertIdle(id);
    const patch = {};
    if (env !== undefined) {
      if (!env || typeof env !== 'object' || Array.isArray(env)) throw new HttpError(400, 'env must be an object');
      const clean = {};
      for (const [k, v] of Object.entries(env)) {
        if (!isValidEnvKey(k)) throw new HttpError(400, `Invalid variable name "${k}"`);
        if (RESERVED_ENV.has(k)) throw new HttpError(400, `${k} is set by Pi-PaaS and cannot be overridden`);
        if (typeof v !== 'string' || v.length > 8192 || v.includes('\0')) throw new HttpError(400, `Invalid value for ${k}`);
        clean[k] = v;
      }
      if (Object.keys(clean).length > 200) throw new HttpError(400, 'Too many variables');
      patch.env = clean;
    }
    if (startCommand !== undefined) {
      if (typeof startCommand !== 'string' || startCommand.length > 1000 || /[\r\n\0]/.test(startCommand)) throw new HttpError(400, 'Invalid start command');
      patch.startCommand = startCommand.trim();
    }
    this.registry.update(id, patch);
    if (app.desired === 'running') await this.pm.restart(id);
  }

  getEnv(id) {
    return { ...(this.mustGet(id).env || {}) };
  }

  async renameDb(id, newName) {
    const app = this.mustGet(id);
    this.assertIdle(id);
    if (!app.dbInfo) throw new HttpError(400, 'App has no database');
    if (!newName || typeof newName !== 'string') throw new HttpError(400, 'New name required');
    const wasRunning = app.desired === 'running';
    if (app.dbInfo.type === 'sqlite') {
      const fname = `${newName.replace(/\.db$/i, '').replace(/[^a-z0-9_-]/gi, '')}.db`;
      if (fname === '.db') throw new HttpError(400, 'Invalid database name');
      const next = path.join(path.dirname(app.dbInfo.path), fname);
      if (next === app.dbInfo.path) return app.dbInfo;
      if (await fs.pathExists(next)) throw new HttpError(409, 'A database with that name already exists');
      await this.pm.stop(id);
      if (await fs.pathExists(app.dbInfo.path)) await fs.move(app.dbInfo.path, next);
      this.registry.update(id, { dbInfo: { ...app.dbInfo, name: fname, path: next } });
    } else {
      const pgName = newName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (!isValidPgIdent(pgName)) throw new HttpError(400, 'Invalid database name');
      if (pgName === app.dbInfo.name) return database.publicDbInfo(app.dbInfo);
      await this.pm.stop(id);
      try {
        this.registry.update(id, { dbInfo: await database.renamePostgres(app.dbInfo, pgName) });
      } finally {
        if (wasRunning) await this.pm.start(id).catch(() => {});
      }
      return database.publicDbInfo(this.registry.get(id).dbInfo);
    }
    if (wasRunning) await this.pm.start(id);
    return database.publicDbInfo(this.registry.get(id).dbInfo);
  }

  // ---------- backups ----------

  async setSchedule(id, schedule) {
    this.mustGet(id);
    if (!SCHEDULES.includes(schedule)) throw new HttpError(400, 'Schedule must be off, daily or weekly');
    this.registry.update(id, { backupSchedule: schedule });
    this.backups.schedule(id, schedule);
  }

  async backup(id) {
    this.mustGet(id);
    this.assertIdle(id);
    return this.backups.create(id);
  }

  async restore(id, filename) {
    const app = this.mustGet(id);
    this.assertIdle(id);
    this.backups.file(id, filename);
    const task = this.runTask(id, 'restoring', async () => {
      const tmp = await this.backups.unpack(id, filename);
      const dir = this.appDir(id);
      const old = path.join(this.cfg.appsDir, `.old-${id}`);
      try {
        await this.pm.stop(id);
        this.pm.note(id, `Restoring backup ${filename}`);
        if (await fs.pathExists(path.join(tmp, 'files'))) {
          await fs.remove(old);
          if (await fs.pathExists(dir)) await fs.move(dir, old);
          await fs.move(path.join(tmp, 'files'), dir);
        }
        if (await fs.pathExists(path.join(tmp, 'volume'))) {
          await fs.remove(this.volumeDir(id));
          await fs.move(path.join(tmp, 'volume'), this.volumeDir(id));
        }
        const dump = path.join(tmp, 'db.sql');
        if (app.dbInfo && app.dbInfo.type === 'postgres' && (await fs.pathExists(dump))) {
          await database.restorePostgres(app.dbInfo, dump);
        }
        await this.chownForApp(dir, this.volumeDir(id));
        await buildApp(this.cfg, dir, app, { runAs: this.runAs, onOutput: this.logWriter(id) });
        await fs.remove(old);
      } catch (err) {
        if (await fs.pathExists(old)) {
          await fs.remove(dir);
          await fs.move(old, dir);
        }
        throw err;
      } finally {
        await fs.remove(tmp);
      }
      if (app.desired === 'running') await this.pm.start(id);
    });
    return task;
  }
}

module.exports = { AppService, RESERVED_ENV };
