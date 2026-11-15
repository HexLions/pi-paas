'use strict';
// Backups are .tar.gz files named <unix-ms>.tar.gz under backups/<app-id>/:
//   files/      app code (without node_modules, venv, caches)
//   volume/     the app's persistent data folder (SQLite lives here)
//   db.sql      PostgreSQL dump, when the app has one
//   meta.json   what was backed up and when
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const os = require('os');
const { run, HttpError, commandExists } = require('./util');
const database = require('./database');
const crypt = require('./crypt');

const SKIP = new Set(['node_modules', 'venv', '.venv', '__pycache__', '.git', '.cache', '.npm']);
const NAME_RE = /^\d{10,16}\.tar\.gz$/;
const REMOTE_RE = /^\d{10,16}\.tar\.gz(\.enc)?$/;
const CRON = { daily: '0 3 * * *', weekly: '0 3 * * 0' };

class Backups {
  constructor(cfg, registry, log = console) {
    this.cfg = cfg;
    this.registry = registry;
    this.log = log;
    this.jobs = new Map();
    this.settings = null; // set by server.js
    this.notifier = null;
    this.background = new Set();
  }

  statusFile(id, name) {
    return path.join(this.dir(id), `${name.replace(/\.tar\.gz$/, '')}.json`);
  }

  async readStatus(id, name) {
    try { return await fs.readJson(this.statusFile(id, name)); } catch { return {}; }
  }

  async writeStatus(id, name, patch) {
    const cur = await this.readStatus(id, name);
    await fs.writeJson(this.statusFile(id, name), { ...cur, ...patch });
  }

  /** Wait for verification and offsite copies (tests, shutdown). */
  async settle() {
    while (this.background.size) await Promise.all([...this.background]);
  }

  dir(id) {
    return path.join(this.cfg.backupDir, id);
  }

  file(id, name) {
    if (!NAME_RE.test(name || '')) throw new HttpError(400, 'Invalid backup name');
    return path.join(this.dir(id), name);
  }

  async list(id) {
    const dir = this.dir(id);
    if (!(await fs.pathExists(dir))) return [];
    const names = (await fs.readdir(dir)).filter((f) => NAME_RE.test(f));
    const out = await Promise.all(names.map(async (f) => {
      const st = await fs.stat(path.join(dir, f));
      const ts = Number.parseInt(f, 10);
      const status = await this.readStatus(id, f);
      return { filename: f, timestamp: String(ts), date: new Date(ts).toISOString(), size: st.size, verified: status.verified || null, offsite: status.offsite || null };
    }));
    return out.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  }

  async create(id) {
    const app = this.registry.get(id);
    if (!app) throw new HttpError(404, 'App not found');
    const ts = Date.now();
    const tmp = path.join(this.cfg.uploadDir, `backup-${id}-${ts}`);
    const bkDir = this.dir(id);
    await fs.ensureDir(bkDir);
    try {
      const appDir = path.join(this.cfg.appsDir, id);
      if (await fs.pathExists(appDir)) {
        await fs.copy(appDir, path.join(tmp, 'files'), { filter: (src) => !SKIP.has(path.basename(src)), dereference: false });
      }
      const vol = path.join(this.cfg.volumesDir, id);
      if (await fs.pathExists(vol)) await fs.copy(vol, path.join(tmp, 'volume'));
      if (app.dbInfo && app.dbInfo.type === 'postgres') {
        await database.dumpPostgres(app.dbInfo, path.join(tmp, 'db.sql'));
      }
      await fs.writeJson(path.join(tmp, 'meta.json'), {
        id, name: app.name, type: app.type, dbType: app.dbType, version: app.version, backedUpAt: new Date(ts).toISOString(), pipaas: this.cfg.version,
      }, { spaces: 2 });
      const out = path.join(bkDir, `${ts}.tar.gz`);
      await run('tar', ['-czf', out, '-C', tmp, '.'], { timeout: 30 * 60000 });
      await this.rotate(id);
      const st = await fs.stat(out);
      const name = `${ts}.tar.gz`;
      // Checking and copying off the Pi can take a while: do it after answering.
      const p = this.afterCreate(id, name).catch((err) => this.log.error(`[backup] ${id}: ${err.message}`)).finally(() => this.background.delete(p));
      this.background.add(p);
      return { filename: name, timestamp: String(ts), date: new Date(ts).toISOString(), size: st.size };
    } finally {
      await fs.remove(tmp);
    }
  }

