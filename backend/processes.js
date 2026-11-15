'use strict';
// Runs each app as a child process in its own process group, so stopping an
// app also stops whatever it spawned (npm start -> node, gunicorn workers...).
// Crashed apps are restarted with exponential backoff; an app that keeps
// crashing is parked in the "crashed" state instead of looping forever.
const fs = require('fs-extra');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const CRASH_WINDOW_MS = 10 * 60000;
const MAX_CRASHES = 5;
const STOP_GRACE_MS = 8000;

const runtimes = require('./runtimes');
const { run } = require('./util');

const { STATIC_SERVER } = runtimes;

/**
 * Where the static file server script lives for apps. With a separate app
 * user the code folder (often under /root) is not readable, so a copy goes
 * into the data folder.
 */
function prepareStaticServer(cfg, runAs) {
  if (!runAs) return STATIC_SERVER;
  const dir = path.join(cfg.dataDir, 'runtime');
  const dest = path.join(dir, 'static-server.js');
  fs.ensureDirSync(dir);
  fs.chmodSync(dir, 0o755);
  fs.copyFileSync(STATIC_SERVER, dest);
  fs.chmodSync(dest, 0o644);
  return dest;
}

/** Try to bind the port: the only reliable way to know it is free. */
function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

function baseEnv(cfg, app) {
  const env = {
    PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: cfg.homeDir,
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: process.env.TZ || '',
    npm_config_cache: path.join(cfg.homeDir, '.npm'),
    npm_config_update_notifier: 'false',
    PYTHONUNBUFFERED: '1',
  };
  if (!env.TZ) delete env.TZ;
  return { ...env, ...(app && app.env ? app.env : {}) };
}

function appEnv(cfg, id, app) {
  const env = baseEnv(cfg, app);
  env.PORT = String(app.port);
  env.APP_PORT = String(app.port);
  env.HOST = '0.0.0.0';
  env.NODE_ENV = env.NODE_ENV || 'production';
  env.PIPAAS_APP_ID = id;
  env.DATA_DIR = path.join(cfg.volumesDir, id);
  const db = app.dbInfo;
  if (db && db.type === 'sqlite') {
    env.DATABASE_URL = `sqlite:${db.path}`;
    env.SQLITE_PATH = db.path;
  } else if (db && db.type === 'postgres') {
    env.DATABASE_URL = db.url;
    env.PGHOST = 'localhost';
    env.PGPORT = '5432';
    env.PGDATABASE = db.name;
    if (db.user) { env.PGUSER = db.user; env.PGPASSWORD = db.password || ''; }
  }
  return env;
}

class ProcessManager {
  constructor(cfg, registry, { log = console, runAs = null, notifier = null } = {}) {
    this.cfg = cfg;
    this.registry = registry;
    this.log = log;
    this.notifier = notifier;
    this.runAs = runAs; // { uid, gid } or null
    this.procs = new Map();
    this.staticServer = prepareStaticServer(cfg, runAs);
  }

  logFile(id) {
    return path.join(this.cfg.logDir, `${id}.log`);
  }

  appendLog(id, chunk) {
    try { fs.appendFileSync(this.logFile(id), chunk); } catch { /* log dir missing is not fatal */ }
  }

  /** Append a panel message to the app log. */
  note(id, msg) {
    try {
      fs.appendFileSync(this.logFile(id), `[pi-paas ${new Date().toISOString()}] ${msg}\n`);
    } catch { /* log dir missing is not fatal */ }
  }

  rotateLog(id) {
    const file = this.logFile(id);
    try {
      if (fs.statSync(file).size > this.cfg.maxLogBytes) fs.renameSync(file, `${file}.1`);
    } catch { /* no log yet */ }
  }

  state(id) {
    const p = this.procs.get(id);
    if (p && p.child) return p.stopping ? 'stopping' : 'running';
    if (p && p.timer) return 'restarting';
    if (p && p.crashed) return 'crashed';
    return 'stopped';
  }

  info(id) {
    const p = this.procs.get(id);
    return {
      status: this.state(id),
      pid: p && p.child ? p.child.pid : null,
      startedAt: p && p.child ? p.startedAt : null,
      lastExit: p ? p.lastExit || null : null,
    };
  }

