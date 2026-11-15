'use strict';
// How each app type is built and started, and how resource limits are put
// around the command. Everything here returns argument arrays: no shell is
// involved except for a user's own custom start command.
const fs = require('fs-extra');
const path = require('path');
const { commandExists, isPlainFile } = require('./util');

const STATIC_SERVER = path.join(__dirname, 'static-server.js');

/** App types, with the program each one needs on the machine (null = always available). */
const RUNTIMES = {
  static: { needs: null },
  node: { needs: null },
  react: { needs: null },
  python: { needs: 'python3' },
  php: { needs: 'php' },
  deno: { needs: 'deno' },
  bun: { needs: 'bun' },
  binary: { needs: null },
  docker: { needs: 'docker' },
};

function availableRuntimes(cfg = null) {
  // Docker Edition: every type runs in a container, so only docker matters.
  if (cfg && cfg.containerMode) {
    const ok = commandExists('docker');
    return Object.fromEntries(Object.keys(RUNTIMES).map((type) => [type, ok]));
  }
  return Object.fromEntries(Object.entries(RUNTIMES).map(([type, r]) => [type, !r.needs || commandExists(r.needs)]));
}

function readJson(file) {
  try { return fs.readJsonSync(file); } catch { return null; }
}

/** Executable files at the top of the folder: candidates for a "binary" app. */
function findBinary(appDir) {
  // lstat: a symlink is never "the program" (root would chmod its target).
  for (const name of ['app', 'server', 'main', 'start']) {
    if (isPlainFile(path.join(appDir, name))) return name;
  }
  const execs = fs.readdirSync(appDir).filter((n) => {
    try {
      const st = fs.lstatSync(path.join(appDir, n));
      return st.isFile() && (st.mode & 0o111) && !/\.(sh|txt|md|json|ya?ml|toml|html?)$/i.test(n);
    } catch { return false; }
  });
  return execs.length === 1 ? execs[0] : null;
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function dockerName(id) {
  return `pipaas-${id}`;
}

/**
 * Work out how to start an app.
 * opts: { staticServer, id, cfg, env, runAs }
 * Returns { cmd, args, label, managesUser } where managesUser means the
 * command switches user itself (docker) and must be spawned as the panel user.
 */
function resolveCommand(appDir, app, opts = {}) {
  const staticServer = opts.staticServer || STATIC_SERVER;
  const has = (f) => fs.existsSync(path.join(appDir, f));
  if (app.type === 'docker') return dockerRun(appDir, app, opts);
  if (app.startCommand) return { cmd: '/bin/sh', args: ['-c', app.startCommand], label: app.startCommand };

  switch (app.type) {
    case 'static':
    case 'react': {
      let dir = appDir;
      if (app.type === 'react') dir = ['dist', 'build', 'out'].map((d) => path.join(appDir, d)).find((d) => fs.existsSync(d)) || appDir;
      return { cmd: process.execPath, args: [staticServer, dir, String(app.port), '--spa'], label: `static ${path.relative(appDir, dir) || '.'}` };
    }
    case 'node': {
      if (has('package.json')) {
        const pkg = readJson(path.join(appDir, 'package.json')) || {};
        if (pkg.scripts && pkg.scripts.start) return { cmd: 'npm', args: ['start', '--silent'], label: 'npm start' };
        if (pkg.main && has(pkg.main)) return { cmd: process.execPath, args: [pkg.main], label: `node ${pkg.main}` };
      }
      const entry = ['server.js', 'app.js', 'index.js', 'main.js', 'server.mjs', 'index.mjs'].find(has);
      if (!entry) throw new Error('No entry point found: add a "start" script to package.json or a server.js / app.js / index.js');
      return { cmd: process.execPath, args: [entry], label: `node ${entry}` };
    }
    case 'python': {
      const venvPy = path.join(appDir, 'venv', 'bin', 'python');
      const py = fs.existsSync(venvPy) ? venvPy : 'python3';
      const entry = ['server.py', 'main.py', 'app.py', 'wsgi.py'].find(has);
      if (!entry) throw new Error('No entry point found: add app.py, main.py or server.py');
      return { cmd: py, args: [entry], label: `python ${entry}` };
    }
    case 'php': {
      // PHP's built-in server: fine for small sites on a Pi.
      const root = ['public', 'web', 'htdocs'].map((d) => path.join(appDir, d)).find((d) => fs.existsSync(d)) || appDir;
      const args = ['-S', `0.0.0.0:${app.port}`, '-t', root];
      const router = ['router.php', 'index.php'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f) && path.basename(f) === 'router.php');
      if (router) args.push(router);
      return { cmd: 'php', args, label: `php -S (${path.relative(appDir, root) || '.'})` };
    }
    case 'deno': {
      const conf = readJson(path.join(appDir, 'deno.json')) || readJson(path.join(appDir, 'deno.jsonc')) || {};
      if (conf.tasks && conf.tasks.start) return { cmd: 'deno', args: ['task', 'start'], label: 'deno task start' };
      const entry = ['main.ts', 'server.ts', 'main.js', 'server.js', 'mod.ts', 'index.ts'].find(has);
      if (!entry) throw new Error('No entry point found: add main.ts / server.ts or a "start" task in deno.json');
      const dataDir = opts.cfg ? path.join(opts.cfg.volumesDir, opts.id) : appDir;
      return {
        cmd: 'deno',
        args: ['run', '--allow-net', '--allow-env', `--allow-read=${appDir},${dataDir}`, `--allow-write=${dataDir}`, entry],
        label: `deno run ${entry}`,
      };
    }
    case 'bun': {
      const pkg = readJson(path.join(appDir, 'package.json')) || {};
      if (pkg.scripts && pkg.scripts.start) return { cmd: 'bun', args: ['run', 'start'], label: 'bun run start' };
      const entry = ['index.ts', 'server.ts', 'index.js', 'server.js', 'app.ts'].find(has);
      if (!entry) throw new Error('No entry point found: add a "start" script or index.ts / server.ts');
      return { cmd: 'bun', args: [entry], label: `bun ${entry}` };
    }
    case 'binary': {
      const bin = findBinary(appDir);
      if (!bin) throw new Error('No program found: name it app, server or main, or set a custom start command');
      return { cmd: path.join(appDir, bin), args: [], label: `./${bin}` };
    }
    default:
      throw new Error(`Unknown app type "${app.type}"`);
  }
}

