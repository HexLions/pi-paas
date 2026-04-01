const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { exec, spawn } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const app = express();
const PANEL_PORT = 9000;
// App data lives OUTSIDE the pi-paas code directory — safe from updates
const APPS_DIR = '/root/pi-paas-data/apps';
const DATA_DIR = '/root/pi-paas-data';
const DB_FILE = path.join(DATA_DIR, 'registry.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const NGINX_SITES = '/etc/nginx/sites-enabled';
const PORT_RANGE_START = 3001;
const PORT_RANGE_END = 3200;

// Ensure directories exist
fs.ensureDirSync(APPS_DIR);
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(LOG_DIR);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Multer for ZIP and HTML uploads
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    const isZip = file.mimetype === 'application/zip' || file.originalname.endsWith('.zip');
    const isHtml = file.mimetype === 'text/html' || file.originalname.endsWith('.html') || file.originalname.endsWith('.htm');
    if (isZip || isHtml) {
      cb(null, true);
    } else {
      cb(new Error('Solo file .zip o .html ammessi'));
    }
  }
});

// --- Registry (simple JSON file) ---
function loadRegistry() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeJsonSync(DB_FILE, { apps: {} });
  }
  return fs.readJsonSync(DB_FILE);
}

function saveRegistry(data) {
  fs.writeJsonSync(DB_FILE, data, { spaces: 2 });
}

function findFreePort() {
  const registry = loadRegistry();
  const usedPorts = Object.values(registry.apps).map(a => a.port);
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!usedPorts.includes(p)) return p;
  }
  throw new Error('Nessuna porta disponibile');
}

// --- API Routes ---

// List all apps
app.get('/api/apps', (req, res) => {
  const registry = loadRegistry();
  const apps = Object.entries(registry.apps).map(([id, app]) => ({
    id,
    ...app,
    url: `http://${getServerIP()}:${app.port}`
  }));
  res.json(apps);
});

// Get single app details
app.get('/api/apps/:id', (req, res) => {
  const registry = loadRegistry();
  const app = registry.apps[req.params.id];
  if (!app) return res.status(404).json({ error: 'App non trovata' });
  res.json({ id: req.params.id, ...app });
});

