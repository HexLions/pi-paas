'use strict';
// The app registry is a single JSON file. It is kept in memory and every
// change is written atomically (temp file + rename), so a power cut on the
// Pi can never leave a half-written registry behind.
const fs = require('fs-extra');

class Registry {
  constructor(file) {
    this.file = file;
    this.data = { version: 2, apps: {} };
  }

  load() {
    if (fs.existsSync(this.file)) {
      const raw = fs.readJsonSync(this.file);
      this.data = migrate(raw);
    }
    this.saveSync();
    return this;
  }

  get(id) {
    return Object.prototype.hasOwnProperty.call(this.data.apps, id) ? this.data.apps[id] : undefined;
  }

  all() {
    return Object.entries(this.data.apps).map(([id, app]) => ({ id, ...app }));
  }

  set(id, app) {
    this.data.apps[id] = app;
    this.saveSync();
  }

  update(id, patch) {
    const app = this.get(id);
    if (!app) return undefined;
    Object.assign(app, patch, { updatedAt: new Date().toISOString() });
    this.saveSync();
    return app;
  }

  remove(id) {
    delete this.data.apps[id];
    this.saveSync();
  }

  usedPorts(exceptId) {
    return Object.entries(this.data.apps).filter(([id]) => id !== exceptId).map(([, a]) => a.port);
  }

  saveSync() {
    const tmp = `${this.file}.tmp`;
    // Holds database passwords: readable by the panel user only.
    fs.writeJsonSync(tmp, this.data, { spaces: 2, mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
}

/** Bring registries written by v1.0 up to the current shape. */
function migrate(raw) {
  const data = { version: 2, apps: {} };
  const apps = (raw && raw.apps) || {};
  for (const [id, a] of Object.entries(apps)) {
    const app = { ...a };
    if (!app.desired) app.desired = app.status === 'running' ? 'running' : 'stopped';
    delete app.status;
    delete app.pid;
    if (!app.env || typeof app.env !== 'object') app.env = {};
    if (!app.backupSchedule) app.backupSchedule = 'off';
    if (!app.dbType) app.dbType = 'none';
    if (app.dbInfo && app.dbInfo.type === 'sqlite' && !app.dbInfo.name && app.dbInfo.path) {
      app.dbInfo.name = require('path').basename(app.dbInfo.path);
    }
    data.apps[id] = app;
  }
  return data;
}

module.exports = { Registry, migrate };
