'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { COOKIE, SESSION_DAYS, parseCookies, sessionCookie } = require('./auth');
const database = require('./database');
const {
  HttpError, safeResolve, tailFile, looksBinary, writeFileAtomic,
} = require('./util');

const SKIP_IN_TREE = new Set(['node_modules', 'venv', '.venv', '__pycache__', '.git', '.cache']);
const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 5000;

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function createHttpApp({ cfg, auth, service, backups, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });

  const frontend = path.join(__dirname, '..', 'frontend');
  // No max-age: after an upgrade the browser must pick up the new app.js (ETag keeps it cheap).
  app.use(express.static(frontend, { index: 'index.html' }));
  app.use('/vendor/codemirror', express.static(path.dirname(require.resolve('codemirror/package.json')), { maxAge: '1d' }));
  app.use('/assets', express.static(path.join(__dirname, '..', 'assets'), { maxAge: '7d' }));
  app.use('/api', express.json({ limit: `${MAX_EDIT_BYTES * 2}b` }));

  const upload = multer({
    dest: cfg.uploadDir,
    limits: { fileSize: cfg.uploadLimitMb * 1024 * 1024, files: 1, fields: 20 },
    fileFilter: (req, file, cb) => {
      const ok = /\.(zip|html?)$/i.test(file.originalname);
      cb(ok ? null : new HttpError(400, 'Only .zip or .html files are allowed'), ok);
    },
  });
  const uploadAny = multer({ dest: cfg.uploadDir, limits: { fileSize: cfg.uploadLimitMb * 1024 * 1024, files: 1, fields: 5 } });

  // ---------- public ----------

  app.get('/api/health', (req, res) => res.json({ ok: true, version: cfg.version }));

  const isAuthed = (req) => cfg.authDisabled || auth.verifyToken(parseCookies(req.headers.cookie)[COOKIE]);

  app.get('/api/auth/status', (req, res) => {
    res.json({
      authenticated: isAuthed(req),
      authRequired: !cfg.authDisabled,
      initialPassword: !cfg.authDisabled && fs.existsSync(cfg.initialPasswordFile),
      version: cfg.version,
    });
  });

  // Every state-changing API call must carry this header. Browsers refuse to
  // send custom headers cross-site without CORS, which this server never grants.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-PiPaaS') !== '1') return next(new HttpError(403, 'Missing X-PiPaaS header'));
    next();
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (auth.tooManyAttempts(ip)) throw new HttpError(429, 'Too many failed attempts, wait 15 minutes');
    const password = req.body && req.body.password;
    if (!auth.checkPassword(password)) {
      auth.recordFailure(ip);
      log.warn(`[auth] failed login from ${ip}`);
      throw new HttpError(401, 'Wrong password');
    }
    auth.clearFailures(ip);
    res.set('Set-Cookie', sessionCookie(auth.issueToken(), req, SESSION_DAYS * 86400));
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.set('Set-Cookie', sessionCookie('', req, 0));
    res.json({ ok: true });
  });

  // ---------- everything below needs a session ----------

  app.use('/api', (req, res, next) => (isAuthed(req) ? next() : next(new HttpError(401, 'Login required'))));

  app.put('/api/auth/password', (req, res) => {
    if (cfg.authDisabled) throw new HttpError(400, 'Login is disabled (PIPAAS_AUTH=off)');
    const { current, next } = req.body || {};
    if (!auth.checkPassword(current)) throw new HttpError(401, 'Current password is wrong');
    auth.setPassword(next);
    fs.removeSync(cfg.initialPasswordFile);
    res.set('Set-Cookie', sessionCookie(auth.issueToken(), req, SESSION_DAYS * 86400));
    res.json({ ok: true });
  });

  app.get('/api/system', wrap(async (req, res) => {
    res.json(await systemInfo(cfg));
  }));

  app.get('/api/ports', wrap(async (req, res) => res.json(await service.ports())));

  // ---------- apps ----------

  app.get('/api/apps', (req, res) => res.json(service.list(req.hostname)));

  app.get('/api/apps/:id', (req, res) => {
    service.mustGet(req.params.id);
    res.json(service.view(req.params.id, req.hostname));
  });

  app.post('/api/apps', upload.single('zipfile'), wrap(async (req, res) => {
    const b = req.body || {};
    const view = await service.deploy({ name: b.name, type: b.type, dbType: b.dbType || 'none', dbName: b.dbName, port: b.port, file: req.file }, req.hostname);
    res.status(202).json(view);
  }));

  app.put('/api/apps/:id', upload.single('zipfile'), wrap(async (req, res) => {
    const view = await service.update(req.params.id, { file: req.file, port: (req.body || {}).port }, req.hostname);
    res.status(req.file ? 202 : 200).json(view);
  }));

  app.delete('/api/apps/:id', wrap(async (req, res) => {
    await service.remove(req.params.id);
    res.json({ message: 'App deleted' });
  }));

  for (const action of ['start', 'stop', 'restart']) {
    app.post(`/api/apps/:id/${action}`, wrap(async (req, res) => {
      await service[action](req.params.id);
      res.json(service.view(req.params.id, req.hostname));
    }));
  }

  app.get('/api/apps/:id/logs', wrap(async (req, res) => {
    service.mustGet(req.params.id);
    const file = path.join(cfg.logDir, `${req.params.id}.log`);
    if (!(await fs.pathExists(file))) return res.json({ logs: '' });
    const bytes = Math.min(Math.max(Number.parseInt(req.query.bytes, 10) || 65536, 1024), 1024 * 1024);
    res.json({ logs: await tailFile(file, bytes) });
  }));

  app.delete('/api/apps/:id/logs', wrap(async (req, res) => {
    service.mustGet(req.params.id);
    await fs.remove(path.join(cfg.logDir, `${req.params.id}.log`));
    await fs.remove(path.join(cfg.logDir, `${req.params.id}.log.1`));
    res.json({ message: 'Logs cleared' });
  }));

  app.get('/api/apps/:id/settings', (req, res) => {
    const a = service.mustGet(req.params.id);
    res.json({ env: service.getEnv(req.params.id), startCommand: a.startCommand || '' });
  });

  app.put('/api/apps/:id/settings', wrap(async (req, res) => {
    const { env, startCommand } = req.body || {};
    await service.setSettings(req.params.id, { env, startCommand });
    res.json(service.view(req.params.id, req.hostname));
  }));

  app.get('/api/apps/:id/db', (req, res) => {
    const a = service.mustGet(req.params.id);
    if (!a.dbInfo) throw new HttpError(404, 'App has no database');
    // Full details (with credentials) only on explicit request for one app.
    res.json({ ...a.dbInfo, url: a.dbInfo.type === 'postgres' ? database.pgUrl(a.dbInfo) : `sqlite:${a.dbInfo.path}` });
  });

  app.put('/api/apps/:id/db', wrap(async (req, res) => {
    const dbInfo = await service.renameDb(req.params.id, (req.body || {}).newName);
    res.json({ message: 'Database renamed', dbInfo: database.publicDbInfo(dbInfo) });
  }));

  // ---------- backups ----------

  app.get('/api/apps/:id/backups', wrap(async (req, res) => {
    const a = service.mustGet(req.params.id);
    res.json({ backups: await backups.list(req.params.id), schedule: a.backupSchedule || 'off' });
  }));

  app.post('/api/apps/:id/backups', wrap(async (req, res) => {
    res.json(await service.backup(req.params.id));
  }));

  app.put('/api/apps/:id/backups/schedule', wrap(async (req, res) => {
    const { schedule } = req.body || {};
    await service.setSchedule(req.params.id, schedule);
    res.json({ message: `Backup schedule set to ${schedule}`, schedule });
  }));

  app.get('/api/apps/:id/backups/:filename/download', wrap(async (req, res) => {
    service.mustGet(req.params.id);
    const file = backups.file(req.params.id, req.params.filename);
    if (!(await fs.pathExists(file))) throw new HttpError(404, 'Backup not found');
    res.download(file, `${req.params.id}-${req.params.filename}`);
  }));

  app.post('/api/apps/:id/backups/:filename/restore', wrap(async (req, res) => {
    const task = await service.restore(req.params.id, req.params.filename);
    res.status(202).json({ message: 'Restore started', task });
  }));

  app.delete('/api/apps/:id/backups/:filename', wrap(async (req, res) => {
    service.mustGet(req.params.id);
    await backups.remove(req.params.id, req.params.filename);
    res.json({ message: 'Backup deleted' });
  }));

  // ---------- file manager ----------

  const appRoot = (id) => {
    service.mustGet(id);
    return service.appDir(id);
  };
  const relPath = (req) => (Array.isArray(req.params.path) ? req.params.path.join('/') : String(req.params.path || ''));

  app.get('/api/apps/:id/files', wrap(async (req, res) => {
    const root = appRoot(req.params.id);
    if (!(await fs.pathExists(root))) return res.json({ files: [], truncated: false });
    let count = 0;
    const walk = async (dir, base) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        if (SKIP_IN_TREE.has(e.name) || e.isSymbolicLink()) continue;
        if (++count > MAX_TREE_ENTRIES) break;
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) out.push({ name: e.name, path: rel, type: 'dir', children: await walk(path.join(dir, e.name), rel) });
        else if (e.isFile()) {
          const st = await fs.stat(path.join(dir, e.name));
          out.push({ name: e.name, path: rel, type: 'file', size: st.size, ext: path.extname(e.name).slice(1).toLowerCase() });
        }
      }
      return out.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
    };
    const files = await walk(root, '');
    res.json({ files, truncated: count > MAX_TREE_ENTRIES });
  }));

  app.get('/api/apps/:id/files/*path', wrap(async (req, res) => {
    const full = safeResolve(appRoot(req.params.id), relPath(req));
    const st = await fs.stat(full).catch(() => null);
    if (!st) throw new HttpError(404, 'File not found');
    if (st.isDirectory()) throw new HttpError(400, 'Is a directory');
    if (req.query.download === '1') return res.download(full);
    const ext = path.extname(full).slice(1).toLowerCase();
    if (st.size > MAX_EDIT_BYTES) return res.json({ content: null, binary: false, tooLarge: true, size: st.size, ext });
    const buf = await fs.readFile(full);
    if (looksBinary(buf)) return res.json({ content: null, binary: true, size: st.size, ext });
    res.json({ content: buf.toString('utf8'), size: st.size, ext, mtime: st.mtimeMs });
  }));

  app.put('/api/apps/:id/files/*path', wrap(async (req, res) => {
    const full = safeResolve(appRoot(req.params.id), relPath(req));
    const { content, mtime } = req.body || {};
    if (typeof content !== 'string') throw new HttpError(400, 'Content required');
    const st = await fs.stat(full).catch(() => null);
    if (st && st.isDirectory()) throw new HttpError(400, 'Is a directory');
    // Refuse to overwrite a file changed on disk since the editor loaded it.
    if (st && mtime && Math.abs(st.mtimeMs - Number(mtime)) > 1) throw new HttpError(409, 'File changed on disk since you opened it; reload it first');
    await fs.ensureDir(path.dirname(full));
    await writeFileAtomic(full, content);
    const after = await fs.stat(full);
    res.json({ message: 'File saved', size: after.size, mtime: after.mtimeMs });
  }));

  app.post('/api/apps/:id/files', wrap(async (req, res) => {
    const { filePath, content = '' } = req.body || {};
    if (!filePath || typeof filePath !== 'string') throw new HttpError(400, 'File path required');
    if (typeof content !== 'string') throw new HttpError(400, 'Content must be text');
    const full = safeResolve(appRoot(req.params.id), filePath);
    if (await fs.pathExists(full)) throw new HttpError(409, 'File already exists');
    await fs.ensureDir(path.dirname(full));
    if (filePath.endsWith('/')) await fs.ensureDir(full);
    else await fs.writeFile(full, content);
    res.json({ message: 'File created', path: filePath });
  }));

  app.post('/api/apps/:id/upload', uploadAny.single('file'), wrap(async (req, res) => {
    try {
      if (!req.file) throw new HttpError(400, 'No file');
      const dir = (req.body && req.body.dir) || '';
      const name = path.basename(req.file.originalname);
      const full = safeResolve(appRoot(req.params.id), dir ? `${dir}/${name}` : name);
      await fs.ensureDir(path.dirname(full));
      await fs.move(req.file.path, full, { overwrite: true });
      res.json({ message: 'File uploaded', path: path.relative(service.appDir(req.params.id), full) });
    } finally {
      if (req.file) await fs.remove(req.file.path).catch(() => {});
    }
  }));

  app.delete('/api/apps/:id/files/*path', wrap(async (req, res) => {
    const root = appRoot(req.params.id);
    const full = safeResolve(root, relPath(req));
    if (full === path.resolve(root)) throw new HttpError(400, 'Invalid path');
    if (!(await fs.pathExists(full))) throw new HttpError(404, 'File not found');
    await fs.remove(full);
    res.json({ message: 'File deleted' });
  }));

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (req.file && req.file.path) fs.remove(req.file.path).catch(() => {});
    let status = err.status || err.statusCode || 500;
    let message = err.message || 'Internal error';
    if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      if (err.code === 'LIMIT_FILE_SIZE') message = `File is larger than ${cfg.uploadLimitMb} MB`;
    }
    if (err.type === 'entity.too.large') { status = 413; message = 'Request body too large'; }
    if (status >= 500) log.error(`[http] ${req.method} ${req.originalUrl}:`, err);
    res.status(status).json({ error: message });
  });

  return app;
}

async function systemInfo(cfg) {
  const read = (f) => fs.readFile(f, 'utf8').then((s) => s.replace(/\0/g, '').trim()).catch(() => null);
  const temp = await read('/sys/class/thermal/thermal_zone0/temp');
  let disk = null;
  try {
    const s = fs.statfsSync(cfg.dataDir);
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { /* statfs needs Node 18.15+ */ }
  return {
    version: cfg.version,
    hostname: os.hostname(),
    model: await read('/proc/device-tree/model'),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    uptime: os.uptime(),
    load: os.loadavg(),
    cpus: os.cpus().length,
    memory: { total: os.totalmem(), free: os.freemem() },
    disk,
    temperature: temp ? Number(temp) / 1000 : null,
    postgres: database.postgresAvailable(),
    appUser: cfg.appUser || null,
    portRange: [cfg.portStart, cfg.portEnd],
  };
}

module.exports = { createHttpApp };