/**
 * docker run in the foreground, so the panel supervises it like any process.
 * Host networking keeps PORT and localhost PostgreSQL working unchanged.
 * Values of environment variables are passed through the environment of the
 * docker client (-e NAME), so they never show up in the process list.
 */
function dockerRun(appDir, app, { id, cfg, env = {}, runAs }) {
  const args = ['run', '--rm', '--name', dockerName(id), '--network', 'host', '--init'];
  const volume = path.join(cfg.volumesDir, id);
  args.push('-v', `${volume}:/data`);
  for (const k of Object.keys(env)) {
    if (['PATH', 'HOME', 'npm_config_cache', 'npm_config_update_notifier'].includes(k)) continue;
    args.push('-e', k);
  }
  if (runAs) args.push('--user', `${runAs.uid}:${runAs.gid}`);
  const lim = app.limits || {};
  if (lim.memoryMb) args.push('--memory', `${lim.memoryMb}m`);
  if (lim.cpuPercent) args.push('--cpus', (lim.cpuPercent / 100).toFixed(2));
  args.push(`${dockerName(id)}:latest`);
  if (app.startCommand) args.push('/bin/sh', '-c', app.startCommand);
  return { cmd: 'docker', args, label: `docker ${dockerName(id)}`, managesUser: true, dockerEnv: { DATA_DIR: '/data' } };
}

/** Rewrite paths in the environment for a container (the volume is /data inside). */
function dockerEnv(env, volume) {
  const out = { ...env, DATA_DIR: '/data' };
  for (const k of ['SQLITE_PATH']) if (out[k] && out[k].startsWith(volume)) out[k] = `/data${out[k].slice(volume.length)}`;
  if (out.DATABASE_URL && out.DATABASE_URL.startsWith(`sqlite:${volume}`)) out.DATABASE_URL = `sqlite:/data${out.DATABASE_URL.slice(7 + volume.length)}`;
  return out;
}

/**
 * Put resource limits around a command.
 * - With systemd and root: a transient scope with MemoryMax and CPUQuota
 *   (the cgroup also keeps every child of the app in the limit).
 * - Otherwise: nice for CPU priority, and a V8 heap cap for Node apps.
 * Returns { cmd, args, env, setsUser }.
 */
