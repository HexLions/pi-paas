const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { exec, spawn } = require('child_process');
const util = require('util');
const net = require('net');
const execAsync = util.promisify(exec);

const app = express();
const PANEL_PORT = 9000;
const APPS_DIR = '/root/pi-paas-data/apps';
const DATA_DIR = '/root/pi-paas-data';
const DB_FILE = path.join(DATA_DIR, 'registry.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const PORT_RANGE_START = 3001;
const PORT_RANGE_END = 3200;

fs.ensureDirSync(APPS_DIR);
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(LOG_DIR);

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
function checkPort(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '0.0.0.0');
  });
}

async function getSystemPorts() {
  try {
    const { stdout } = await execAsync("ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo ''");
    const ports = [];
    const re = /:(\d+)\s/g;
    let m;
    while ((m = re.exec(stdout)) !== null) {
      const p = parseInt(m[1]);
      if (p >= PORT_RANGE_START && p <= PORT_RANGE_END) ports.push(p);
    }
    return [...new Set(ports)];
  } catch { return []; }
}

function getRegistryPorts() {
  const reg = loadRegistry();
  return Object.values(reg.apps).map(a => a.port);
}

function findFreePort() {
  const used = getRegistryPorts();
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!used.includes(p)) return p;
  }
  throw new Error('No free ports available');
}

// --- API: Available ports ---
app.get('/api/ports', async (req, res) => {
  const registryPorts = getRegistryPorts();
  const systemPorts = await getSystemPorts();
  const allUsed = [...new Set([...registryPorts, ...systemPorts])];

  const ports = [];
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    const usedByApp = registryPorts.includes(p);
    const usedBySystem = systemPorts.includes(p) && !usedByApp;
    let appName = null;
    if (usedByApp) {
      const reg = loadRegistry();
      const entry = Object.entries(reg.apps).find(([, a]) => a.port === p);
      if (entry) appName = entry[1].name;
    }
    ports.push({
      port: p,
      available: !allUsed.includes(p),
      usedBy: usedByApp ? 'app' : usedBySystem ? 'system' : null,
      appName
    });
  }
  res.json(ports);
});

// --- API: List apps ---
app.get('/api/apps', (req, res) => {
  const registry = loadRegistry();
  const apps = Object.entries(registry.apps).map(([id, a]) => ({
    id, ...a, url: `http://${getServerIP()}:${a.port}`
  }));
  res.json(apps);
});

app.get('/api/apps/:id', (req, res) => {
  const registry = loadRegistry();
  const a = registry.apps[req.params.id];
  if (!a) return res.status(404).json({ error: 'App not found' });
  res.json({ id: req.params.id, ...a });
});