  async rotate(id) {
    const all = await this.list(id);
    for (const b of all.slice(this.cfg.maxBackups)) {
      await fs.remove(path.join(this.dir(id), b.filename));
      await fs.remove(this.statusFile(id, b.filename));
    }
  }

  async afterCreate(id, name) {
    const conf = this.settings ? this.settings.get().backups : { verify: true, target: 'none' };
    if (conf.verify) {
      const v = await this.verify(id, name);
      if (!v.ok) throw new Error(`backup ${name} failed verification: ${v.error}`);
    }
    if (conf.target !== 'none') {
      try {
        await this.offsite(id, name);
      } catch (err) {
        if (this.notifier) this.notifier.notify('backupFailed', { app: id, level: 'error', title: `Offsite copy of ${id} failed`, message: err.message.slice(0, 500) });
        throw err;
      }
    }
  }

  /** Read the whole archive and check it is a Pi-PaaS backup that can be restored. */
  async verify(id, name) {
    const file = this.file(id, name);
    let result;
    try {
      const { stdout } = await run('tar', ['-tzf', file], { timeout: 30 * 60000 });
      const entries = stdout.split('\n').map((l) => l.replace(/^\.\//, ''));
      if (!entries.includes('meta.json')) throw new Error('meta.json is missing');
      if (!entries.some((e) => e.startsWith('files/'))) throw new Error('the app files are missing');
      const app = this.registry.get(id);
      if (app && app.dbInfo && app.dbInfo.type === 'postgres' && !entries.includes('db.sql')) throw new Error('the database dump is missing');
      result = { ok: true, at: new Date().toISOString(), entries: entries.filter(Boolean).length };
    } catch (err) {
      result = { ok: false, at: new Date().toISOString(), error: err.message.slice(0, 300) };
    }
    await this.writeStatus(id, name, { verified: result });
    return result;
  }

  // ---------- offsite copies ----------

  remoteBase(id) {
    const conf = this.settings.get().backups;
    const host = os.hostname();
    if (conf.target === 'folder') return path.join(conf.folder, host, id);
    if (conf.target === 'rclone') return `${conf.rclone.replace(/\/+$/, '')}/${host}/${id}`;
    throw new HttpError(400, 'No offsite backup target is set');
  }

  async offsite(id, name) {
    const conf = this.settings.get().backups;
    const src = this.file(id, name);
    let upload = src;
    let remoteName = name;
    const tmp = path.join(this.cfg.uploadDir, `offsite-${id}-${Date.now()}`);
    try {
      if (conf.passphrase) {
        upload = `${tmp}.enc`;
        remoteName = `${name}.enc`;
        await crypt.encryptFile(src, upload, conf.passphrase);
      }
      const st = await fs.stat(upload);
      const base = this.remoteBase(id);
      if (conf.target === 'folder') {
        if (!(await fs.pathExists(conf.folder))) throw new Error(`${conf.folder} does not exist (is the NAS mounted?)`);
        await fs.ensureDir(base);
        await fs.copy(upload, path.join(base, remoteName));
        const copied = await fs.stat(path.join(base, remoteName));
        if (copied.size !== st.size) throw new Error('the copy has a different size');
      } else {
        if (!commandExists('rclone')) throw new Error('rclone is not installed');
        await run('rclone', ['copyto', '--retries', '3', upload, `${base}/${remoteName}`], { timeout: 60 * 60000 });
        const list = JSON.parse((await run('rclone', ['lsjson', '--files-only', `${base}/${remoteName}`], { timeout: 120000 })).stdout || '[]');
        if (!list[0] || list[0].Size !== st.size) throw new Error('the remote copy has a different size');
      }
      await this.writeStatus(id, name, { offsite: { ok: true, at: new Date().toISOString(), target: conf.target, name: remoteName, encrypted: !!conf.passphrase } });
      await this.rotateRemote(id);
    } catch (err) {
      await this.writeStatus(id, name, { offsite: { ok: false, at: new Date().toISOString(), target: conf.target, error: err.message.slice(0, 300) } });
      throw err;
    } finally {
      await fs.remove(`${tmp}.enc`);
    }
  }

  async remoteList(id) {
    const conf = this.settings.get().backups;
    if (conf.target === 'none') return [];
    const base = this.remoteBase(id);
    let items = [];
    if (conf.target === 'folder') {
      if (!(await fs.pathExists(base))) return [];
      items = await Promise.all((await fs.readdir(base)).filter((f) => REMOTE_RE.test(f)).map(async (f) => ({ name: f, size: (await fs.stat(path.join(base, f))).size })));
    } else {
      const out = (await run('rclone', ['lsjson', '--files-only', base], { timeout: 120000 }).catch(() => ({ stdout: '[]' }))).stdout;
      items = JSON.parse(out || '[]').filter((x) => REMOTE_RE.test(x.Name)).map((x) => ({ name: x.Name, size: x.Size }));
    }
    return items.map((x) => ({ ...x, date: new Date(Number.parseInt(x.name, 10)).toISOString(), encrypted: x.name.endsWith('.enc') }))
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  async rotateRemote(id) {
    const conf = this.settings.get().backups;
    const extra = (await this.remoteList(id)).slice(this.cfg.maxBackups);
    const base = this.remoteBase(id);
    for (const r of extra) {
      if (conf.target === 'folder') await fs.remove(path.join(base, r.name));
      else await run('rclone', ['deletefile', `${base}/${r.name}`], { timeout: 120000 }).catch(() => {});
    }
  }

  /** Bring a remote backup back into the local list (decrypted), ready to restore. */
  async fetchRemote(id, remoteName) {
    if (!REMOTE_RE.test(remoteName || '')) throw new HttpError(400, 'Invalid backup name');
    const conf = this.settings.get().backups;
    const base = this.remoteBase(id);
    const localName = remoteName.replace(/\.enc$/, '');
    const dest = this.file(id, localName);
    await fs.ensureDir(this.dir(id));
    const tmp = path.join(this.cfg.uploadDir, `fetch-${id}-${Date.now()}`);
    try {
      if (conf.target === 'folder') await fs.copy(path.join(base, remoteName), tmp);
      else await run('rclone', ['copyto', `${base}/${remoteName}`, tmp], { timeout: 60 * 60000 });
      if (remoteName.endsWith('.enc')) {
        if (!conf.passphrase) throw new HttpError(400, 'This backup is encrypted: set the passphrase in the backup settings first');
        await crypt.decryptFile(tmp, dest, conf.passphrase);
      } else {
        await fs.move(tmp, dest, { overwrite: true });
      }
    } finally {
      await fs.remove(tmp);
    }
    const v = await this.verify(id, localName);
    if (!v.ok) throw new HttpError(400, `The downloaded backup is not usable: ${v.error}`);
    return localName;
  }

  /** Unpack a backup into a temp folder; the caller moves things into place. */
  async unpack(id, name) {
    const file = this.file(id, name);
    if (!(await fs.pathExists(file))) throw new HttpError(404, 'Backup not found');
    const tmp = path.join(this.cfg.uploadDir, `restore-${id}-${Date.now()}`);
    await fs.ensureDir(tmp);
    await run('tar', ['-xzf', file, '-C', tmp, '--no-same-owner'], { timeout: 30 * 60000 });
    return tmp;
  }

  async remove(id, name) {
    const file = this.file(id, name);
    if (!(await fs.pathExists(file))) throw new HttpError(404, 'Backup not found');
    await fs.remove(file);
    await fs.remove(this.statusFile(id, name));
  }

  async removeAll(id) {
    this.cancel(id);
    await fs.remove(this.dir(id));
  }

  schedule(id, kind) {
    this.cancel(id);
    if (!CRON[kind]) return;
    const task = cron.schedule(CRON[kind], async () => {
      if (!this.registry.get(id)) return this.cancel(id);
      try {
        const b = await this.create(id);
        this.log.log(`[backup] ${id}: ${b.filename}`);
      } catch (err) {
        this.log.error(`[backup] ${id} failed: ${err.message}`);
        if (this.notifier) this.notifier.notify('backupFailed', { app: id, level: 'error', title: `Backup of ${id} failed`, message: err.message.slice(0, 500) });
      }
    });
    this.jobs.set(id, task);
  }

  cancel(id) {
    const t = this.jobs.get(id);
    if (t) { t.stop(); this.jobs.delete(id); }
  }

  restoreSchedules() {
    for (const app of this.registry.all()) if (app.backupSchedule && app.backupSchedule !== 'off') this.schedule(app.id, app.backupSchedule);
  }

  stopAll() {
    for (const id of [...this.jobs.keys()]) this.cancel(id);
  }
}

module.exports = { Backups, NAME_RE, REMOTE_RE };
