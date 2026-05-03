// Pi-PaaS Docker Edition — server.js
// Uses Docker Engine API (via dockerode) instead of native child_process

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { execSync, exec } = require('child_process');
const cron = require('node-cron');
const Docker = require('dockerode');
const archiver = require('archiver');

// ── Config ────────────────────────────────────────────────────────────────────
const PANEL_PORT    = parseInt(process.env.PANEL_PORT    || '9000');
const DATA_DIR      = process.env.DATA_DIR               || '/data';
const APPS_DIR      = path.join(DATA_DIR, 'apps');
const LOG_DIR       = path.join(DATA_DIR, 'logs');
const UPLOAD_DIR    = path.join(DATA_DIR, 'uploads');
const DB_FILE       = path.join(DATA_DIR, 'registry.json');
const PORT_RANGE_START = parseInt(process.env.PORT_RANGE_START || '3001');
const PORT_RANGE_END   = parseInt(process.env.PORT_RANGE_END   || '3200');
const DOCKER_NETWORK   = process.env.DOCKER_NETWORK || 'pi-paas-net';
const PANEL_LABEL   = 'com.hexlions.managed-by=pi-paas';

// ── Docker client (talks to host via mounted socket) ──────────────────────────
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ── Ensure directories ────────────────────────────────────────────────────────
[APPS_DIR, LOG_DIR, UPLOAD_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Registry (JSON db) ────────────────────────────────────────────────────────
function loadRegistry() {
  if (!fs.existsSync(DB_FILE)) return { apps: {} };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { apps: {} }; }
}
function saveRegistry(r) { fs.writeFileSync(DB_FILE, JSON.stringify(r, null, 2)); }

// ── Port management ───────────────────────────────────────────────────────────
function getUsedPorts() {
  const r = loadRegistry();
  return Object.values(r.apps).map(a => a.port).filter(Boolean);
}

async function findFreePort() {
  const used = getUsedPorts();
  // Also check ports actually in use on host via docker
  const containers = await docker.listContainers({ all: true, filters: { label: [PANEL_LABEL] } });
  const dockerPorts = containers.flatMap(c => (c.Ports || []).map(p => p.PublicPort)).filter(Boolean);
  const allUsed = new Set([...used, ...dockerPorts]);
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!allUsed.has(p)) return p;
  }
  throw new Error('No free ports available in range');
}

// ── Docker helpers ────────────────────────────────────────────────────────────
function containerName(appId) { return `pi-paas-app-${appId}`; }

async function getContainerStatus(appId) {
  try {
    const container = docker.getContainer(containerName(appId));
    const info = await container.inspect();
    return info.State.Running ? 'running' : 'stopped';
  } catch {
    return 'stopped';
  }
}

// Detect app type and pick base Docker image
function detectRuntime(appDir) {
  if (fs.existsSync(path.join(appDir, 'package.json'))) {
    // Check if it has a build script (React/Vue/etc)
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      if (pkg.scripts && pkg.scripts.build) return { runtime: 'node-build', image: 'node:20-alpine' };
    } catch {}
    return { runtime: 'node', image: 'node:20-alpine' };
  }
  if (fs.existsSync(path.join(appDir, 'requirements.txt')) ||
      fs.existsSync(path.join(appDir, 'app.py')) ||
      fs.existsSync(path.join(appDir, 'main.py'))) {
    return { runtime: 'python', image: 'python:3.11-alpine' };
  }
  if (fs.existsSync(path.join(appDir, 'index.html'))) {
    return { runtime: 'static', image: 'nginx:alpine' };
  }
  return { runtime: 'node', image: 'node:20-alpine' };
}