// Deploy new app
app.post('/api/apps', upload.single('zipfile'), async (req, res) => {
  try {
    const { name, type, dbType } = req.body;
    if (!name || !type || !req.file) {
      return res.status(400).json({ error: 'Nome, tipo e file ZIP richiesti' });
    }

    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    const registry = loadRegistry();
    if (registry.apps[id]) {
      return res.status(409).json({ error: 'App con questo nome già esistente' });
    }

    const port = findFreePort();
    const appDir = path.join(APPS_DIR, id);
    fs.ensureDirSync(appDir);

    const isHtml = req.file.originalname.endsWith('.html') || req.file.originalname.endsWith('.htm');

    if (isHtml) {
      // Single HTML file — copy as index.html
      fs.moveSync(req.file.path, path.join(appDir, 'index.html'), { overwrite: true });
    } else {
      // Extract ZIP
      await execAsync(`unzip -o "${req.file.path}" -d "${appDir}"`);
      fs.removeSync(req.file.path);

      // Flatten if ZIP contains a single root folder
      const entries = fs.readdirSync(appDir);
      if (entries.length === 1 && fs.statSync(path.join(appDir, entries[0])).isDirectory()) {
        const subDir = path.join(appDir, entries[0]);
        const subEntries = fs.readdirSync(subDir);
        for (const entry of subEntries) {
          fs.moveSync(path.join(subDir, entry), path.join(appDir, entry), { overwrite: true });
        }
        fs.removeSync(subDir);
      }
    }

    // Setup database if needed
    let dbInfo = null;
    if (dbType === 'sqlite') {
      dbInfo = { type: 'sqlite', path: path.join(appDir, 'data.db') };
    } else if (dbType === 'postgres') {
      const dbName = `pipaas_${id.replace(/-/g, '_')}`;
      try {
        await execAsync(`su -c "createdb ${dbName}" postgres 2>/dev/null || true`);
        dbInfo = { type: 'postgres', name: dbName, url: `postgresql://localhost:5432/${dbName}` };
      } catch (e) {
        console.error('PostgreSQL setup error:', e.message);
        dbInfo = { type: 'postgres', name: dbName, url: `postgresql://localhost:5432/${dbName}`, warning: 'Verifica che PostgreSQL sia installato' };
      }
    }

    // Install dependencies based on type
    if (type === 'node' || type === 'react') {
      if (fs.existsSync(path.join(appDir, 'package.json'))) {
        await execAsync(`cd "${appDir}" && npm install --production`, { timeout: 120000 });
      }
      if (type === 'react' && fs.existsSync(path.join(appDir, 'package.json'))) {
        const pkg = fs.readJsonSync(path.join(appDir, 'package.json'));
        if (pkg.scripts && pkg.scripts.build) {
          await execAsync(`cd "${appDir}" && npm run build`, { timeout: 120000 });
        }
      }
    } else if (type === 'python') {
      if (fs.existsSync(path.join(appDir, 'requirements.txt'))) {
        const venvDir = path.join(appDir, 'venv');
        await execAsync(`python3 -m venv "${venvDir}" && "${venvDir}/bin/pip" install -r "${path.join(appDir, 'requirements.txt')}"`, { timeout: 120000 });
      }
    }

    // Register app
    const appEntry = {
      name,
      type,
      port,
      dbType: dbType || 'none',
      dbInfo,
      status: 'stopped',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };

    registry.apps[id] = appEntry;
    saveRegistry(registry);

    // Start the app
    await startApp(id, appEntry);

    res.json({ id, ...registry.apps[id], message: 'App deployata con successo!' });
  } catch (err) {
    console.error('Deploy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update app (upload new version)
app.put('/api/apps/:id', upload.single('zipfile'), async (req, res) => {
  try {
    const registry = loadRegistry();
    const appEntry = registry.apps[req.params.id];
    if (!appEntry) return res.status(404).json({ error: 'App non trovata' });

    // Stop current instance
    await stopApp(req.params.id);

    const appDir = path.join(APPS_DIR, req.params.id);

    if (req.file) {
      // Keep db files if sqlite
      let dbBackup = null;
      const dbPath = path.join(appDir, 'data.db');
      if (appEntry.dbType === 'sqlite' && fs.existsSync(dbPath)) {
        dbBackup = fs.readFileSync(dbPath);
      }

      // Clear and re-extract
      fs.emptyDirSync(appDir);

      const isHtml = req.file.originalname.endsWith('.html') || req.file.originalname.endsWith('.htm');

      if (isHtml) {
        fs.moveSync(req.file.path, path.join(appDir, 'index.html'), { overwrite: true });
      } else {
        await execAsync(`unzip -o "${req.file.path}" -d "${appDir}"`);
        fs.removeSync(req.file.path);

        // Flatten single root folder
        const entries = fs.readdirSync(appDir);
        if (entries.length === 1 && fs.statSync(path.join(appDir, entries[0])).isDirectory()) {
          const subDir = path.join(appDir, entries[0]);
          const subEntries = fs.readdirSync(subDir);
          for (const entry of subEntries) {
            fs.moveSync(path.join(subDir, entry), path.join(appDir, entry), { overwrite: true });
          }
          fs.removeSync(subDir);
        }
      }

      // Restore db
      if (dbBackup) {
        fs.writeFileSync(dbPath, dbBackup);
      }

      // Reinstall deps
      if (appEntry.type === 'node' || appEntry.type === 'react') {
        if (fs.existsSync(path.join(appDir, 'package.json'))) {
          await execAsync(`cd "${appDir}" && npm install --production`, { timeout: 120000 });
        }
      } else if (appEntry.type === 'python') {
        if (fs.existsSync(path.join(appDir, 'requirements.txt'))) {
          const venvDir = path.join(appDir, 'venv');
          await execAsync(`python3 -m venv "${venvDir}" && "${venvDir}/bin/pip" install -r "${path.join(appDir, 'requirements.txt')}"`, { timeout: 120000 });
        }
      }

      appEntry.version = (appEntry.version || 1) + 1;
    }

    appEntry.updatedAt = new Date().toISOString();
    saveRegistry(registry);

    // Restart
    await startApp(req.params.id, appEntry);

    res.json({ id: req.params.id, ...registry.apps[req.params.id], message: 'App aggiornata!' });
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete app
app.delete('/api/apps/:id', async (req, res) => {
  try {
    const registry = loadRegistry();
    const appEntry = registry.apps[req.params.id];
    if (!appEntry) return res.status(404).json({ error: 'App non trovata' });

    await stopApp(req.params.id);

    // Remove postgres db if exists
    if (appEntry.dbType === 'postgres' && appEntry.dbInfo) {
      try {
        await execAsync(`su -c "dropdb ${appEntry.dbInfo.name}" postgres 2>/dev/null || true`);
      } catch (e) { /* ignore */ }
    }

    // Remove files
    const appDir = path.join(APPS_DIR, req.params.id);
    fs.removeSync(appDir);

    delete registry.apps[req.params.id];
    saveRegistry(registry);

    res.json({ message: 'App eliminata' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start/Stop/Restart
app.post('/api/apps/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const registry = loadRegistry();
  const appEntry = registry.apps[id];
  if (!appEntry) return res.status(404).json({ error: 'App non trovata' });

  try {
    if (action === 'start') {
      await startApp(id, appEntry);
    } else if (action === 'stop') {
      await stopApp(id);
    } else if (action === 'restart') {
      await stopApp(id);
      await startApp(id, appEntry);
    } else {
      return res.status(400).json({ error: 'Azione non valida' });
    }

    const updated = loadRegistry();
    res.json({ id, ...updated.apps[id] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get app logs
app.get('/api/apps/:id/logs', async (req, res) => {
  const logFile = path.join(LOG_DIR, `${req.params.id}.log`);
  if (!fs.existsSync(logFile)) {
    return res.json({ logs: 'Nessun log disponibile' });
  }
  const logs = fs.readFileSync(logFile, 'utf-8');
  // Return last 200 lines
  const lines = logs.split('\n').slice(-200).join('\n');
  res.json({ logs: lines });
});

// --- File Manager API ---

// List files in app directory (recursive tree)
app.get('/api/apps/:id/files', (req, res) => {
  const registry = loadRegistry();
  if (!registry.apps[req.params.id]) return res.status(404).json({ error: 'App non trovata' });

  const appDir = path.join(APPS_DIR, req.params.id);
  if (!fs.existsSync(appDir)) return res.json({ files: [] });

  function buildTree(dir, basePath = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      // Skip node_modules, venv, __pycache__, .git
      if (['node_modules', 'venv', '__pycache__', '.git', '.cache'].includes(entry.name)) continue;

      const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result.push({
          name: entry.name,
          path: relativePath,
          type: 'dir',
          children: buildTree(path.join(dir, entry.name), relativePath)
        });
      } else {
        const stat = fs.statSync(path.join(dir, entry.name));
        result.push({
          name: entry.name,
          path: relativePath,
          type: 'file',
          size: stat.size,
          ext: path.extname(entry.name).slice(1)
        });
      }
    }
    // Sort: dirs first, then files
    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  res.json({ files: buildTree(appDir) });
});

// Read file content
app.get('/api/apps/:id/files/*', (req, res) => {
  const registry = loadRegistry();
  if (!registry.apps[req.params.id]) return res.status(404).json({ error: 'App non trovata' });

  const filePath = req.params[0];
  // Security: prevent path traversal
  if (filePath.includes('..')) return res.status(400).json({ error: 'Percorso non valido' });

  const fullPath = path.join(APPS_DIR, req.params.id, filePath);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File non trovato' });

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) return res.status(400).json({ error: 'È una directory' });

  // Check if binary
  const ext = path.extname(filePath).toLowerCase();
  const textExts = ['.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt',
    '.py', '.rb', '.php', '.xml', '.svg', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
    '.sh', '.bash', '.env', '.gitignore', '.sql', '.csv', '.log', '.map'];

  if (!textExts.includes(ext) && stat.size > 1024 * 1024) {
    return res.json({ content: null, binary: true, size: stat.size });
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    res.json({ content, size: stat.size, ext: ext.slice(1) });
  } catch (e) {
    res.json({ content: null, binary: true, size: stat.size });
  }
});

// Save file content
app.put('/api/apps/:id/files/*', (req, res) => {
  const registry = loadRegistry();
  if (!registry.apps[req.params.id]) return res.status(404).json({ error: 'App non trovata' });

  const filePath = req.params[0];
  if (filePath.includes('..')) return res.status(400).json({ error: 'Percorso non valido' });

  const fullPath = path.join(APPS_DIR, req.params.id, filePath);
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'Contenuto mancante' });

  try {
    fs.ensureDirSync(path.dirname(fullPath));
    fs.writeFileSync(fullPath, content, 'utf-8');
    res.json({ message: 'File salvato', size: Buffer.byteLength(content) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create new file
app.post('/api/apps/:id/files', (req, res) => {
  const registry = loadRegistry();
  if (!registry.apps[req.params.id]) return res.status(404).json({ error: 'App non trovata' });

  const { filePath, content = '' } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Percorso file richiesto' });
  if (filePath.includes('..')) return res.status(400).json({ error: 'Percorso non valido' });

  const fullPath = path.join(APPS_DIR, req.params.id, filePath);
  if (fs.existsSync(fullPath)) return res.status(409).json({ error: 'File già esistente' });

  try {
    fs.ensureDirSync(path.dirname(fullPath));
    fs.writeFileSync(fullPath, content, 'utf-8');
    res.json({ message: 'File creato', path: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete file
app.delete('/api/apps/:id/files/*', (req, res) => {
  const registry = loadRegistry();
  if (!registry.apps[req.params.id]) return res.status(404).json({ error: 'App non trovata' });

  const filePath = req.params[0];
  if (filePath.includes('..')) return res.status(400).json({ error: 'Percorso non valido' });

  const fullPath = path.join(APPS_DIR, req.params.id, filePath);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File non trovato' });

  try {
    fs.removeSync(fullPath);
    res.json({ message: 'File eliminato' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Process Management ---
const runningProcesses = {};

async function startApp(id, appEntry) {
  const appDir = path.join(APPS_DIR, id);
  const logDir = LOG_DIR;
  fs.ensureDirSync(logDir);
  const logFile = path.join(logDir, `${id}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const env = {
    ...process.env,
    PORT: String(appEntry.port),
    APP_PORT: String(appEntry.port),
    NODE_ENV: 'production'
  };

  // Add DB env vars
  if (appEntry.dbInfo) {
    if (appEntry.dbInfo.type === 'sqlite') {
      env.DATABASE_URL = `sqlite:${appEntry.dbInfo.path}`;
      env.SQLITE_PATH = appEntry.dbInfo.path;
    } else if (appEntry.dbInfo.type === 'postgres') {
      env.DATABASE_URL = appEntry.dbInfo.url;
      env.PGDATABASE = appEntry.dbInfo.name;
    }
  }

  let proc;

  if (appEntry.type === 'static' || appEntry.type === 'react') {
    // Serve with a simple static server
    const serveDir = appEntry.type === 'react'
      ? (fs.existsSync(path.join(appDir, 'build')) ? path.join(appDir, 'build') :
         fs.existsSync(path.join(appDir, 'dist')) ? path.join(appDir, 'dist') : appDir)
      : appDir;

    proc = spawn('npx', ['serve', '-s', serveDir, '-l', String(appEntry.port), '--no-clipboard'], {
      cwd: appDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } else if (appEntry.type === 'node') {
    // Find entry point
    let entryPoint = 'server.js';
    if (fs.existsSync(path.join(appDir, 'package.json'))) {
      const pkg = fs.readJsonSync(path.join(appDir, 'package.json'));
      if (pkg.main) entryPoint = pkg.main;
      if (pkg.scripts && pkg.scripts.start) {
        // Use npm start
        proc = spawn('npm', ['start'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      }
    }
    if (!proc) {
      if (fs.existsSync(path.join(appDir, 'index.js'))) entryPoint = 'index.js';
      if (fs.existsSync(path.join(appDir, 'app.js'))) entryPoint = 'app.js';
      proc = spawn('node', [entryPoint], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    }
  } else if (appEntry.type === 'python') {
    // Find entry point
    let entryPoint = 'app.py';
    if (fs.existsSync(path.join(appDir, 'main.py'))) entryPoint = 'main.py';
    if (fs.existsSync(path.join(appDir, 'server.py'))) entryPoint = 'server.py';

    const pythonBin = fs.existsSync(path.join(appDir, 'venv', 'bin', 'python'))
      ? path.join(appDir, 'venv', 'bin', 'python')
      : 'python3';

    proc = spawn(pythonBin, [entryPoint], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  if (proc) {
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);

    proc.on('exit', (code) => {
      logStream.write(`\n[PI-PAAS] Process exited with code ${code}\n`);
      const reg = loadRegistry();
      if (reg.apps[id]) {
        reg.apps[id].status = 'stopped';
        saveRegistry(reg);
      }
      delete runningProcesses[id];
    });

    runningProcesses[id] = proc;

    const registry = loadRegistry();
    registry.apps[id].status = 'running';
    registry.apps[id].pid = proc.pid;
    saveRegistry(registry);
  }
}

async function stopApp(id) {
  if (runningProcesses[id]) {
    runningProcesses[id].kill('SIGTERM');
    // Wait a bit for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (runningProcesses[id] && !runningProcesses[id].killed) {
      runningProcesses[id].kill('SIGKILL');
    }
    delete runningProcesses[id];
  }

  // Also try to kill by PID from registry
  const registry = loadRegistry();
  if (registry.apps[id] && registry.apps[id].pid) {
    try {
      process.kill(registry.apps[id].pid, 'SIGTERM');
    } catch (e) { /* process already dead */ }
  }

  if (registry.apps[id]) {
    registry.apps[id].status = 'stopped';
    registry.apps[id].pid = null;
    saveRegistry(registry);
  }
}

// --- Helpers ---
function getServerIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// --- Startup: restart previously running apps ---
async function restoreApps() {
  const registry = loadRegistry();
  for (const [id, appEntry] of Object.entries(registry.apps)) {
    if (appEntry.status === 'running') {
      console.log(`Restoring app: ${id}`);
      try {
        await startApp(id, appEntry);
      } catch (e) {
        console.error(`Failed to restore ${id}:`, e.message);
      }
    }
  }
}

// Start panel server
app.listen(PANEL_PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Pi-PaaS Panel running at http://${getServerIP()}:${PANEL_PORT}\n`);
  restoreApps();
});
