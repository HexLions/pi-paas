'use strict';
// Backups are .tar.gz files named <unix-ms>.tar.gz under backups/<app-id>/:
//   files/      app code (without node_modules, venv, caches)
//   volume/     the app's persistent data folder (SQLite lives here)
//   db.sql      PostgreSQL dump, when the app has one
//   meta.json   what was backed up and when
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const { run, HttpError } = require('./util');
const database = require('./database');

const SKIP = new Set(['node_modules', 'venv', '.venv', '__pycache__', '.git', '.cache', '.npm']);
const NAME_RE = /^\d{10,16}\.tar\.gz$/;
const CRON = { daily: '0 3 * * *', weekly: '0 3 * * 0' };

class Backups {
  constructor(cfg, registry, log = console) {
    this.cfg = cfg;
    this.registry = registry;
    this.log = log;
    this.jobs = new Map();
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
      return { filename: f, timestamp: String(ts), date: new Date(ts).toISOString(), size: st.size };
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
      return { filename: `${ts}.tar.gz`, timestamp: String(ts), date: new Date(ts).toISOString(), size: st.size };
    } finally {
      await fs.remove(tmp);
    }
  }

  async rotate(id) {
    const all = await this.list(id);
    for (const b of all.slice(this.cfg.maxBackups)) await fs.remove(path.join(this.dir(id), b.filename));
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

module.exports = { Backups, NAME_RE };
