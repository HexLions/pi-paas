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

const STATIC_SERVER = path.join(__dirname, 'static-server.js');

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

/** Work out how to start an app from its type and files. */
function resolveCommand(appDir, app, staticServer = STATIC_SERVER) {
  if (app.startCommand) return { cmd: '/bin/sh', args: ['-c', app.startCommand], label: app.startCommand };
  const has = (f) => fs.existsSync(path.join(appDir, f));
  if (app.type === 'static' || app.type === 'react') {
    let dir = appDir;
    if (app.type === 'react') dir = ['dist', 'build', 'out'].map((d) => path.join(appDir, d)).find((d) => fs.existsSync(d)) || appDir;
    return { cmd: process.execPath, args: [staticServer, dir, String(app.port), '--spa'], label: `static ${path.relative(appDir, dir) || '.'}` };
  }
  if (app.type === 'node') {
    if (has('package.json')) {
      const pkg = fs.readJsonSync(path.join(appDir, 'package.json'), { throws: false }) || {};
      if (pkg.scripts && pkg.scripts.start) return { cmd: 'npm', args: ['start', '--silent'], label: 'npm start' };
      if (pkg.main && has(pkg.main)) return { cmd: process.execPath, args: [pkg.main], label: `node ${pkg.main}` };
    }
    const entry = ['server.js', 'app.js', 'index.js', 'main.js'].find(has);
    if (!entry) throw new Error('No entry point found: add a "start" script to package.json or a server.js / app.js / index.js');
    return { cmd: process.execPath, args: [entry], label: `node ${entry}` };
  }
  if (app.type === 'python') {
    const venvPy = path.join(appDir, 'venv', 'bin', 'python');
    const py = fs.existsSync(venvPy) ? venvPy : 'python3';
    const entry = ['server.py', 'main.py', 'app.py', 'wsgi.py'].find(has);
    if (!entry) throw new Error('No entry point found: add app.py, main.py or server.py');
    return { cmd: py, args: [entry], label: `python ${entry}` };
  }
  throw new Error(`Unknown app type "${app.type}"`);
}

class ProcessManager {
  constructor(cfg, registry, { log = console, runAs = null } = {}) {
    this.cfg = cfg;
    this.registry = registry;
    this.log = log;
    this.runAs = runAs; // { uid, gid } or null
    this.procs = new Map();
    this.staticServer = prepareStaticServer(cfg, runAs);
  }

  logFile(id) {
    return path.join(this.cfg.logDir, `${id}.log`);
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
    const { cmd, args, label } = resolveCommand(appDir, app, this.staticServer);
    await fs.ensureDir(this.cfg.logDir);
    this.rotateLog(id);
    this.note(id, `Starting: ${label} on port ${app.port}`);
    const out = fs.openSync(this.logFile(id), 'a');
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: appDir,
        env: appEnv(this.cfg, id, app),
        stdio: ['ignore', out, out],
        detached: true,
        ...(this.runAs || {}),
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

module.exports = { ProcessManager, resolveCommand, appEnv, baseEnv, isPortFree, STATIC_SERVER };
