const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { exec, spawn } = require('child_process');
const util = require('util');
const net = require('net');
const cron = require('node-cron');
const execAsync = util.promisify(exec);

const app = express();
const PANEL_PORT = 9000;
const APPS_DIR = '/root/pi-paas-data/apps';
const DATA_DIR = '/root/pi-paas-data';
const DB_FILE = path.join(DATA_DIR, 'registry.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PORT_RANGE_START = 3001;
const PORT_RANGE_END = 3200;
const MAX_BACKUPS = 5;

fs.ensureDirSync(APPS_DIR);
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(LOG_DIR);
fs.ensureDirSync(BACKUP_DIR);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/zip' || file.originalname.endsWith('.zip') ||
               file.mimetype === 'text/html' || file.originalname.endsWith('.html') || file.originalname.endsWith('.htm');
    cb(ok ? null : new Error('Only .zip or .html files allowed'), ok);
  }
});

// --- Registry ---
function loadRegistry() {
  if (!fs.existsSync(DB_FILE)) fs.writeJsonSync(DB_FILE, { apps: {} });
  return fs.readJsonSync(DB_FILE);
}
function saveRegistry(data) { fs.writeJsonSync(DB_FILE, data, { spaces: 2 }); }

// --- Port utilities ---
async function getSystemPorts() {
  try {
    const { stdout } = await execAsync("ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo ''");
    const ports = []; const re = /:(\d+)\s/g; let m;
    while ((m = re.exec(stdout)) !== null) { const p = parseInt(m[1]); if (p >= PORT_RANGE_START && p <= PORT_RANGE_END) ports.push(p); }
    return [...new Set(ports)];
  } catch { return []; }
}
function getRegistryPorts() { return Object.values(loadRegistry().apps).map(a => a.port); }
function findFreePort() {
  const used = getRegistryPorts();
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) { if (!used.includes(p)) return p; }
  throw new Error('No free ports available');
}

// --- API: Ports ---
app.get('/api/ports', async (req, res) => {
  const rp = getRegistryPorts(), sp = await getSystemPorts(), all = [...new Set([...rp, ...sp])];
  const reg = loadRegistry();
  const ports = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    const byApp = rp.includes(p), bySys = sp.includes(p) && !byApp;
    let appName = null;
    if (byApp) { const e = Object.entries(reg.apps).find(([, a]) => a.port === p); if (e) appName = e[1].name; }
    ports.push({ port: p, available: !all.includes(p), usedBy: byApp ? 'app' : bySys ? 'system' : null, appName });
  }
  res.json(ports);
});

// --- API: Apps ---
app.get('/api/apps', (req, res) => {
  const reg = loadRegistry();
  res.json(Object.entries(reg.apps).map(([id, a]) => ({ id, ...a, url: `http://${getServerIP()}:${a.port}` })));
});
app.get('/api/apps/:id', (req, res) => {
  const a = loadRegistry().apps[req.params.id];
  if (!a) return res.status(404).json({ error: 'App not found' });
  res.json({ id: req.params.id, ...a });
});

