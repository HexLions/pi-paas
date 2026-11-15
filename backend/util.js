'use strict';
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');

const APP_TYPES = ['static', 'node', 'python', 'react', 'php', 'deno', 'bun', 'binary', 'docker'];
const DB_TYPES = ['none', 'sqlite', 'postgres'];
const SCHEDULES = ['off', 'daily', 'weekly'];

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** App ids are used in paths and process names, so keep them boring. */
function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(id);
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/** PostgreSQL identifiers we create: lowercase, unquoted-safe, max 63 bytes. */
function isValidPgIdent(name) {
  return typeof name === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}

function isValidEnvKey(key) {
  return typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key);
}

/**
 * Join a user supplied relative path onto base and refuse anything that ends
 * up outside base, including through symlinks that already exist on disk.
 */
function safeResolve(base, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) throw new HttpError(400, 'Invalid path');
  const root = path.resolve(base);
  const target = path.resolve(root, rel.replace(/^[/\\]+/, ''));
  if (target !== root && !target.startsWith(root + path.sep)) throw new HttpError(400, 'Invalid path');
  // Walk up to the deepest existing ancestor and check where it really points.
  let probe = target;
  while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
  const realRoot = fs.realpathSync(root);
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) throw new HttpError(400, 'Invalid path');
  return target;
}

/**
 * Run a program without a shell. Resolves { stdout, stderr }; rejects with an
 * Error carrying the tail of the output. Never builds a command string.
 */
function run(cmd, args, opts = {}) {
  const { input, timeout = 0, onOutput, stdoutFile, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...spawnOpts });
    // Large outputs (database dumps) go straight to a file instead of memory.
    const sink = stdoutFile ? fs.createWriteStream(stdoutFile) : null;
    if (sink) child.stdout.pipe(sink);
    let stdout = '';
    let stderr = '';
    let timer = null;
    const cap = (s) => (s.length > 200000 ? s.slice(-200000) : s);
    if (!sink) child.stdout.on('data', (d) => { stdout = cap(stdout + d); if (onOutput) onOutput(d); });
    child.stderr.on('data', (d) => { stderr = cap(stderr + d); if (onOutput) onOutput(d); });
    if (timeout) {
      timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
    }
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      if (sink) await new Promise((r) => (sink.writableFinished ? r() : sink.on('finish', r)));
      if (code === 0) return resolve({ stdout, stderr });
      const why = signal ? `killed by ${signal}${signal === 'SIGKILL' && timeout ? ' (timeout)' : ''}` : `exit code ${code}`;
      const tail = (stderr || stdout).trim().split('\n').slice(-5).join('\n');
      const err = new Error(`${path.basename(cmd)} failed (${why})${tail ? `: ${tail}` : ''}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function commandExists(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  return dirs.some((d) => {
    try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; }
  });
}

/** Read at most maxBytes from the end of a file. */
async function tailFile(file, maxBytes) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally {
    await fh.close();
  }
}

/** True when the first bytes contain a NUL, the usual binary heuristic. */
function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

async function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

module.exports = {
  APP_TYPES,
  DB_TYPES,
  SCHEDULES,
  HttpError,
  isValidId,
  slugify,
  isValidPgIdent,
  isValidEnvKey,
  safeResolve,
  run,
  commandExists,
  tailFile,
  looksBinary,
  writeFileAtomic,
};