  async start(id) {
    const app = this.registry.get(id);
    if (!app) throw new Error('App not found');
    const cur = this.procs.get(id);
    if (cur && cur.child) return;
    if (cur && cur.timer) clearTimeout(cur.timer);
    if (!(await isPortFree(app.port))) {
      const err = new Error(`Port ${app.port} is already in use by another process`);
      err.status = 409;
      throw err;
    }
    const appDir = path.join(this.cfg.appsDir, id);
    let env = appEnv(this.cfg, id, app);
    if (app.type === 'docker') {
      env = runtimes.dockerEnv(env, path.join(this.cfg.volumesDir, id));
      await run('docker', ['rm', '-f', runtimes.dockerName(id)]).catch(() => {});
    }
    const command = runtimes.resolveCommand(appDir, app, { staticServer: this.staticServer, id, cfg: this.cfg, env, runAs: this.runAs });
    const { cmd, args, env: finalEnv, setsUser } = runtimes.applyLimits(command, app, { runAs: this.runAs, env });
    if (app.type === 'docker') finalEnv.PATH = process.env.PATH;
    await fs.ensureDir(this.cfg.logDir);
    this.rotateLog(id);
    const lim = app.limits || {};
    const limits = [lim.memoryMb && `${lim.memoryMb} MB`, lim.cpuPercent && `${lim.cpuPercent}% CPU`, lim.nice && `nice ${lim.nice}`].filter(Boolean).join(', ');
    this.note(id, `Starting: ${command.label} on port ${app.port}${limits ? ` (limits: ${limits})` : ''}`);
    const out = fs.openSync(this.logFile(id), 'a');
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: appDir,
        env: finalEnv,
        stdio: ['ignore', out, out],
        detached: true,
        ...(setsUser ? {} : this.runAs || {}),
      });
    } finally {
      fs.closeSync(out);
    }
    const rec = { ...(cur || {}), child, startedAt: new Date().toISOString(), stopping: false, crashed: false, timer: null };
    rec.crashes = (cur && cur.crashes) || [];
    this.procs.set(id, rec);
    child.on('error', (err) => {
      this.note(id, `Failed to start: ${err.message}`);
      this.onExit(id, child, null, null);
    });
    child.on('exit', (code, signal) => this.onExit(id, child, code, signal));
  }

  onExit(id, child, code, signal) {
    const rec = this.procs.get(id);
    if (!rec || rec.child !== child) return;
    rec.child = null;
    rec.lastExit = { code, signal, at: new Date().toISOString() };
    this.note(id, `Process exited (${signal ? `signal ${signal}` : `code ${code}`})`);
    if (rec.stopping) return;
    const app = this.registry.get(id);
    if (!app || app.desired !== 'running') return;
    // Unexpected exit: restart with backoff, give up after too many crashes.
    const now = Date.now();
    const ranFor = now - Date.parse(rec.startedAt);
    if (ranFor > 60000) rec.crashes = [];
    rec.crashes = rec.crashes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    if (rec.crashes.length >= MAX_CRASHES) {
      rec.crashed = true;
      this.note(id, `Crashed ${rec.crashes.length} times in 10 minutes; not restarting. Check the log, then start it again.`);
      if (this.notifier) {
        this.notifier.notify('crash', {
          app: id, level: 'error', title: `${app.name} keeps crashing`,
          message: `It crashed ${rec.crashes.length} times in 10 minutes and was stopped. Last exit: ${signal ? `signal ${signal}` : `code ${code}`}.`,
        });
      }
      return;
    }
    const delay = Math.min(60000, 1000 * 2 ** (rec.crashes.length - 1));
    this.note(id, `Restarting in ${Math.round(delay / 1000)}s`);
    rec.timer = setTimeout(() => {
      rec.timer = null;
      this.start(id).catch((err) => {
        this.note(id, `Restart failed: ${err.message}`);
        rec.crashed = true;
      });
    }, delay);
  }

  async stop(id) {
    const rec = this.procs.get(id);
    if (!rec) return;
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    rec.crashed = false;
    rec.crashes = [];
    const { child } = rec;
    if (!child) return;
    rec.stopping = true;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    killGroup(child, 'SIGTERM');
    const timedOut = await Promise.race([exited.then(() => false), delay(STOP_GRACE_MS).then(() => true)]);
    if (timedOut) {
      this.note(id, 'Did not stop in time, killing');
      killGroup(child, 'SIGKILL');
      await Promise.race([exited, delay(2000)]);
    }
    rec.stopping = false;
    rec.child = null;
    const app = this.registry.get(id);
    if (app && app.type === 'docker') await run('docker', ['rm', '-f', runtimes.dockerName(id)]).catch(() => {});
  }

  async restart(id) {
    await this.stop(id);
    await this.start(id);
  }

  async stopAll() {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id).catch(() => {})));
  }

  forget(id) {
    this.procs.delete(id);
  }
}

function killGroup(child, sig) {
  try {
    process.kill(-child.pid, sig);
  } catch {
    try { child.kill(sig); } catch { /* already gone */ }
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const { resolveCommand } = runtimes;

module.exports = { ProcessManager, resolveCommand, appEnv, baseEnv, isPortFree, STATIC_SERVER };