// --- API: Deploy ---
app.post('/api/apps', upload.single('zipfile'), async (req, res) => {
  try {
    const { name, type, dbType, dbName: customDbName } = req.body;
    let port = parseInt(req.body.port);
    if (!name || !type || !req.file) return res.status(400).json({ error: 'Name, type and file are required' });

    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    const registry = loadRegistry();
    if (registry.apps[id]) return res.status(409).json({ error: 'App with this name already exists' });

    if (port && port >= PORT_RANGE_START && port <= PORT_RANGE_END) {
      if (getRegistryPorts().includes(port)) return res.status(409).json({ error: `Port ${port} is already used` });
    } else { port = findFreePort(); }

    const appDir = path.join(APPS_DIR, id);
    fs.ensureDirSync(appDir);

    const isHtml = req.file.originalname.endsWith('.html') || req.file.originalname.endsWith('.htm');
    if (isHtml) { fs.moveSync(req.file.path, path.join(appDir, 'index.html'), { overwrite: true }); }
    else {
      await execAsync(`unzip -o "${req.file.path}" -d "${appDir}"`); fs.removeSync(req.file.path);
      const entries = fs.readdirSync(appDir);
      if (entries.length === 1 && fs.statSync(path.join(appDir, entries[0])).isDirectory()) {
        const sub = path.join(appDir, entries[0]);
        for (const e of fs.readdirSync(sub)) fs.moveSync(path.join(sub, e), path.join(appDir, e), { overwrite: true });
        fs.removeSync(sub);
      }
    }

    // Database setup
    let dbInfo = null;
    if (dbType === 'sqlite') {
      const fname = (customDbName || 'data').replace(/[^a-z0-9_-]/gi, '') + '.db';
      dbInfo = { type: 'sqlite', name: fname, path: path.join(appDir, fname) };
    } else if (dbType === 'postgres') {
      const pgName = customDbName ? customDbName.replace(/[^a-z0-9_]/gi, '_').toLowerCase() : `pipaas_${id.replace(/-/g, '_')}`;
      try { await execAsync(`su -c "createdb ${pgName}" postgres 2>/dev/null || true`); } catch {}
      dbInfo = { type: 'postgres', name: pgName, url: `postgresql://localhost:5432/${pgName}` };
    }

    // Install deps
    if (type === 'node' || type === 'react') {
      if (fs.existsSync(path.join(appDir, 'package.json'))) await execAsync(`cd "${appDir}" && npm install --production`, { timeout: 120000 });
      if (type === 'react') { const p2 = path.join(appDir, 'package.json'); if (fs.existsSync(p2)) { const pkg = fs.readJsonSync(p2); if (pkg.scripts?.build) await execAsync(`cd "${appDir}" && npm run build`, { timeout: 120000 }); } }
    } else if (type === 'python' && fs.existsSync(path.join(appDir, 'requirements.txt'))) {
      const v = path.join(appDir, 'venv');
      await execAsync(`python3 -m venv "${v}" && "${v}/bin/pip" install -r "${path.join(appDir, 'requirements.txt')}"`, { timeout: 120000 });
    }

    const appEntry = { name, type, port, dbType: dbType || 'none', dbInfo, backupSchedule: 'off', status: 'stopped', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 };
    registry.apps[id] = appEntry; saveRegistry(registry);
    await startApp(id, appEntry);
    res.json({ id, ...registry.apps[id], message: 'App deployed successfully!' });
  } catch (err) { console.error('Deploy error:', err); res.status(500).json({ error: err.message }); }
});

// --- API: Update ---
app.put('/api/apps/:id', upload.single('zipfile'), async (req, res) => {
  try {
    const registry = loadRegistry();
    const appEntry = registry.apps[req.params.id];
    if (!appEntry) return res.status(404).json({ error: 'App not found' });
    await stopApp(req.params.id);
    const appDir = path.join(APPS_DIR, req.params.id);

    const newPort = parseInt(req.body.port);
    if (newPort && newPort >= PORT_RANGE_START && newPort <= PORT_RANGE_END && newPort !== appEntry.port) {
      if (getRegistryPorts().filter(p => p !== appEntry.port).includes(newPort)) return res.status(409).json({ error: `Port ${newPort} is already used` });
      appEntry.port = newPort;
    }

    if (req.file) {
      let dbBackup = null;
      if (appEntry.dbType === 'sqlite' && appEntry.dbInfo) {
        const dbPath = appEntry.dbInfo.path || path.join(appDir, 'data.db');
        if (fs.existsSync(dbPath)) dbBackup = { name: path.basename(dbPath), data: fs.readFileSync(dbPath) };
      }
      fs.emptyDirSync(appDir);
      const isHtml = req.file.originalname.endsWith('.html') || req.file.originalname.endsWith('.htm');
      if (isHtml) { fs.moveSync(req.file.path, path.join(appDir, 'index.html'), { overwrite: true }); }
      else {
        await execAsync(`unzip -o "${req.file.path}" -d "${appDir}"`); fs.removeSync(req.file.path);
        const entries = fs.readdirSync(appDir);
        if (entries.length === 1 && fs.statSync(path.join(appDir, entries[0])).isDirectory()) {
          const sub = path.join(appDir, entries[0]);
          for (const e of fs.readdirSync(sub)) fs.moveSync(path.join(sub, e), path.join(appDir, e), { overwrite: true });
          fs.removeSync(sub);
        }
      }
      if (dbBackup) fs.writeFileSync(path.join(appDir, dbBackup.name), dbBackup.data);
      if (appEntry.type === 'node' || appEntry.type === 'react') { if (fs.existsSync(path.join(appDir, 'package.json'))) await execAsync(`cd "${appDir}" && npm install --production`, { timeout: 120000 }); }
      else if (appEntry.type === 'python' && fs.existsSync(path.join(appDir, 'requirements.txt'))) { const v = path.join(appDir, 'venv'); await execAsync(`python3 -m venv "${v}" && "${v}/bin/pip" install -r "${path.join(appDir, 'requirements.txt')}"`, { timeout: 120000 }); }
      appEntry.version = (appEntry.version || 1) + 1;
    }
    appEntry.updatedAt = new Date().toISOString(); saveRegistry(registry);
    await startApp(req.params.id, appEntry);
    res.json({ id: req.params.id, ...registry.apps[req.params.id], message: 'App updated!' });
  } catch (err) { console.error('Update error:', err); res.status(500).json({ error: err.message }); }
});

