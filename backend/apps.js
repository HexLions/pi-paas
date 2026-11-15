'use strict';
// Everything that changes an app goes through AppService. Slow work (unpack,
// npm install, build, restore) runs as a background job; the app shows a
// "task" while it runs and the build output lands in the app log.
const fs = require('fs-extra');
const path = require('path');
const sources = require('./sources');
const { buildApp } = require('./build');
const { isPortFree } = require('./processes');
const database = require('./database');
const runtimes = require('./runtimes');
const {
  APP_TYPES, DB_TYPES, SCHEDULES, HttpError, slugify, isValidId, isValidPgIdent, isValidEnvKey, run, assertNoEscapingLinks, isPlainFile,
} = require('./util');

const RESERVED_ENV = new Set(['PORT', 'APP_PORT', 'PIPAAS_APP_ID', 'DATA_DIR', 'DATABASE_URL', 'SQLITE_PATH', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT']);

class AppService {
  constructor(cfg, registry, pm, backups, { log = console, runAs = null, notifier = null } = {}) {
    this.cfg = cfg;
    this.registry = registry;
    this.pm = pm;
    this.backups = backups;
    this.log = log;
    this.runAs = runAs;
    this.notifier = notifier;
    this.monitor = null; // set by server.js
    this.proxy = null;
    this.jobs = null;
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
      limits: app.limits || {},
      health: { enabled: true, path: '/', restart: false, ...(app.health || {}) },
      source: app.source ? { type: app.source.type, url: app.source.url ? redactUrl(app.source.url) : undefined, branch: app.source.branch, template: app.source.template, commit: app.source.commit } : { type: 'upload' },
      domains: app.domains || [],
      links: this.links(id, app),
      jobs: (app.jobs || []).length,
      ...(this.monitor ? { metrics: this.monitor.current(id) } : {}),
    };
  }

  /** Friendly addresses through the built-in proxy (<app>.local, domains). */
  links(id, app) {
    const px = this.proxy;
    if (!px || !px.ports.http) return [];
    return px.namesFor(id, app).map((n) => {
      const secure = px.ports.https && px.certs.has(n);
      const port = secure ? px.ports.https : px.ports.http;
      const def = secure ? 443 : 80;
      return `${secure ? 'https' : 'http'}://${n}${port === def ? '' : `:${port}`}/`;
    });
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
        const app = this.registry.get(id);
        if (app) this.registry.update(id, { lastError: { task: kind, message: err.message, at: new Date().toISOString() } });
        if (this.notifier) {
          this.notifier.notify('deployFailed', { app: id, level: 'error', title: `${kind.replace(/ing$/, '')} of ${app ? app.name : id} failed`, message: err.message.slice(0, 500) });
        }
      } finally {
        this.tasks.delete(id);
        this.running.delete(p);
        // A push arrived while this job ran: deploy the newest code now.
        if (this.pendingPull && this.pendingPull.delete(id) && this.registry.get(id)) {
          try { this.pull(id, null, 'webhook (queued)'); } catch (err) { this.log.error(`[${id}] queued pull failed: ${err.message}`); }
        }
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
      // -h: change links themselves, never what they point at.
      if (await fs.pathExists(d)) await run('chown', ['-R', '-h', `${this.runAs.uid}:${this.runAs.gid}`, d]);
    }
  }

  // ---------- deploy ----------

  async deploy(input, host) {
    let { name, type, dbType = 'none', dbName, port } = input;
    const { file } = input;
    let handedOff = false;
    try {
      const source = sources.parseSource(input);
      if (source.type === 'template') {
        const tpl = sources.listTemplates().find((t) => t.id === source.template);
        type = type || tpl.type;
        if (!input.dbType && tpl.db) dbType = tpl.db;
        name = name || tpl.name;
      }
      name = String(name || '').trim();
      if (!name) throw new HttpError(400, 'Name is required');
      if (name.length > 60) throw new HttpError(400, 'Name is too long (max 60 characters)');
      if (!APP_TYPES.includes(type)) throw new HttpError(400, `Type must be one of: ${APP_TYPES.join(', ')}`);
      if (!DB_TYPES.includes(dbType)) throw new HttpError(400, `Database must be one of: ${DB_TYPES.join(', ')}`);
      assertRuntime(this.cfg.containerMode ? 'docker' : type);
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
        desired: 'stopped', version: 1, createdAt: now, updatedAt: now, lastError: null, source,
      });
      await fs.remove(this.pm.logFile(id));
      this.pm.note(id, `Deploying ${name} (${type})`);

      handedOff = true;
      this.runTask(id, 'deploying', async () => {
        const dir = this.appDir(id);
        const vol = this.volumeDir(id);
        const got = await sources.materialize(source, dir, { file, onOutput: this.logWriter(id), runAs: this.runAs, homeDir: this.cfg.homeDir });
        assertNoEscapingLinks(dir);
        if (got.commit) {
          this.pm.note(id, `Checked out ${got.commit.slice(0, 10)}${got.message ? `: ${got.message}` : ''}`);
          this.registry.update(id, { source: { ...source, commit: got.commit } });
        }
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
        await buildApp(this.cfg, dir, this.registry.get(id), { runAs: this.runAs, onOutput: this.logWriter(id), id });
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

    this.replaceCode(id, 'updating', { port: newPort, source: { type: 'upload' }, file });
    return this.view(id, host);
  }

  /** Fetch the git source again and redeploy (button, CLI or webhook). */
  pull(id, host, reason = 'manual') {
    const app = this.mustGet(id);
    if (!app.source || app.source.type !== 'git') throw new HttpError(400, 'This app was not deployed from git');
    this.assertIdle(id);
    this.pm.note(id, `Pulling ${app.source.branch} from ${redactUrl(app.source.url)} (${reason})`);
    this.replaceCode(id, 'updating', { source: app.source });
    return this.view(id, host);
  }

  /**
   * Swap the app's code for a new version as a background job: stop, move
   * the current code aside, get the new code, build, start. If anything fails
   * the previous code is put back. The previous code is kept as a release.
   */
  replaceCode(id, kind, { port = null, source, file = null, release = null }) {
    const app = this.registry.get(id);
    return this.runTask(id, kind, async () => {
      const dir = this.appDir(id);
      const old = path.join(this.cfg.appsDir, `.old-${id}`);
      await this.pm.stop(id);
      if (port) this.registry.update(id, { port });
      await fs.remove(old);
      if (await fs.pathExists(dir)) await fs.move(dir, old);
      let got = {};
      try {
        if (release) {
          await fs.move(release.dir, dir);
        } else {
          got = await sources.materialize(source, dir, { file, onOutput: this.logWriter(id), runAs: this.runAs, homeDir: this.cfg.homeDir });
          assertNoEscapingLinks(dir);
          if (got.commit) this.pm.note(id, `Checked out ${got.commit.slice(0, 10)}${got.message ? `: ${got.message}` : ''}`);
        }
        // v1.0 kept SQLite inside the app folder: carry it over.
        const db = app.dbInfo;
        if (db && db.type === 'sqlite' && db.path && db.path.startsWith(dir + path.sep)) {
          const prev = path.join(old, path.relative(dir, db.path));
          // Never write through a link the new code may carry at that path.
          if (isPlainFile(prev)) {
            await fs.remove(db.path);
            await fs.copy(prev, db.path);
          }
        }
        await this.chownForApp(dir);
        // A release keeps its dependencies; only a Python venv must be rebuilt (it records absolute paths).
        if (!release || (app.type === 'python' && (await fs.pathExists(path.join(dir, 'requirements.txt'))))) {
          if (release) await fs.remove(path.join(dir, 'venv'));
          await buildApp(this.cfg, dir, this.registry.get(id), { runAs: this.runAs, onOutput: this.logWriter(id), id });
        }
      } catch (err) {
        this.pm.note(id, `${kind === 'rollingBack' ? 'Rollback' : 'Update'} failed, putting the previous version back`);
        if (release && (await fs.pathExists(dir))) await fs.move(dir, release.dir).catch(() => {});
        await fs.remove(dir);
        if (await fs.pathExists(old)) await fs.move(old, dir);
        if (app.desired === 'running') await this.pm.start(id).catch(() => {});
        throw err;
      }
      const current = this.registry.get(id);
      if (release) await fs.remove(path.join(this.releasesDir(id), `${release.version}.json`));
      if (await fs.pathExists(old)) await this.keepRelease(id, old, current);
      const patch = { desired: 'running' };
      if (release) {
        patch.version = release.version;
        patch.source = release.source || current.source;
      } else {
        patch.version = this.nextVersion(id, current);
        patch.source = { ...source, ...(got.commit ? { commit: got.commit } : {}) };
      }
      this.registry.update(id, patch);
      await this.pm.start(id);
    });
  }

  nextVersion(id, app) {
    const kept = this.releaseList(id).map((r) => r.version);
    return Math.max(app.version || 1, ...kept) + 1;
  }

  // ---------- releases (previous versions) ----------

  releasesDir(id) { return path.join(this.cfg.releasesDir, id); }

  async keepRelease(id, dir, app) {
    const dest = path.join(this.releasesDir(id), String(app.version || 1));
    await fs.remove(dest);
    await fs.ensureDir(path.dirname(dest));
    await fs.move(dir, dest);
    const { token, hookSecret, ...src } = app.source || { type: 'upload' };
    await fs.writeJson(path.join(this.releasesDir(id), `${app.version || 1}.json`), {
      version: app.version || 1, replacedAt: new Date().toISOString(), deployedAt: app.updatedAt, source: src,
    });
    const all = this.releaseList(id);
    for (const r of all.slice(this.cfg.keepReleases)) {
      await fs.remove(path.join(this.releasesDir(id), String(r.version)));
      await fs.remove(path.join(this.releasesDir(id), `${r.version}.json`));
    }
  }

  releaseList(id) {
    const dir = this.releasesDir(id);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => {
      try { return fs.readJsonSync(path.join(dir, f)); } catch { return null; }
    }).filter((r) => r && fs.existsSync(path.join(dir, String(r.version)))).sort((a, b) => b.version - a.version);
  }

  listReleases(id) {
    this.mustGet(id);
    return this.releaseList(id);
  }

  async rollback(id, version, host) {
    const app = this.mustGet(id);
    this.assertIdle(id);
    const v = Number(version);
    const meta = this.releaseList(id).find((r) => r.version === v);
    if (!meta) throw new HttpError(404, 'That version is no longer kept');
    const dir = path.join(this.releasesDir(id), String(v));
    this.pm.note(id, `Rolling back from version ${app.version} to ${v}`);
    const source = meta.source && meta.source.type === 'git' ? { ...app.source, commit: meta.source.commit } : meta.source;
    this.replaceCode(id, 'rollingBack', { release: { dir, version: v, source } });
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
    if (this.jobs) this.jobs.cancelApp(id);
    if (app.dbInfo && app.dbInfo.type === 'postgres') await database.dropPostgres(app.dbInfo);
    await this.backups.removeAll(id);
    await fs.remove(this.appDir(id));
    await fs.remove(this.volumeDir(id));
    await fs.remove(this.releasesDir(id));
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

  async setSettings(id, { env, startCommand, limits, health, domains }) {
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
    if (limits !== undefined) patch.limits = runtimes.validateLimits(limits);
    if (domains !== undefined) patch.domains = this.validateDomains(id, domains);
    if (health !== undefined) {
      if (!health || typeof health !== 'object') throw new HttpError(400, 'Invalid health check');
      const p = health.path === undefined ? '/' : String(health.path);
      if (!/^\/[\x21-\x7e]{0,200}$/.test(p)) throw new HttpError(400, 'The health check path must start with / and contain no spaces');
      patch.health = { enabled: health.enabled !== false, path: p, restart: !!health.restart };
    }
    // Only what the process sees needs a restart; domains and health checks do not.
    const before = JSON.stringify([app.env, app.startCommand, app.limits]);
    this.registry.update(id, patch);
    const after = this.registry.get(id);
    const changed = JSON.stringify([after.env, after.startCommand, after.limits]) !== before;
    if (changed && app.desired === 'running') await this.pm.restart(id);
  }

  validateDomains(id, domains) {
    const { validDomain } = require('./proxy');
    if (!Array.isArray(domains) || domains.length > 10) throw new HttpError(400, 'Give at most 10 domains');
    const clean = [...new Set(domains.map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
    for (const d of clean) {
      if (!validDomain(d)) throw new HttpError(400, `"${d}" is not a valid domain name`);
      const other = this.registry.all().find((a) => a.id !== id && (a.domains || []).includes(d));
      if (other) throw new HttpError(409, `${d} is already used by "${other.name}"`);
    }
    return clean;
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
        for (const part of ['files', 'volume']) {
          if (await fs.pathExists(path.join(tmp, part))) assertNoEscapingLinks(path.join(tmp, part), 'The backup');
        }
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
        await buildApp(this.cfg, dir, app, { runAs: this.runAs, onOutput: this.logWriter(id), id });
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

/** Hide credentials embedded in a git URL (https://user:token@host/...). */
function redactUrl(url) {
  return String(url).replace(/^(https?:\/\/)[^/@]+@/, '$1***@');
}

function assertRuntime(type) {
  const need = runtimes.RUNTIMES[type] && runtimes.RUNTIMES[type].needs;
  if (need && !runtimes.availableRuntimes()[type]) throw new HttpError(400, `${need} is not installed on this machine, so ${type} apps cannot run here`);
}

module.exports = { AppService, RESERVED_ENV, redactUrl, assertRuntime };
