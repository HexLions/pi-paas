'use strict';
// All runtime settings come from environment variables, so the code directory
// never has to be edited (the installer writes them into the service file).
const os = require('os');
const path = require('path');

const pkg = require('../package.json');

function int(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function portRange(raw) {
  const m = /^(\d+)-(\d+)$/.exec(raw || '3001-3200');
  if (!m) throw new Error(`PIPAAS_PORT_RANGE must look like 3001-3200, got "${raw}"`);
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start < 1024 || end > 65535 || start > end) throw new Error('PIPAAS_PORT_RANGE is out of bounds');
  return { start, end };
}

function load(env = process.env) {
  const dataDir = path.resolve(env.PIPAAS_DATA_DIR || path.join(os.homedir(), 'pi-paas-data'));
  const range = portRange(env.PIPAAS_PORT_RANGE);
  return {
    version: pkg.version,
    host: env.PIPAAS_HOST || '0.0.0.0',
    port: int(env, 'PIPAAS_PORT', 9000),
    publicHost: env.PIPAAS_PUBLIC_HOST || '',
    dataDir,
    appsDir: path.join(dataDir, 'apps'),
    volumesDir: path.join(dataDir, 'volumes'),
    uploadDir: path.join(dataDir, 'uploads'),
    logDir: path.join(dataDir, 'logs'),
    backupDir: path.join(dataDir, 'backups'),
    homeDir: path.join(dataDir, 'home'),
    registryFile: path.join(dataDir, 'registry.json'),
    authFile: path.join(dataDir, 'auth.json'),
    settingsFile: path.join(dataDir, 'settings.json'),
    initialPasswordFile: path.join(dataDir, 'initial-password.txt'),
    portStart: range.start,
    portEnd: range.end,
    maxBackups: int(env, 'PIPAAS_MAX_BACKUPS', 5),
    uploadLimitMb: int(env, 'PIPAAS_UPLOAD_LIMIT_MB', 100),
    buildTimeoutMs: int(env, 'PIPAAS_BUILD_TIMEOUT', 600) * 1000,
    maxLogBytes: int(env, 'PIPAAS_MAX_LOG_MB', 5) * 1024 * 1024,
    // Optional unprivileged user that runs builds and apps. Empty = same user as the panel.
    appUser: env.PIPAAS_APP_USER || '',
    // Only for setups that already put the panel behind their own login.
    authDisabled: env.PIPAAS_AUTH === 'off',
    initialPassword: env.PIPAAS_PASSWORD || '',
    trustProxy: env.PIPAAS_TRUST_PROXY === '1',
  };
}

module.exports = { load };