// --- API: Delete ---
app.delete('/api/apps/:id', async (req, res) => {
  try {
    const registry = loadRegistry(); const appEntry = registry.apps[req.params.id];
    if (!appEntry) return res.status(404).json({ error: 'App not found' });
    await stopApp(req.params.id);
    if (appEntry.dbType === 'postgres' && appEntry.dbInfo) { try { await execAsync(`su -c "dropdb ${appEntry.dbInfo.name}" postgres 2>/dev/null || true`); } catch {} }
    fs.removeSync(path.join(APPS_DIR, req.params.id));
    fs.removeSync(path.join(BACKUP_DIR, req.params.id));
    cancelSchedule(req.params.id);
    delete registry.apps[req.params.id]; saveRegistry(registry);
    res.json({ message: 'App deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- API: Start/Stop/Restart (specific routes to avoid conflicting with /backups, /db, /files) ---
app.post('/api/apps/:id/start', async (req, res) => {
  const reg = loadRegistry(); const a = reg.apps[req.params.id];
  if (!a) return res.status(404).json({ error: 'App not found' });
  try { await startApp(req.params.id, a); res.json({ id: req.params.id, ...loadRegistry().apps[req.params.id] }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/apps/:id/stop', async (req, res) => {
  const reg = loadRegistry(); const a = reg.apps[req.params.id];
  if (!a) return res.status(404).json({ error: 'App not found' });
  try { await stopApp(req.params.id); res.json({ id: req.params.id, ...loadRegistry().apps[req.params.id] }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/apps/:id/restart', async (req, res) => {
  const reg = loadRegistry(); const a = reg.apps[req.params.id];
  if (!a) return res.status(404).json({ error: 'App not found' });
  try { await stopApp(req.params.id); await startApp(req.params.id, a); res.json({ id: req.params.id, ...loadRegistry().apps[req.params.id] }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- API: Logs ---
app.get('/api/apps/:id/logs', (req, res) => {
  const f = path.join(LOG_DIR, `${req.params.id}.log`);
  if (!fs.existsSync(f)) return res.json({ logs: 'No logs available' });
  res.json({ logs: fs.readFileSync(f, 'utf-8').split('\n').slice(-200).join('\n') });
});

// ===========================
// DATABASE MANAGEMENT
// ===========================

// Rename database
app.put('/api/apps/:id/db', async (req, res) => {
  try {
    const registry = loadRegistry(); const appEntry = registry.apps[req.params.id];
    if (!appEntry) return res.status(404).json({ error: 'App not found' });
    if (!appEntry.dbInfo) return res.status(400).json({ error: 'App has no database' });

    const { newName } = req.body;
    if (!newName) return res.status(400).json({ error: 'New name required' });

    if (appEntry.dbInfo.type === 'sqlite') {
      const sanitized = newName.replace(/[^a-z0-9_-]/gi, '') + '.db';
      const appDir = path.join(APPS_DIR, req.params.id);
      const oldPath = appEntry.dbInfo.path;
      const newPath = path.join(appDir, sanitized);
      if (oldPath !== newPath) {
        if (fs.existsSync(oldPath)) fs.moveSync(oldPath, newPath, { overwrite: false });
        appEntry.dbInfo.name = sanitized;
        appEntry.dbInfo.path = newPath;
      }
    } else if (appEntry.dbInfo.type === 'postgres') {
      const sanitized = newName.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
      const oldName = appEntry.dbInfo.name;
      if (sanitized !== oldName) {
        await stopApp(req.params.id);
        try { await execAsync(`su -c "psql -c \\"ALTER DATABASE ${oldName} RENAME TO ${sanitized};\\"" postgres`); } catch (e) { return res.status(500).json({ error: 'Failed to rename PostgreSQL DB: ' + e.message }); }
        appEntry.dbInfo.name = sanitized;
        appEntry.dbInfo.url = `postgresql://localhost:5432/${sanitized}`;
        await startApp(req.params.id, appEntry);
      }
    }
    appEntry.updatedAt = new Date().toISOString(); saveRegistry(registry);
    res.json({ message: 'Database renamed', dbInfo: appEntry.dbInfo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================
// BACKUP SYSTEM
// ===========================

// List backups for an app
app.get('/api/apps/:id/backups', (req, res) => {
  const reg = loadRegistry();
  if (!reg.apps[req.params.id]) return res.status(404).json({ error: 'App not found' });
  const dir = path.join(BACKUP_DIR, req.params.id);
  if (!fs.existsSync(dir)) return res.json({ backups: [], schedule: reg.apps[req.params.id].backupSchedule || 'off' });

  const backups = fs.readdirSync(dir)
    .filter(f => f.endsWith('.tar.gz'))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      const ts = f.replace('.tar.gz', '');
      return { filename: f, timestamp: ts, date: new Date(parseInt(ts)).toISOString(), size: stat.size };
    })
    .sort((a, b) => parseInt(b.timestamp) - parseInt(a.timestamp));

  res.json({ backups, schedule: reg.apps[req.params.id].backupSchedule || 'off' });
});

// Create backup (manual)
app.post('/api/apps/:id/backups', async (req, res) => {
  try {
    const reg = loadRegistry(); const appEntry = reg.apps[req.params.id];
    if (!appEntry) return res.status(404).json({ error: 'App not found' });
    const result = await createBackup(req.params.id, appEntry);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Download backup
app.get('/api/apps/:id/backups/:filename/download', (req, res) => {
  const file = path.join(BACKUP_DIR, req.params.id, req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Backup not found' });
  res.download(file);
});

// Restore from backup
app.post('/api/apps/:id/backups/:filename/restore', async (req, res) => {
  try {
    const reg = loadRegistry(); const appEntry = reg.apps[req.params.id];
    if (!appEntry) return res.status(404).json({ error: 'App not found' });
    const file = path.join(BACKUP_DIR, req.params.id, req.params.filename);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Backup not found' });

    await stopApp(req.params.id);
    const appDir = path.join(APPS_DIR, req.params.id);
    const tmpDir = path.join(UPLOAD_DIR, `restore_${req.params.id}_${Date.now()}`);

    // Extract backup to temp
    fs.ensureDirSync(tmpDir);
    await execAsync(`tar -xzf "${file}" -C "${tmpDir}"`);

    // Restore app files
    const filesDir = path.join(tmpDir, 'files');
    if (fs.existsSync(filesDir)) { fs.emptyDirSync(appDir); fs.copySync(filesDir, appDir); }

    // Restore PostgreSQL dump if exists
    if (appEntry.dbType === 'postgres' && appEntry.dbInfo) {
      const dumpFile = path.join(tmpDir, 'db.sql');
      if (fs.existsSync(dumpFile)) {
        try {
          await execAsync(`su -c "dropdb ${appEntry.dbInfo.name}" postgres 2>/dev/null || true`);
          await execAsync(`su -c "createdb ${appEntry.dbInfo.name}" postgres`);
          await execAsync(`su -c "psql ${appEntry.dbInfo.name} < ${dumpFile}" postgres`);
        } catch (e) { console.error('PG restore error:', e.message); }
      }
    }

    // Cleanup
    fs.removeSync(tmpDir);
    await startApp(req.params.id, appEntry);
    res.json({ message: 'Backup restored successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a backup
app.delete('/api/apps/:id/backups/:filename', (req, res) => {
  const file = path.join(BACKUP_DIR, req.params.id, req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Backup not found' });
  fs.removeSync(file);
  res.json({ message: 'Backup deleted' });
});

// Set backup schedule
app.put('/api/apps/:id/backups/schedule', (req, res) => {
  const reg = loadRegistry(); const appEntry = reg.apps[req.params.id];
  if (!appEntry) return res.status(404).json({ error: 'App not found' });
  const { schedule } = req.body; // 'off', 'daily', 'weekly'
  if (!['off', 'daily', 'weekly'].includes(schedule)) return res.status(400).json({ error: 'Schedule must be off, daily, or weekly' });
  appEntry.backupSchedule = schedule; saveRegistry(reg);
  setupSchedule(req.params.id, schedule);
  res.json({ message: `Backup schedule set to ${schedule}`, schedule });
});

// --- Backup helpers ---
async function createBackup(id, appEntry) {
  const appDir = path.join(APPS_DIR, id);
  const bkDir = path.join(BACKUP_DIR, id);
  fs.ensureDirSync(bkDir);

  const ts = Date.now();
  const tmpDir = path.join(UPLOAD_DIR, `backup_${id}_${ts}`);
  fs.ensureDirSync(tmpDir);

  // Copy app files (exclude node_modules, venv, __pycache__)
  const filesDir = path.join(tmpDir, 'files');
  fs.ensureDirSync(filesDir);
  if (fs.existsSync(appDir)) {
    await execAsync(`rsync -a --exclude='node_modules' --exclude='venv' --exclude='__pycache__' --exclude='.git' "${appDir}/" "${filesDir}/" 2>/dev/null || cp -r "${appDir}/." "${filesDir}/"`);
  }

  // Dump PostgreSQL if applicable
  if (appEntry.dbType === 'postgres' && appEntry.dbInfo) {
    try { await execAsync(`su -c "pg_dump ${appEntry.dbInfo.name}" postgres > "${path.join(tmpDir, 'db.sql')}"`); } catch (e) { console.error('PG dump error:', e.message); }
  }

  // Save metadata
  fs.writeJsonSync(path.join(tmpDir, 'meta.json'), { id, name: appEntry.name, type: appEntry.type, dbType: appEntry.dbType, dbInfo: appEntry.dbInfo, version: appEntry.version, backedUpAt: new Date().toISOString() });

  // Create tar.gz
  const bkFile = path.join(bkDir, `${ts}.tar.gz`);
  await execAsync(`tar -czf "${bkFile}" -C "${tmpDir}" .`);
  fs.removeSync(tmpDir);

  // Rotate old backups
  const existing = fs.readdirSync(bkDir).filter(f => f.endsWith('.tar.gz')).sort().reverse();
  for (let i = MAX_BACKUPS; i < existing.length; i++) { fs.removeSync(path.join(bkDir, existing[i])); }

  const stat = fs.statSync(bkFile);
  return { message: 'Backup created', filename: `${ts}.tar.gz`, timestamp: String(ts), date: new Date(ts).toISOString(), size: stat.size };
}

// --- Scheduled backups ---
const scheduleJobs = {};

function setupSchedule(id, schedule) {
  cancelSchedule(id);
  if (schedule === 'off') return;

  const cronExpr = schedule === 'daily' ? '0 3 * * *' : '0 3 * * 0'; // 3am daily or Sunday
  scheduleJobs[id] = cron.schedule(cronExpr, async () => {
    const reg = loadRegistry(); const a = reg.apps[id];
    if (!a) { cancelSchedule(id); return; }
    console.log(`[BACKUP] Scheduled backup for ${id}`);
    try { await createBackup(id, a); } catch (e) { console.error(`[BACKUP] Failed for ${id}:`, e.message); }
  });
  console.log(`[BACKUP] Scheduled ${schedule} backup for ${id}`);
}

function cancelSchedule(id) {
  if (scheduleJobs[id]) { scheduleJobs[id].stop(); delete scheduleJobs[id]; }
}

function restoreAllSchedules() {
  const reg = loadRegistry();
  for (const [id, a] of Object.entries(reg.apps)) {
    if (a.backupSchedule && a.backupSchedule !== 'off') setupSchedule(id, a.backupSchedule);
  }
}

// ===========================
// FILE MANAGER
// ===========================
app.get('/api/apps/:id/files', (req, res) => {
  const reg = loadRegistry();
  if (!reg.apps[req.params.id]) return res.status(404).json({ error: 'App not found' });
  const appDir = path.join(APPS_DIR, req.params.id);
  if (!fs.existsSync(appDir)) return res.json({ files: [] });
  function buildTree(dir, base = '') {
    const result = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'venv', '__pycache__', '.git', '.cache'].includes(entry.name)) continue;
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) result.push({ name: entry.name, path: rel, type: 'dir', children: buildTree(path.join(dir, entry.name), rel) });
      else { const s = fs.statSync(path.join(dir, entry.name)); result.push({ name: entry.name, path: rel, type: 'file', size: s.size, ext: path.extname(entry.name).slice(1) }); }
    }
    return result.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
  }
  res.json({ files: buildTree(appDir) });
});

app.get('/api/apps/:id/files/*', (req, res) => {
  if (!loadRegistry().apps[req.params.id]) return res.status(404).json({ error: 'App not found' });
  const fp = req.params[0]; if (fp.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  const full = path.join(APPS_DIR, req.params.id, fp);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(full); if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
  const ext = path.extname(fp).toLowerCase();
  const textExts = ['.html','.htm','.css','.js','.jsx','.ts','.tsx','.json','.md','.txt','.py','.rb','.php','.xml','.svg','.yml','.yaml','.toml','.ini','.cfg','.conf','.sh','.bash','.env','.gitignore','.sql','.csv','.log','.map'];
  if (!textExts.includes(ext) && stat.size > 1024*1024) return res.json({ content: null, binary: true, size: stat.size });
  try { res.json({ content: fs.readFileSync(full, 'utf-8'), size: stat.size, ext: ext.slice(1) }); } catch { res.json({ content: null, binary: true, size: stat.size }); }
});

app.put('/api/apps/:id/files/*', (req, res) => {
  if (!loadRegistry().apps[req.params.id]) return res.status(404).json({ error: 'App not found' });
  const fp = req.params[0]; if (fp.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  const { content } = req.body; if (content === undefined) return res.status(400).json({ error: 'Content required' });
  try { const full = path.join(APPS_DIR, req.params.id, fp); fs.ensureDirSync(path.dirname(full)); fs.writeFileSync(full, content, 'utf-8'); res.json({ message: 'File saved', size: Buffer.byteLength(content) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/apps/:id/files', (req, res) => {
  if (!loadRegistry().apps[req.params.id]) return res.status(404).json({ error: 'App not found' });
  const { filePath, content = '' } = req.body; if (!filePath) return res.status(400).json({ error: 'File path required' }); if (filePath.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  const full = path.join(APPS_DIR, req.params.id, filePath);
  if (fs.existsSync(full)) return res.status(409).json({ error: 'File already exists' });
  try { fs.ensureDirSync(path.dirname(full)); fs.writeFileSync(full, content, 'utf-8'); res.json({ message: 'File created', path: filePath }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/apps/:id/files/*', (req, res) => {
  if (!loadRegistry().apps[req.params.id]) return res.status(404).json({ error: 'App not found' });
  const fp = req.params[0]; if (fp.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  const full = path.join(APPS_DIR, req.params.id, fp);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });
  try { fs.removeSync(full); res.json({ message: 'File deleted' }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===========================
// PROCESS MANAGEMENT
// ===========================
const runningProcesses = {};

async function startApp(id, appEntry) {
  const appDir = path.join(APPS_DIR, id);
  fs.ensureDirSync(LOG_DIR);
  const logStream = fs.createWriteStream(path.join(LOG_DIR, `${id}.log`), { flags: 'a' });
  const env = { ...process.env, PORT: String(appEntry.port), APP_PORT: String(appEntry.port), NODE_ENV: 'production' };
  if (appEntry.dbInfo) {
    if (appEntry.dbInfo.type === 'sqlite') { env.DATABASE_URL = `sqlite:${appEntry.dbInfo.path}`; env.SQLITE_PATH = appEntry.dbInfo.path; }
    else if (appEntry.dbInfo.type === 'postgres') { env.DATABASE_URL = appEntry.dbInfo.url; env.PGDATABASE = appEntry.dbInfo.name; }
  }
  let proc;
  if (appEntry.type === 'static' || appEntry.type === 'react') {
    const dir = appEntry.type === 'react' ? (fs.existsSync(path.join(appDir, 'build')) ? path.join(appDir, 'build') : fs.existsSync(path.join(appDir, 'dist')) ? path.join(appDir, 'dist') : appDir) : appDir;
    proc = spawn('npx', ['serve', '-s', dir, '-l', String(appEntry.port), '--no-clipboard'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } else if (appEntry.type === 'node') {
    let entry = 'server.js';
    if (fs.existsSync(path.join(appDir, 'package.json'))) { const pkg = fs.readJsonSync(path.join(appDir, 'package.json')); if (pkg.main) entry = pkg.main; if (pkg.scripts?.start) proc = spawn('npm', ['start'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    if (!proc) { if (fs.existsSync(path.join(appDir, 'index.js'))) entry = 'index.js'; if (fs.existsSync(path.join(appDir, 'app.js'))) entry = 'app.js'; proc = spawn('node', [entry], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  } else if (appEntry.type === 'python') {
    let entry = 'app.py'; if (fs.existsSync(path.join(appDir, 'main.py'))) entry = 'main.py'; if (fs.existsSync(path.join(appDir, 'server.py'))) entry = 'server.py';
    const py = fs.existsSync(path.join(appDir, 'venv', 'bin', 'python')) ? path.join(appDir, 'venv', 'bin', 'python') : 'python3';
    proc = spawn(py, [entry], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  if (proc) {
    proc.stdout.pipe(logStream); proc.stderr.pipe(logStream);
    proc.on('exit', (code) => { logStream.write(`\n[PI-PAAS] Process exited with code ${code}\n`); const r = loadRegistry(); if (r.apps[id]) { r.apps[id].status = 'stopped'; saveRegistry(r); } delete runningProcesses[id]; });
    runningProcesses[id] = proc;
    const r = loadRegistry(); r.apps[id].status = 'running'; r.apps[id].pid = proc.pid; saveRegistry(r);
  }
}

async function stopApp(id) {
  if (runningProcesses[id]) { runningProcesses[id].kill('SIGTERM'); await new Promise(r => setTimeout(r, 2000)); if (runningProcesses[id] && !runningProcesses[id].killed) runningProcesses[id].kill('SIGKILL'); delete runningProcesses[id]; }
  const r = loadRegistry(); if (r.apps[id]?.pid) { try { process.kill(r.apps[id].pid, 'SIGTERM'); } catch {} }
  if (r.apps[id]) { r.apps[id].status = 'stopped'; r.apps[id].pid = null; saveRegistry(r); }
}

function getServerIP() { const os = require('os'); for (const [, ii] of Object.entries(os.networkInterfaces())) for (const i of ii) if (i.family === 'IPv4' && !i.internal) return i.address; return 'localhost'; }

async function restoreApps() {
  const r = loadRegistry();
  for (const [id, a] of Object.entries(r.apps)) { if (a.status === 'running') { console.log(`Restoring: ${id}`); try { await startApp(id, a); } catch (e) { console.error(`Failed: ${id}`, e.message); } } }
}

app.listen(PANEL_PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Pi-PaaS running at http://${getServerIP()}:${PANEL_PORT}\n`);
  restoreApps();
  restoreAllSchedules();
});