function applyLimits(command, app, { runAs = null, env = {}, systemd = null } = {}) {
  const lim = app.limits || {};
  const out = { cmd: command.cmd, args: [...command.args], env: { ...env }, setsUser: !!command.managesUser };
  if (app.type === 'docker') return out; // docker applies its own limits
  const useSystemd = systemd !== null ? systemd : (process.getuid && process.getuid() === 0 && commandExists('systemd-run') && fs.existsSync('/run/systemd/system'));
  if ((lim.memoryMb || lim.cpuPercent) && useSystemd) {
    const args = ['--scope', '--quiet', '--collect'];
    if (lim.memoryMb) args.push('-p', `MemoryMax=${lim.memoryMb}M`, '-p', 'MemorySwapMax=0');
    if (lim.cpuPercent) args.push('-p', `CPUQuota=${lim.cpuPercent}%`);
    if (runAs) args.push(`--uid=${runAs.uid}`, `--gid=${runAs.gid}`);
    out.args = [...args, '--', out.cmd, ...out.args];
    out.cmd = 'systemd-run';
    out.setsUser = true;
  } else if (lim.memoryMb && ['node', 'react'].includes(app.type)) {
    const heap = Math.max(32, Math.floor(lim.memoryMb * 0.75));
    out.env.NODE_OPTIONS = `${out.env.NODE_OPTIONS ? `${out.env.NODE_OPTIONS} ` : ''}--max-old-space-size=${heap}`;
  }
  if (lim.nice) {
    out.args = ['-n', String(lim.nice), out.cmd, ...out.args];
    out.cmd = 'nice';
  }
  return out;
}

function validateLimits(l) {
  const out = {};
  if (!l || typeof l !== 'object') return out;
  const num = (v, lo, hi, name) => {
    if (v === undefined || v === null || v === '' || v === 0) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw Object.assign(new Error(`${name} must be between ${lo} and ${hi}`), { status: 400 });
    return n;
  };
  const m = num(l.memoryMb, 32, 65536, 'Memory limit (MB)');
  const c = num(l.cpuPercent, 5, 1600, 'CPU limit (%)');
  const n = num(l.nice, 1, 19, 'Priority (nice)');
  if (m) out.memoryMb = m;
  if (c) out.cpuPercent = c;
  if (n) out.nice = n;
  return out;
}

/** Build steps for the newer runtimes (node/react/python live in build.js). */
function extraBuildSteps(appDir, app, id) {
  const has = (f) => fs.existsSync(path.join(appDir, f));
  const steps = [];
  if (app.type === 'php' && has('composer.json') && commandExists('composer')) steps.push(['composer', ['install', '--no-dev', '--no-interaction', '--optimize-autoloader']]);
  if (app.type === 'bun' && has('package.json')) steps.push(['bun', ['install', '--production']]);
  if (app.type === 'deno') {
    const entry = ['main.ts', 'server.ts', 'main.js', 'server.js', 'mod.ts', 'index.ts'].find(has);
    if (entry) steps.push(['deno', ['cache', entry]]);
  }
  if (app.type === 'docker') {
    let file = 'Dockerfile';
    if (app.sourceType) file = prepareContainerBuild(appDir, app);
    else if (!isPlainFile(path.join(appDir, 'Dockerfile'))) throw new Error('A Dockerfile (a regular file, not a link) is needed at the top of the project');
    steps.push(['docker', ['build', '--pull', '-f', file, '-t', `${dockerName(id)}:latest`, '.'], { asPanel: true }]);
  }
  return steps;
}

// ---------- container mode (PIPAAS_RUNTIME=docker) ----------

/** Shell that starts the first entry point found, shared by the generated images. */
const FIRST_OF = (cmd, files) => `for f in ${files.join(' ')}; do [ -f "$f" ] && exec ${cmd} "$f"; done; echo "No entry point found (${files.join(', ')})" >&2; exit 1`;

/**
 * A Dockerfile for an app that brought none, by type. The app listens on
 * $PORT (the container shares the host network); /data is its volume.
 * Images are the official multi-arch ones, so they run on a Pi (arm64).
 */