// Build a Dockerfile for the app if one doesn't exist
function ensureDockerfile(appDir, runtime, appPort) {
  const dockerfilePath = path.join(appDir, 'Dockerfile');
  if (fs.existsSync(dockerfilePath)) return; // User provided their own — use it

  let content = '';
  switch (runtime) {
    case 'node':
    case 'node-build':
      content = `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production 2>/dev/null || npm install
COPY . .
${runtime === 'node-build' ? 'RUN npm run build' : ''}
EXPOSE ${appPort}
ENV PORT=${appPort}
CMD ["sh", "-c", "node $(ls index.js server.js app.js main.js 2>/dev/null | head -1 || echo index.js)"]
`;
      break;
    case 'python':
      content = `FROM python:3.11-alpine
WORKDIR /app
RUN apk add --no-cache gcc musl-dev
COPY requirements.txt* ./
RUN pip install -r requirements.txt 2>/dev/null || true
COPY . .
EXPOSE ${appPort}
ENV PORT=${appPort}
CMD ["sh", "-c", "python $(ls app.py main.py server.py 2>/dev/null | head -1 || echo app.py)"]
`;
      break;
    case 'static':
      content = `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE ${appPort}
RUN sed -i 's/listen       80/listen       ${appPort}/g' /etc/nginx/conf.d/default.conf
CMD ["nginx", "-g", "daemon off;"]
`;
      break;
  }
  fs.writeFileSync(dockerfilePath, content);
}

async function startApp(id, appData) {
  const appDir = path.join(APPS_DIR, id);
  const port = appData.port;
  const name = containerName(id);

  // Remove old container if exists
  try {
    const old = docker.getContainer(name);
    await old.stop().catch(() => {});
    await old.remove().catch(() => {});
  } catch {}

  const { runtime } = detectRuntime(appDir);
  ensureDockerfile(appDir, runtime, port);

  // Build image
  console.log(`[pi-paas] Building image for ${id}...`);
  const imageTag = `pi-paas-img-${id}:latest`;

  await new Promise((resolve, reject) => {
    docker.buildImage({ context: appDir, src: fs.readdirSync(appDir) }, { t: imageTag }, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve(), (event) => {
        if (event.stream) process.stdout.write(event.stream);
      });
    });
  });

  // Env vars
  const envVars = [
    `PORT=${port}`,
    `APP_PORT=${port}`,
    ...(appData.env ? Object.entries(appData.env).map(([k, v]) => `${k}=${v}`) : [])
  ];

  // Create & start container
  const container = await docker.createContainer({
    name,
    Image: imageTag,
    Env: envVars,
    ExposedPorts: { [`${port}/tcp`]: {} },
    HostConfig: {
      PortBindings: { [`${port}/tcp`]: [{ HostPort: `${port}` }] },
      RestartPolicy: { Name: 'unless-stopped' },
      Binds: appData.db === 'sqlite' ? [`${appDir}/db:/app/db`] : []
    },
    Labels: {
      'com.hexlions.managed-by': 'pi-paas',
      'com.hexlions.app-id': id,
      'com.hexlions.app-name': appData.name || id
    },
    NetworkingConfig: {
      EndpointsConfig: { [DOCKER_NETWORK]: {} }
    }
  });

  await container.start();
  console.log(`[pi-paas] Container started: ${name} on port ${port}`);
}

async function stopApp(id) {
  const name = containerName(id);
  try {
    const container = docker.getContainer(name);
    await container.stop({ t: 5 });
    console.log(`[pi-paas] Stopped: ${name}`);
  } catch (e) {
    if (!e.message.includes('not running') && !e.message.includes('No such container')) throw e;
  }
}

async function removeApp(id) {
  await stopApp(id);
  try {
    const container = docker.getContainer(containerName(id));
    await container.remove({ force: true });
  } catch {}
  // Remove image
  try {
    const image = docker.getImage(`pi-paas-img-${id}:latest`);
    await image.remove({ force: true });
  } catch {}
}

