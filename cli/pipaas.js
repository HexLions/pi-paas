#!/usr/bin/env node
'use strict';
// pipaas: deploy and manage Pi-PaaS apps from your computer.
// One file, no dependencies, Node 18+. Get it from your panel:
//   curl -o pipaas http://<pi>:9000/cli/pipaas.js && chmod +x pipaas
//
//   pipaas login http://raspberrypi.local:9000      (paste an API token from Settings)
//   pipaas deploy [folder] [--name my-app] [--type node] [--port 3005] [--db sqlite]
//   pipaas apps | status <app> | logs <app> [-f]
//   pipaas start|stop|restart|pull <app>
//   pipaas rollback <app> [version]
// PIPAAS_URL and PIPAAS_TOKEN override the saved login.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pipaas.json');
const SKIP = new Set(['node_modules', '.git', 'venv', '.venv', '__pycache__', '.DS_Store', '.cache', '.next', '.pytest_cache', '.idea', '.vscode']);
const MAX_ZIP = 95 * 1024 * 1024;

function die(msg, code = 1) {
  process.stderr.write(`pipaas: ${msg}\n`);
  process.exit(code);
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* not logged in yet */ }
  const url = (process.env.PIPAAS_URL || cfg.url || '').replace(/\/+$/, '');
  const token = process.env.PIPAAS_TOKEN || cfg.token || '';
  return { url, token };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-f' || a === '--follow') out.follow = true;
    else if (a === '--include-env') out.includeEnv = true;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v !== undefined ? v : argv[++i];
    } else out._.push(a);
  }
  return out;
}