// --- API: Deploy ---
app.post('/api/apps', upload.single('zipfile'), async (req, res) => {
  try {
    const { name, type, dbType } = req.body;
    let port = parseInt(req.body.port);
    if (!name || !type || !req.file) {
      return res.status(400).json({ error: 'Name, type and file are required' });
    }

    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    const registry = loadRegistry();
    if (registry.apps[id]) {
      return res.status(409).json({ error: 'App with this name already exists' });
    }

    // Port selection: use requested port or find free one
    if (port && port >= PORT_RANGE_START && port <= PORT_RANGE_END) {
      const usedPorts = getRegistryPorts();
      if (usedPorts.includes(port)) {
        return res.status(409).json({ error: `Port ${port} is already used by another app` });
      }
    } else {
      port = findFreePort();
    }

    const appDir = path.join(APPS_DIR, id);
    fs.ensureDirSync(appDir);

    const isHtml = req.file.originalname.endsWith('.html') || req.file.originalname.endsWith('.htm');
    if (isHtml) {
      fs.moveSync(req.file.path, path.join(appDir, 'index.html'), { overwrite: true });
    } else {
      await execAsync(`unzip -o "${req.file.path}" -d "${appDir}"`);
      fs.removeSync(req.file.path);
      const entries = fs.readdirSync(appDir);
      if (entries.length === 1 && fs.statSync(path.join(appDir, entries[0])).isDirectory()) {
        const subDir = path.join(appDir, entries[0]);
        for (const entry of fs.readdirSync(subDir)) {
          fs.moveSync(path.join(subDir, entry), path.join(appDir, entry), { overwrite: true });
        }
        fs.removeSync(subDir);
      }
    }

    // Database setup
    let dbInfo = null;
    if (dbType === 'sqlite') {
      dbInfo = { type: 'sqlite', path: path.join(appDir, 'data.db') };
    } else if (dbType === 'postgres') {
      const dbName = `pipaas_${id.replace(/-/g, '_')}`;
      try {
        await execAsync(`su -c "createdb ${dbName}" postgres 2>/dev/null || true`);
        dbInfo = { type: 'postgres', name: dbName, url: `postgresql://localhost:5432/${dbName}` };
      } catch (e) {
        dbInfo = { type: 'postgres', name: dbName, url: `postgresql://localhost:5432/${dbName}`, warning: 'Check PostgreSQL is installed' };
      }
    }

    // Install dependencies
    if (type === 'node' || type === 'react') {
      if (fs.existsSync(path.join(appDir, 'package.json'))) {
        await execAsync(`cd "${appDir}" && npm install --production`, { timeout: 120000 });
      }
      if (type === 'react') {
        const pkgPath = path.join(appDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = fs.readJsonSync(pkgPath);
          if (pkg.scripts && pkg.scripts.build) {
            await execAsync(`cd "${appDir}" && npm run build`, { timeout: 120000 });
          }
        }
      }
    } else if (type === 'python') {
      if (fs.existsSync(path.join(appDir, 'requirements.txt'))) {
        const venv = path.join(appDir, 'venv');
        await execAsync(`python3 -m venv "${venv}" && "${venv}/bin/pip" install -r "${path.join(appDir, 'requirements.txt')}"`, { timeout: 120000 });
      }
    }

    const appEntry = {
      name, type, port,
      dbType: dbType || 'none',
      dbInfo,
      status: 'stopped',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };

    registry.apps[id] = appEntry;
    saveRegistry(registry);
    await startApp(id, appEntry);

    res.json({ id, ...registry.apps[id], message: 'App deployed successfully!' });
  } catch (err) {
    console.error('Deploy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: Update ---
app.put('/api/apps/:id', upload.single('zipfile'), async (req, res) => {
  try {
    const registry = loadRegistry();
    const appEntry = registry.apps[req.params.id];
    if (!appEntry) return res.status(404).json({ error: 'App not found' });

    await stopApp(req.params.id);
    const appDir = path.join(APPS_DIR, req.params.id);

    // Allow port change on update
    const newPort = parseInt(req.body.port);
    if (newPort && newPort >= PORT_RANGE_START && newPort <= PORT_RANGE_END && newPort !== appEntry.port) {
      const usedPorts = getRegistryPorts().filter(p => p !== appEntry.port);
      if (usedPorts.includes(newPort)) {
        return res.status(409).json({ error: `Port ${newPort} is already used` });
      }
      appEntry.port = newPort;
    }

    if (req.file) {
      let dbBackup = null;
      const dbPath = path.join(appDir, 'data.db');
      if (appEntry.dbType === 'sqlite' && fs.existsSync(dbPath)) {
        dbBackup = fs.readFileSync(dbPath);
      }

      fs.emptyDirSync(appDir);
      const isHtml = req.file.originalname.endsWith('.html') || req.file.originalname.endsWith('.htm');
      if (isHtml) {
        fs.moveSync(req.file.path, path.join(appDir, 'index.html'), { overwrite: true });
      } else {
        await execAsync(`unzip -o "${req.file.path}" -d "${appDir}"`);
        fs.removeSync(req.file.path);
        const entries = fs.readdirSync(appDir);
        if (entries.length === 1 && fs.statSync(path.join(appDir, entries[0])).isDirectory()) {
          const subDir = path.join(appDir, entries[0]);
          for (const entry of fs.readdirSync(subDir)) {
            fs.moveSync(path.join(subDir, entry), path.join(appDir, entry), { overwrite: true });
          }
          fs.removeSync(subDir);
        }
      }

      if (dbBackup) fs.writeFileSync(dbPath, dbBackup);

      if (appEntry.type === 'node' || appEntry.type === 'react') {
        if (fs.existsSync(path.join(appDir, 'package.json'))) {
          await execAsync(`cd "${appDir}" && npm install --production`, { timeout: 120000 });
        }
      } else if (appEntry.type === 'python') {
        if (fs.existsSync(path.join(appDir, 'requirements.txt'))) {
          const venv = path.join(appDir, 'venv');
          await execAsync(`python3 -m venv "${venv}" && "${venv}/bin/pip" install -r "${path.join(appDir, 'requirements.txt')}"`, { timeout: 120000 });
        }
      }
      appEntry.version = (appEntry.version || 1) + 1;
    }

    appEntry.updatedAt = new Date().toISOString();
    saveRegistry(registry);
    await startApp(req.params.id, appEntry);

    res.json({ id: req.params.id, ...registry.apps[req.params.id], message: 'App updated!' });
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: Delete ---
app.delete('/api/apps/:id', async (req, res) => {
  try {
    const registry = loadRegistry();
    const appEntry = registry.apps[req.params.id];
    if (!appEntry) return res.status(404).json({ error: 'App not found' });

    await stopApp(req.params.id);
    if (appEntry.dbType === 'postgres' && appEntry.dbInfo) {
      try { await execAsync(`su -c "dropdb ${appEntry.dbInfo.name}" postgres 2>/dev/null || true`); } catch {}
    }
    fs.removeSync(path.join(APPS_DIR, req.params.id));
    delete registry.apps[req.params.id];
    saveRegistry(registry);
    res.json({ message: 'App deleted' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- API: Start/Stop/Restart ---
app.post('/api/apps/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const registry = loadRegistry();
  const appEntry = registry.apps[id];
  if (!appEntry) return res.status(404).json({ error: 'App not found' });

  try {
    if (action === 'start') await startApp(id, appEntry);
    else if (action === 'stop') await stopApp(id);
    else if (action === 'restart') { await stopApp(id); await startApp(id, appEntry); }
    else return res.status(400).json({ error: 'Invalid action' });

    res.json({ id, ...loadRegistry().apps[id] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- API: Logs ---
app.get('/api/apps/:id/logs', (req, res) => {
  const logFile = path.join(LOG_DIR, `${req.params.id}.log`);
  if (!fs.existsSync(logFile)) return res.json({ logs: 'No logs available' });
  const lines = fs.readFileSync(logFile, 'utf-8').split('\n').slice(-200).join('\n');
  res.json({ logs: lines });
});

// --- API: File Manager ---
app.get('/api/apps/:id/files', (req, res) => {
  const registry = loadRegistry();
  if (!registry.apps[req.params.id]) return res.status(404).json({ error: 'App not found' });
  const appDir = path.join(APPS_DIR, req.params.id);
  if (!fs.existsSync(appDir)) return res.json({ files: [] });

  function buildTree(dir, base = '') {
    const result = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'venv', '__pycache__', '.git', '.cache'].includes(entry.name)) continue;
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result.push({ name: entry.name, path: rel, type: 'dir', children: buildTree(path.join(dir, entry.name), rel) });
      } else {
        const stat = fs.statSync(path.join(dir, entry.name));
        result.push({ name: entry.name, path: rel, type: 'file', size: stat.size, ext: path.extname(entry.name).slice(1) });
      }
    }
    return result.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
  }
  res.json({ files: buildTree(appDir) });
});

app.get('/api/apps/:id/files/*', (req, res) => {
  const registry = loadRegistry();
  if (!registry.apps[req.params.id]) return res.status(404).json({ error: 'App not found' });
  const fp = req.params[0];
  if (fp.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  const full = path.join(APPS_DIR, req.params.id, fp);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(full);
  if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
  const ext = path.extname(fp).toLowerCase();
  const textExts = ['.html','.htm','.css','.js','.jsx','.ts','.tsx','.json','.md','.txt','.py','.rb','.php','.xml','.svg','.yml','.yaml','.toml','.ini','.cfg','.conf','.sh','.bash','.env','.gitignore','.sql','.csv','.log','.map'];
  if (!textExts.includes(ext) && stat.size > 1024 * 1024) return res.json({ content: null, binary: true, size: stat.size });
  try { res.json({ content: fs.readFileSync(full, 'utf-8'), size: stat.size, ext: ext.slice(1) }); }
  catch { res.json({ content: null, binary: true, size: stat.size }); }
});

app.put('/api/apps/:id/files/*', (req, res) => {
  const registry = loadRegistry();
  if (!registry.apps[req.params.id]) return res.status(404).json({ error: 'App not found' });
  const fp = req.params[0];
  if (fp.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'Content required' });
  try {
    const full = path.join(APPS_DIR, req.params.id, fp);
    fs.ensureDirSync(path.dirname(full));
    fs.writeFileSync(full, content, 'utf-8');
    res.json({ message: 'File saved', size: Buffer.byteLength(content) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/apps/:id/files', (req, res) => {
  const registry = loadRegistry();
  if (!registry.apps[req.params.id]) return res.status(404).json({ error: 'App not found' });
  const { filePath, content = '' } = req.body;
  if (!filePath) return res.status(400).json({ error: 'File path required' });
  if (filePath.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  const full = path.join(APPS_DIR, req.params.id, filePath);
  if (fs.existsSync(full)) return res.status(409).json({ error: 'File already exists' });
  try {
    fs.ensureDirSync(path.dirname(full));
    fs.writeFileSync(full, content, 'utf-8');
    res.json({ message: 'File created', path: filePath });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/apps/:id/files/*', (req, res) => {
  const registry = loadRegistry();
  if (!registry.apps[req.params.id]) return res.status(404).json({ error: 'App not found' });
  const fp = req.params[0];
  if (fp.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  const full = path.join(APPS_DIR, req.params.id, fp);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });
  try { fs.removeSync(full); res.json({ message: 'File deleted' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Process Management ---
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
    const dir = appEntry.type === 'react'
      ? (fs.existsSync(path.join(appDir, 'build')) ? path.join(appDir, 'build') : fs.existsSync(path.join(appDir, 'dist')) ? path.join(appDir, 'dist') : appDir)
      : appDir;
    proc = spawn('npx', ['serve', '-s', dir, '-l', String(appEntry.port), '--no-clipboard'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } else if (appEntry.type === 'node') {
    let entry = 'server.js';
    if (fs.existsSync(path.join(appDir, 'package.json'))) {
      const pkg = fs.readJsonSync(path.join(appDir, 'package.json'));
      if (pkg.main) entry = pkg.main;
      if (pkg.scripts && pkg.scripts.start) { proc = spawn('npm', ['start'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    }
    if (!proc) {
      if (fs.existsSync(path.join(appDir, 'index.js'))) entry = 'index.js';
      if (fs.existsSync(path.join(appDir, 'app.js'))) entry = 'app.js';
      proc = spawn('node', [entry], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    }
  } else if (appEntry.type === 'python') {
    let entry = 'app.py';
    if (fs.existsSync(path.join(appDir, 'main.py'))) entry = 'main.py';
    if (fs.existsSync(path.join(appDir, 'server.py'))) entry = 'server.py';
    const py = fs.existsSync(path.join(appDir, 'venv', 'bin', 'python')) ? path.join(appDir, 'venv', 'bin', 'python') : 'python3';
    proc = spawn(py, [entry], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  if (proc) {
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);
    proc.on('exit', (code) => {
      logStream.write(`\n[PI-PAAS] Process exited with code ${code}\n`);
      const reg = loadRegistry();
      if (reg.apps[id]) { reg.apps[id].status = 'stopped'; saveRegistry(reg); }
      delete runningProcesses[id];
    });
    runningProcesses[id] = proc;
    const reg = loadRegistry();
    reg.apps[id].status = 'running';
    reg.apps[id].pid = proc.pid;
    saveRegistry(reg);
  }
}

async function stopApp(id) {
  if (runningProcesses[id]) {
    runningProcesses[id].kill('SIGTERM');
    await new Promise(r => setTimeout(r, 2000));
    if (runningProcesses[id] && !runningProcesses[id].killed) runningProcesses[id].kill('SIGKILL');
    delete runningProcesses[id];
  }
  const reg = loadRegistry();
  if (reg.apps[id] && reg.apps[id].pid) { try { process.kill(reg.apps[id].pid, 'SIGTERM'); } catch {} }
  if (reg.apps[id]) { reg.apps[id].status = 'stopped'; reg.apps[id].pid = null; saveRegistry(reg); }
}

function getServerIP() {
  const os = require('os');
  for (const [, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const i of ifaces) { if (i.family === 'IPv4' && !i.internal) return i.address; }
  }
  return 'localhost';
}

async function restoreApps() {
  const reg = loadRegistry();
  for (const [id, a] of Object.entries(reg.apps)) {
    if (a.status === 'running') {
      console.log(`Restoring: ${id}`);
      try { await startApp(id, a); } catch (e) { console.error(`Failed to restore ${id}:`, e.message); }
    }
  }
}

app.listen(PANEL_PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Pi-PaaS running at http://${getServerIP()}:${PANEL_PORT}\n`);
  restoreApps();
});
