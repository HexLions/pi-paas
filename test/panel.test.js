'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs-extra');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { startPanel, tmpDir, waitFor } = require('./helpers');
const push = require('../backend/push');
const { Updater, compareVersions } = require('../backend/updater');
const { Settings } = require('../backend/settings');

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

/** The browser side of RFC 8291, written from the RFC, to check our encryption. */
function decrypt(body, ua, authSecret) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const ecdhSecret = ua.computeSecret(asPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return plain.subarray(0, -1).toString();
}

describe('web push', () => {
  it('encrypts payloads the way a browser decrypts them (RFC 8291)', () => {
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const body = push.encrypt('{"title":"hi"}', ua.getPublicKey().toString('base64url'), auth.toString('base64url'));
    assert.equal(decrypt(body, ua, auth), '{"title":"hi"}');
  });

  it('signs a valid VAPID token (RFC 8292)', async () => {
    const d = await tmpDir();
    const p = new push.Push({ pushFile: path.join(d, 'push.json') }).load();
    const h = push.vapidHeader('https://push.example.net/send/abc', p.state.keys, 'mailto:a@example.com');
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
    const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
    assert.equal(claims.aud, 'https://push.example.net');
    assert.ok(claims.exp > Date.now() / 1000);
    const raw = Buffer.from(m[4], 'base64url');
    const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
    assert.equal((await fs.stat(path.join(d, 'push.json'))).mode & 0o777, 0o600);
    await fs.remove(d);
  });

  it('drops subscriptions the push service no longer knows', async () => {
    const d = await tmpDir();
    const p = new push.Push({ pushFile: path.join(d, 'push.json') }).load();
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const sub = { endpoint: 'https://push.example.net/x', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
    assert.throws(() => p.subscribe({ endpoint: 'http://insecure', keys: sub.keys }, 'admin'), /Invalid/);
    p.subscribe(sub, 'admin');
    const real = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 410 });
    try {
      await assert.rejects(p.send('t', 'b'), /No push service accepted/);
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(p.count(), 0);
    await fs.remove(d);
  });
});

describe('panel updates', () => {
  let gh;
  let ghPort;
  let tarball;
  let release = { tag_name: 'v99.0.0', html_url: 'https://example.com/r', body: 'Notes', published_at: '2026-11-01T00:00:00Z' };
  before(async () => {
    const src = await tmpDir();
    await fs.outputFile(path.join(src, 'pi-paas-99.0.0/backend/server.js'), '// new');
    await fs.outputJson(path.join(src, 'pi-paas-99.0.0/package.json'), { name: 'pi-paas', version: '99.0.0' });
    tarball = path.join(src, 'release.tar.gz');
    execFileSync('tar', ['-czf', tarball, '-C', src, 'pi-paas-99.0.0']);
    gh = http.createServer((req, res) => {
      if (req.url.endsWith('/releases/latest')) return res.end(JSON.stringify(release));
      if (req.url.includes('/tar.gz/refs/tags/')) return fs.createReadStream(tarball).pipe(res);
      res.statusCode = 404;
      return res.end();
    });
    await new Promise((r) => gh.listen(0, '127.0.0.1', r));
    ghPort = gh.address().port;
    process.env.PIPAAS_UPDATE_API = `http://127.0.0.1:${ghPort}`;
    process.env.PIPAAS_UPDATE_DOWNLOAD = `http://127.0.0.1:${ghPort}`;
  });
  after(() => { gh.close(); delete process.env.PIPAAS_UPDATE_API; delete process.env.PIPAAS_UPDATE_DOWNLOAD; });

  const make = async (codeDir) => {
    const d = await tmpDir();
    const events = [];
    const u = new Updater({
      cfg: { version: '1.2.0' }, settings: new Settings(path.join(d, 's.json')).load(), notifier: { notify: (k, e) => events.push(e) }, log: { log() {}, error() {} }, codeDir,
    });
    u.events = events;
    return u;
  };

  it('compares versions', () => {
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
    assert.ok(compareVersions('v2.0.0', '2.0.0-rc.1') > 0);
    assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
    assert.ok(compareVersions('1.2.0', '1.3.0') < 0);
  });

  it('finds a newer release once and notifies about it', async () => {
    const u = await make(await tmpDir());
    const st = await u.check();
    assert.equal(st.available, true);
    assert.equal(st.latest.version, '99.0.0');
    await u.check();
    assert.equal(u.events.length, 1);
    assert.match(u.events[0].title, /99\.0\.0 is available/);
  });

  it('installs a release tarball next to the code and keeps the old one', async () => {
    const root = await tmpDir();
    const code = path.join(root, 'pi-paas');
    await fs.outputFile(path.join(code, 'backend/server.js'), '// old');
    const u = await make(code);
    let exited = false;
    u.exit = () => { exited = true; };
    await u.check();
    assert.equal(u.mode(), 'tarball');
    u.apply();
    await u.running;
    assert.equal(u.state, 'restarting', u.status().output);
    assert.equal(await fs.readFile(path.join(code, 'backend/server.js'), 'utf8'), '// new');
    assert.equal(await fs.readFile(path.join(`${code}.previous`, 'backend/server.js'), 'utf8'), '// old');
    await waitFor(() => exited, { timeout: 4000 });
  });

  it('refuses to update a git checkout with local changes', async () => {
    const code = await tmpDir();
    execFileSync('git', ['init', '-q'], { cwd: code });
    await fs.writeFile(path.join(code, 'a.txt'), 'x');
    execFileSync('git', ['add', '.'], { cwd: code });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'x'], { cwd: code });
    await fs.writeFile(path.join(code, 'a.txt'), 'changed');
    const u = await make(code);
    await u.check();
    assert.equal(u.mode(), 'git');
    u.apply();
    await u.running;
    assert.equal(u.state, 'failed');
    assert.match(u.error, /local changes/);
  });

  it('serves update status and push keys to the right roles', async () => {
    release = { ...release, tag_name: 'v0.1.0' };
    const p = await startPanel({ PIPAAS_PORT_RANGE: '39800-39810' });
    try {
      await p.login();
      const check = (await p.req('POST', '/api/panel/update/check')).data;
      assert.equal(check.available, false);
      assert.equal((await p.req('POST', '/api/panel/update')).status, 400);
      assert.match((await p.req('GET', '/api/push/key')).data.publicKey, /^[A-Za-z0-9_-]{80,}$/);
      await p.req('POST', '/api/users', { json: { username: 'v', password: 'viewer-pw1', role: 'viewer' } });
      p.setCookie('');
      await p.req('POST', '/api/auth/login', { json: { username: 'v', password: 'viewer-pw1' } });
      assert.equal((await p.req('GET', '/api/panel/update')).status, 403);
      assert.equal((await p.req('GET', '/api/push/key')).status, 200);
    } finally {
      await p.close();
    }
  });
});