async function api(cfg, method, url, { json, form } = {}) {
  if (!cfg.url || !cfg.token) die('not logged in: run "pipaas login <panel url>" first');
  const headers = { Authorization: `Bearer ${cfg.token}` };
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  let res;
  try {
    res = await fetch(`${cfg.url}${url}`, { method, headers, body });
  } catch (err) {
    die(`cannot reach ${cfg.url}: ${err.cause ? err.cause.code || err.cause.message : err.message}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) die(`${res.status} ${data && data.error ? data.error : text.slice(0, 200)}`);
  return data;
}

// ---------- zip (deflate) ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf);
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(root, includeEnv) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      if (!includeEnv && /^\.env(\..*)?$/.test(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) out.push({ rel: r, full, mode: fs.statSync(full).mode });
    }
  };
  walk(root, '');
  return out;
}

function zipFolder(root, includeEnv) {
  const files = listFiles(root, includeEnv);
  if (!files.length) die(`${root} is empty`);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const name = Buffer.from(f.rel);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((0o100000 | (f.mode & 0o777)) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
    if (offset > MAX_ZIP) die('the folder is too large to upload (over 95 MB after compression); check what is in it');
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return { buf: Buffer.concat([...parts, cd, end]), count: files.length };
}

/** Guess the app type from the files in the folder. */
function detectType(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('Dockerfile') && !has('package.json') && !has('requirements.txt')) return 'docker';
  if (has('deno.json') || has('deno.jsonc')) return 'deno';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* ignore */ }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (pkg.scripts && pkg.scripts.build && (deps.vite || deps['react-scripts'] || deps['@vue/cli-service'] || deps.astro)) return 'react';
    return 'node';
  }
  if (has('server.js') || has('app.js') || has('index.js') || has('main.js')) return 'node';
  if (has('requirements.txt') || has('app.py') || has('main.py')) return 'python';
  if (has('composer.json') || has('index.php') || has('public/index.php')) return 'php';
  if (has('index.html')) return 'static';
  return null;
}

function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Print new log lines until the app's background job has finished. */
async function follow(cfg, id) {
  let seen = '';
  for (;;) {
    const [a, l] = await Promise.all([api(cfg, 'GET', `/api/apps/${id}`), api(cfg, 'GET', `/api/apps/${id}/logs`)]);
    const logs = l.logs || '';
    const fresh = logs.startsWith(seen) ? logs.slice(seen.length) : logs.slice(logs.lastIndexOf('\n', logs.length - 2) + 1);
    if (fresh) process.stdout.write(fresh);
    seen = logs;
    if (!a.task) return a;
    await sleep(1500);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const cfg = loadConfig();

  switch (cmd) {
    case 'login': {
      const url = (args._[0] || '').replace(/\/+$/, '');
      if (!/^https?:\/\//.test(url)) die('usage: pipaas login http://<pi>:9000');
      let token = process.env.PIPAAS_TOKEN || args.token;
      if (!token) {
        console.log(`Create a token in the panel: ${url} → Settings → API tokens`);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        token = await new Promise((r) => rl.question('Token: ', (a) => { rl.close(); r(a.trim()); }));
      }
      const st = await api({ url, token }, 'GET', '/api/auth/status');
      if (!st.authenticated) die('the panel did not accept this token');
      fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
      fs.writeFileSync(CONFIG, JSON.stringify({ url, token }, null, 2), { mode: 0o600 });
      console.log(`Logged in to ${url} as ${st.user.name} (${st.user.role}). Saved in ${CONFIG}`);
      return;
    }
    case 'apps': {
      const apps = await api(cfg, 'GET', '/api/apps');
      if (!apps.length) return console.log('No apps yet. Deploy one with: pipaas deploy <folder>');
      const w = Math.max(...apps.map((a) => a.id.length), 4);
      for (const a of apps) console.log(`${a.id.padEnd(w)}  ${a.status.padEnd(10)}  ${String(a.port).padEnd(5)}  v${a.version}  ${a.url}`);
      return;
    }
    case 'status': {
      const a = await api(cfg, 'GET', `/api/apps/${need(args._[0], 'app')}`);
      console.log(JSON.stringify(a, null, 2));
      return;
    }
    case 'logs': {
      const id = need(args._[0], 'app');
      if (!args.follow) return process.stdout.write((await api(cfg, 'GET', `/api/apps/${id}/logs`)).logs || '');
      let seen = '';
      for (;;) {
        const logs = (await api(cfg, 'GET', `/api/apps/${id}/logs`)).logs || '';
        process.stdout.write(logs.startsWith(seen) ? logs.slice(seen.length) : logs);
        seen = logs;
        await sleep(2000);
      }
    }
    case 'start': case 'stop': case 'restart': {
      const a = await api(cfg, 'POST', `/api/apps/${need(args._[0], 'app')}/${cmd}`);
      return console.log(`${a.name}: ${a.status}`);
    }
    case 'pull': {
      const id = need(args._[0], 'app');
      await api(cfg, 'POST', `/api/apps/${id}/pull`);
      return finish(await follow(cfg, id));
    }
    case 'rollback': {
      const id = need(args._[0], 'app');
      const rel = await api(cfg, 'GET', `/api/apps/${id}/releases`);
      if (!args._[1]) {
        if (!rel.length) return console.log('No previous versions are kept for this app.');
        for (const r of rel) console.log(`v${r.version}  replaced ${r.replacedAt}${r.source && r.source.commit ? `  ${r.source.commit.slice(0, 10)}` : ''}`);
        return console.log(`\nRoll back with: pipaas rollback ${id} <version>`);
      }
      await api(cfg, 'POST', `/api/apps/${id}/releases/${String(args._[1]).replace(/^v/, '')}/rollback`);
      return finish(await follow(cfg, id));
    }
    case 'deploy': {
      const dir = path.resolve(args._[0] || '.');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die(`${dir} is not a folder`);
      let pkgName = null;
      try { pkgName = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name; } catch { /* no package.json */ }
      const name = args.name || pkgName || path.basename(dir);
      const id = slug(name);
      const apps = await api(cfg, 'GET', '/api/apps');
      const existing = apps.find((a) => a.id === id);
      const { buf, count } = zipFolder(dir, args.includeEnv);
      console.log(`Packed ${count} ${count === 1 ? 'file' : 'files'} (${Math.max(1, Math.round(buf.length / 1024))} KB)${args.includeEnv ? '' : ', .env files left out'}`);
      const form = new FormData();
      if (args.port) form.append('port', String(args.port));
      if (existing) {
        form.append('zipfile', new Blob([buf]), `${id}.zip`);
        await api(cfg, 'PUT', `/api/apps/${id}`, { form });
        console.log(`Updating ${existing.name} (v${existing.version} → v${existing.version + 1})…`);
      } else {
        const type = args.type || detectType(dir);
        if (!type) die('cannot tell the app type: pass --type static|node|python|react|php|deno|bun|binary|docker');
        form.append('name', name);
        form.append('type', type);
        if (args.db) form.append('dbType', args.db);
        form.append('zipfile', new Blob([buf]), `${id}.zip`);
        await api(cfg, 'POST', '/api/apps', { form });
        console.log(`Deploying ${name} as a ${type} app…`);
      }
      return finish(await follow(cfg, id));
    }
    case undefined: case 'help': case '--help': case '-h': {
      const src = fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
      return console.log(src);
    }
    default:
      die(`unknown command "${cmd}" (try: pipaas help)`);
  }
}

function need(v, what) {
  if (!v) die(`which ${what}? (see: pipaas apps)`);
  return v;
}

function finish(a) {
  if (a.lastError) die(`${a.lastError.task} failed: ${a.lastError.message}`);
  console.log(`\n${a.name} is ${a.status} at ${a.url} (v${a.version})`);
  if (a.status !== 'running') process.exit(1);
}

main().catch((err) => die(err.stack || err.message));