async function getAppLogs(id, lines = 100) {
  try {
    const container = docker.getContainer(containerName(id));
    const logsBuffer = await container.logs({ stdout: true, stderr: true, tail: lines, timestamps: true });
    // Docker multiplexes stdout/stderr — demux
    return demuxDockerLogs(logsBuffer);
  } catch {
    return '(no logs available)';
  }
}

function demuxDockerLogs(buffer) {
  const lines = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buffer.length) break;
    lines.push(buffer.slice(offset, offset + size).toString('utf8'));
    offset += size;
  }
  return lines.join('');
}

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const upload = multer({ dest: UPLOAD_DIR });

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', mode: 'docker' }));

// ── Apps CRUD ─────────────────────────────────────────────────────────────────
app.get('/api/apps', async (req, res) => {
  const r = loadRegistry();
  // Sync status from Docker
  for (const [id, appData] of Object.entries(r.apps)) {
    appData.status = await getContainerStatus(id);
  }
  saveRegistry(r);
  res.json(Object.entries(r.apps).map(([id, a]) => ({ id, ...a })));
});

app.post('/api/apps', upload.single('zip'), async (req, res) => {
  try {
    const { name, port: reqPort, runtime: reqRuntime, env } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    const r = loadRegistry();
    if (r.apps[id]) return res.status(409).json({ error: 'App already exists' });

    const port = reqPort ? parseInt(reqPort) : await findFreePort();
    const appDir = path.join(APPS_DIR, id);
    fs.mkdirSync(appDir, { recursive: true });

    // Extract zip if uploaded
    if (req.file) {
      const { default: extractZip } = await import('extract-zip');
      await extractZip(req.file.path, { dir: appDir });
      fs.unlinkSync(req.file.path);
    }

    const parsedEnv = {};
    if (env) {
      env.split('\n').forEach(line => {
        const [k, ...v] = line.split('=');
        if (k && v.length) parsedEnv[k.trim()] = v.join('=').trim();
      });
    }

    r.apps[id] = {
      name,
      port,
      status: 'stopped',
      runtime: reqRuntime || detectRuntime(appDir).runtime,
      env: parsedEnv,
      createdAt: new Date().toISOString()
    };
    saveRegistry(r);

    res.json({ id, ...r.apps[id] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/apps/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const r = loadRegistry();
    if (!r.apps[id]) return res.status(404).json({ error: 'Not found' });

    await removeApp(id);

    const appDir = path.join(APPS_DIR, id);
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true });

    delete r.apps[id];
    saveRegistry(r);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── App actions ───────────────────────────────────────────────────────────────
app.post('/api/apps/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    const r = loadRegistry();
    if (!r.apps[id]) return res.status(404).json({ error: 'Not found' });

    await startApp(id, r.apps[id]);
    r.apps[id].status = 'running';
    saveRegistry(r);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/apps/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;
    const r = loadRegistry();
    if (!r.apps[id]) return res.status(404).json({ error: 'Not found' });

    await stopApp(id);
    r.apps[id].status = 'stopped';
    saveRegistry(r);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/apps/:id/restart', async (req, res) => {
  try {
    const { id } = req.params;
    const r = loadRegistry();
    if (!r.apps[id]) return res.status(404).json({ error: 'Not found' });

    await stopApp(id);
    await startApp(id, r.apps[id]);
    r.apps[id].status = 'running';
    saveRegistry(r);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get('/api/apps/:id/logs', async (req, res) => {
  const { id } = req.params;
  const logs = await getAppLogs(id, parseInt(req.query.lines) || 100);
  res.json({ logs });
});

// ── File manager ──────────────────────────────────────────────────────────────
app.get('/api/apps/:id/files', (req, res) => {
  const appDir = path.join(APPS_DIR, req.params.id);
  const rel = req.query.path || '';
  const dir = path.join(appDir, rel);
  if (!dir.startsWith(appDir)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
  const entries = fs.readdirSync(dir).map(name => {
    const stat = fs.statSync(path.join(dir, name));
    return { name, isDir: stat.isDirectory(), size: stat.size, mtime: stat.mtime };
  });
  res.json(entries);
});

app.get('/api/apps/:id/file', (req, res) => {
  const appDir = path.join(APPS_DIR, req.params.id);
  const file = path.join(appDir, req.query.path || '');
  if (!file.startsWith(appDir)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  res.json({ content: fs.readFileSync(file, 'utf8') });
});

app.put('/api/apps/:id/file', (req, res) => {
  const appDir = path.join(APPS_DIR, req.params.id);
  const file = path.join(appDir, req.body.path || '');
  if (!file.startsWith(appDir)) return res.status(403).json({ error: 'Forbidden' });
  fs.writeFileSync(file, req.body.content || '');
  res.json({ ok: true });
});

app.delete('/api/apps/:id/file', (req, res) => {
  const appDir = path.join(APPS_DIR, req.params.id);
  const file = path.join(appDir, req.query.path || '');
  if (!file.startsWith(appDir)) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  fs.rmSync(file, { recursive: true });
  res.json({ ok: true });
});

// ── Backup ────────────────────────────────────────────────────────────────────
app.post('/api/apps/:id/backup', async (req, res) => {
  const { id } = req.params;
  const appDir = path.join(APPS_DIR, id);
  if (!fs.existsSync(appDir)) return res.status(404).json({ error: 'Not found' });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(DATA_DIR, 'backups', id);
  fs.mkdirSync(backupDir, { recursive: true });
  const outPath = path.join(backupDir, `${id}-${timestamp}.zip`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(appDir, false);
    archive.finalize();
  });

  res.json({ file: path.basename(outPath), path: outPath });
});

app.get('/api/apps/:id/backups', (req, res) => {
  const backupDir = path.join(DATA_DIR, 'backups', req.params.id);
  if (!fs.existsSync(backupDir)) return res.json([]);
  const files = fs.readdirSync(backupDir)
    .filter(f => f.endsWith('.zip'))
    .map(f => {
      const stat = fs.statSync(path.join(backupDir, f));
      return { name: f, size: stat.size, date: stat.mtime };
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(files);
});

// ── Port check ────────────────────────────────────────────────────────────────
app.get('/api/ports/check', async (req, res) => {
  const port = parseInt(req.query.port);
  const used = getUsedPorts();
  res.json({ available: !used.includes(port) });
});

// ── Docker info (bonus endpoint) ──────────────────────────────────────────────
app.get('/api/docker/info', async (req, res) => {
  try {
    const info = await docker.info();
    res.json({ containers: info.Containers, running: info.ContainersRunning, version: info.ServerVersion });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function ensureDockerNetwork() {
  try {
    const networks = await docker.listNetworks({ filters: { name: [DOCKER_NETWORK] } });
    if (!networks.length) {
      await docker.createNetwork({ Name: DOCKER_NETWORK, Driver: 'bridge' });
      console.log(`[pi-paas] Created Docker network: ${DOCKER_NETWORK}`);
    }
  } catch (e) {
    console.warn('[pi-paas] Could not ensure Docker network:', e.message);
  }
}

async function syncContainerStatuses() {
  const r = loadRegistry();
  for (const [id, appData] of Object.entries(r.apps)) {
    appData.status = await getContainerStatus(id);
  }
  saveRegistry(r);
  console.log('[pi-paas] Container statuses synced');
}

function getServerIP() {
  const os = require('os');
  for (const [, ii] of Object.entries(os.networkInterfaces())) {
    for (const i of ii) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

app.listen(PANEL_PORT, '0.0.0.0', async () => {
  console.log(`\n🐳 Pi-PaaS Docker Edition`);
  console.log(`   Panel: http://${getServerIP()}:${PANEL_PORT}`);
  console.log(`   Mode: Docker (${DOCKER_NETWORK})\n`);
  await ensureDockerNetwork();
  await syncContainerStatuses();
});
