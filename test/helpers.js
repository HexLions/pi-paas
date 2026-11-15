'use strict';
// Test helpers: a tiny ZIP writer (stored, no compression) so tests can build
// hostile archives without external tools, and a panel started on port 0.
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{ name, data, mode }] where mode is a Unix mode such as 0o100644 or 0o120777 (symlink). */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data || '');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = e.mode || (e.name.endsWith('/') ? 0o40755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function tmpDir(prefix = 'pipaas-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const quietLog = { log() {}, warn() {}, error() {} };

/** Start a real panel on a random port with its own data folder. */
async function startPanel(extraEnv = {}) {
  const config = require('../backend/config');
  const { createPanel } = require('../backend/server');
  const dataDir = await tmpDir();
  const cfg = config.load({
    PIPAAS_DATA_DIR: dataDir,
    PIPAAS_PASSWORD: 'test-password',
    PIPAAS_PORT_RANGE: extraEnv.PIPAAS_PORT_RANGE || '39100-39199',
    PIPAAS_BUILD_TIMEOUT: '120',
    ...extraEnv,
  });
  const panel = await createPanel({ cfg, log: quietLog });
  const server = await new Promise((resolve) => {
    const s = panel.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  panel.cfg.port = server.address().port; // the proxy sends the panel's names here
  let cookie = '';

  async function req(method, url, { json, form, headers = {}, raw = false } = {}) {
    const h = { 'X-PiPaaS': '1', ...headers };
    if (cookie) h.Cookie = cookie;
    let body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const res = await fetch(base + url, { method, headers: h, body, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }

  async function login(password = 'test-password') {
    return req('POST', '/api/auth/login', { json: { password } });
  }

  async function close() {
    await panel.service.settle();
    if (panel.jobs) panel.jobs.stopAll();
    if (panel.monitor) panel.monitor.stop();
    if (panel.proxy) await panel.proxy.stop();
    if (panel.mdns) panel.mdns.stop();
    await panel.pm.stopAll();
    panel.backups.stopAll();
    await new Promise((r) => server.close(r));
    await fs.remove(dataDir);
  }

  return { ...panel, base, req, login, close, dataDir, setCookie: (c) => { cookie = c; }, cookie: () => cookie };
}

function zipForm(fields, filename, buf, field = 'zipfile') {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (buf) fd.append(field, new Blob([buf]), filename);
  return fd;
}

async function waitFor(fn, { timeout = 30000, interval = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

module.exports = { makeZip, crc32, tmpDir, startPanel, zipForm, waitFor, quietLog };