function generatedDockerfile(app) {
  const sh = (script) => `CMD ["sh", "-c", ${JSON.stringify(script)}]`;
  const staticCmd = (dirs) => sh(`d=.; for x in ${dirs}; do [ -d "$x" ] && d=$x && break; done; exec node .pipaas/static-server.js "$d" "$PORT" --spa`);
  switch (app.type) {
    case 'node':
      // COPY . . first: a glob that matches nothing (no package.json) would fail the build.
      return ['FROM node:22-alpine', 'WORKDIR /app', 'COPY . .',
        'RUN if [ -f package-lock.json ]; then npm ci --omit=dev; elif [ -f package.json ]; then npm install --omit=dev; fi',
        'ENV NODE_ENV=production',
        sh(`if [ -f package.json ] && grep -q '"start"' package.json; then exec npm start; fi; ${FIRST_OF('node', ['server.js', 'app.js', 'index.js', 'main.js'])}`)].join('\n');
    case 'react':
      return ['FROM node:22-alpine', 'WORKDIR /app', 'COPY . .',
        'RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi',
        'RUN if grep -q \'"build"\' package.json; then npm run build; fi', staticCmd('dist build out')].join('\n');
    case 'static':
      return ['FROM node:22-alpine', 'WORKDIR /app', 'COPY . .', staticCmd('.')].join('\n');
    case 'python':
      return ['FROM python:3.12-slim', 'WORKDIR /app', 'ENV PYTHONUNBUFFERED=1', 'COPY . .',
        'RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi',
        sh(FIRST_OF('python', ['server.py', 'main.py', 'app.py', 'wsgi.py']))].join('\n');
    case 'php':
      return ['FROM php:8.3-cli', 'WORKDIR /app', 'COPY . .',
        sh('r=.; for x in public web htdocs; do [ -d "$x" ] && r=$x && break; done; exec php -S "0.0.0.0:$PORT" -t "$r"')].join('\n');
    case 'deno':
      return ['FROM denoland/deno:alpine', 'WORKDIR /app', 'COPY . .',
        sh(`if [ -f deno.json ] && grep -q '"start"' deno.json; then exec deno task start; fi; ${FIRST_OF('deno run --allow-net --allow-env --allow-read --allow-write=/data', ['main.ts', 'server.ts', 'main.js', 'server.js', 'mod.ts', 'index.ts'])}`)].join('\n');
    case 'bun':
      return ['FROM oven/bun:1-alpine', 'WORKDIR /app', 'COPY . .', 'RUN if [ -f package.json ]; then bun install --production; fi',
        sh(`if [ -f package.json ] && grep -q '"start"' package.json; then exec bun run start; fi; ${FIRST_OF('bun', ['index.ts', 'server.ts', 'index.js', 'server.js', 'app.ts'])}`)].join('\n');
    case 'binary':
      return ['FROM debian:stable-slim', 'WORKDIR /app', 'COPY . .', 'RUN chmod +x app server main start 2>/dev/null || true',
        sh(FIRST_OF('', ['./app', './server', './main', './start']).replace('exec  ', 'exec '))].join('\n');
    default:
      throw new Error(`No container recipe for "${app.type}"`);
  }
}

/** In container mode every app runs as a container; its own type picks the image. */
function containerApp(app, cfg) {
  if (!cfg || !cfg.containerMode || app.type === 'docker') return app;
  return { ...app, type: 'docker', sourceType: app.type };
}

/** Write the generated Dockerfile (and the static server it may need) into the build folder. */
function prepareContainerBuild(appDir, app) {
  const own = path.join(appDir, 'Dockerfile');
  if (fs.existsSync(own) || isLink(own)) {
    if (!isPlainFile(own)) throw new Error('The Dockerfile must be a regular file, not a link');
    return 'Dockerfile';
  }
  // Start from a fresh folder: a .pipaas link from the repository must not be followed.
  const dir = path.join(appDir, '.pipaas');
  fs.removeSync(dir);
  fs.mkdirSync(dir);
  fs.copyFileSync(STATIC_SERVER, path.join(dir, 'static-server.js'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), `${generatedDockerfile({ type: app.sourceType || app.type })}\n`);
  return '.pipaas/Dockerfile';
}

module.exports = {
  generatedDockerfile, containerApp, prepareContainerBuild,
  RUNTIMES, STATIC_SERVER, availableRuntimes, resolveCommand, applyLimits, validateLimits, extraBuildSteps, dockerName, dockerEnv, findBinary,
};
