'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const { startPanel, tmpDir } = require('./helpers');
const auth = require('../backend/auth');
const config = require('../backend/config');

describe('TOTP', () => {
  it('matches the RFC 6238 test vector', () => {
    const secret = auth.base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(auth.totp(secret, 59 * 1000), '287082');
    assert.equal(auth.totp(secret, 1111111109 * 1000), '081804');
    assert.ok(auth.verifyTotp(secret, '287082', 59 * 1000));
    assert.equal(auth.verifyTotp(secret, '000000', 59 * 1000), false);
    assert.equal(auth.verifyTotp(secret, 'abc', 59 * 1000), false);
  });
});

describe('auth.json migration', () => {
  it('turns the v1.1 single password into the admin user', async () => {
    const dir = await tmpDir();
    const cfg = config.load({ PIPAAS_DATA_DIR: dir });
    const hash = auth.hashPassword('old-password');
    await fs.writeJson(cfg.authFile, { hash, secret: 'ab'.repeat(32) });
    const a = new auth.Auth(cfg, { warn() {} }).init();
    assert.ok(a.checkPassword('old-password', 'admin'));
    assert.equal(a.user('admin').role, 'admin');
    assert.equal((await fs.readJson(cfg.authFile)).version, 2);
    await fs.remove(dir);
  });
});

describe('accounts API', () => {
  let p;
  before(async () => { p = await startPanel({ PIPAAS_PORT_RANGE: '39300-39320' }); });
  after(async () => { await p.close(); });

  const as = async (user, password, code) => {
    p.setCookie('');
    return p.req('POST', '/api/auth/login', { json: { username: user, password, code } });
  };

  it('creates users and enforces roles', async () => {
    assert.equal((await p.login()).status, 200);
    assert.equal((await p.req('POST', '/api/users', { json: { username: 'vera', password: 'viewer-pass', role: 'viewer' } })).status, 201);
    assert.equal((await p.req('POST', '/api/users', { json: { username: 'olga', password: 'operator-pass', role: 'operator' } })).status, 201);
    assert.equal((await p.req('POST', '/api/users', { json: { username: 'Bad Name', password: 'whatever1', role: 'viewer' } })).status, 400);
    const list = (await p.req('GET', '/api/users')).data;
    assert.deepEqual(list.map((u) => u.name).sort(), ['admin', 'olga', 'vera']);

    assert.equal((await as('vera', 'viewer-pass')).status, 200);
    assert.equal((await p.req('GET', '/api/apps')).status, 200);
    assert.equal((await p.req('POST', '/api/apps/x/start')).status, 403);
    assert.equal((await p.req('GET', '/api/users')).status, 403);
    assert.equal((await p.req('GET', '/api/auth/status')).data.user.role, 'viewer');

    assert.equal((await as('olga', 'operator-pass')).status, 200);
    assert.equal((await p.req('POST', '/api/apps/x/start')).status, 404); // allowed, app just does not exist
    assert.equal((await p.req('DELETE', '/api/apps/x')).status, 403);
    assert.equal((await p.req('GET', '/api/settings')).status, 403);
  });

  it('never leaves the panel without an admin', async () => {
    await p.login();
    assert.equal((await p.req('DELETE', '/api/users/admin')).status, 400);
    assert.equal((await p.req('PUT', '/api/users/admin', { json: { role: 'viewer' } })).status, 400);
  });

  it('logs a user out everywhere when an admin changes them', async () => {
    await as('vera', 'viewer-pass');
    const veraCookie = p.cookie();
    await p.login();
    assert.equal((await p.req('PUT', '/api/users/vera', { json: { password: 'new-viewer-pass' } })).status, 200);
    p.setCookie(veraCookie);
    assert.equal((await p.req('GET', '/api/apps')).status, 401);
  });

  it('requires a TOTP code once 2FA is on, and refuses a replayed code', async () => {
    await as('olga', 'operator-pass');
    const setup = (await p.req('POST', '/api/auth/totp')).data;
    assert.match(setup.uri, /^otpauth:\/\/totp\/Pi-PaaS%3Aolga\?secret=/);
    assert.equal((await p.req('PUT', '/api/auth/totp', { json: { code: '000000' } })).status, 400);
    const code = auth.totp(setup.secret);
    assert.equal((await p.req('PUT', '/api/auth/totp', { json: { code } })).status, 200);

    const noCode = await as('olga', 'operator-pass');
    assert.equal(noCode.status, 401);
    assert.equal(noCode.data.needCode, true);
    const ok = await as('olga', 'operator-pass', auth.totp(setup.secret));
    assert.equal(ok.status, 200);
    const replay = await as('olga', 'operator-pass', auth.totp(setup.secret));
    assert.equal(replay.status, 401);

    await p.login();
    assert.equal((await p.req('DELETE', '/api/users/olga/totp')).status, 200);
    assert.equal((await as('olga', 'operator-pass')).status, 200);
  });

  it('issues API tokens that work without cookies or CSRF header and never exceed the owner', async () => {
    await as('olga', 'operator-pass');
    assert.equal((await p.req('POST', '/api/tokens', { json: { name: 'too much', role: 'admin' } })).status, 403);
    const t = (await p.req('POST', '/api/tokens', { json: { name: 'ci', role: 'viewer' } })).data;
    assert.match(t.token, /^pp_[0-9a-f]{12}_/);
    const list = (await p.req('GET', '/api/tokens')).data;
    assert.equal(list.length, 1);
    assert.equal(list[0].hash, undefined);

    p.setCookie('');
    const h = { Authorization: `Bearer ${t.token}`, 'X-PiPaaS': '' };
    assert.equal((await p.req('GET', '/api/apps', { headers: h })).status, 200);
    assert.equal((await p.req('POST', '/api/apps/x/start', { headers: h })).status, 403);
    assert.equal((await p.req('GET', '/api/apps', { headers: { Authorization: `${t.token.slice(0, -1)}x` } })).status, 401);

    await p.login();
    assert.equal((await p.req('DELETE', `/api/tokens/${t.id}`)).status, 200); // admins may revoke anyone's token
  });

  it('lists everyone\'s tokens for admins', async () => {
    await as('olga', 'operator-pass');
    const t = (await p.req('POST', '/api/tokens', { json: { name: 'deploy' } })).data;
    await p.login();
    const all = (await p.req('GET', '/api/tokens?all=1')).data;
    assert.ok(all.some((x) => x.id === t.id));
  });

  it('masks secrets in settings and keeps them when the mask comes back', async () => {
    await p.login();
    const put = await p.req('PUT', '/api/settings', { json: { notifications: { telegram: { enabled: true, botToken: '123456:abcdefghijklmnopqrstuvwxyz', chatId: '42' } } } });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    assert.equal(put.data.notifications.telegram.botToken, '••••••••');
    await p.req('PUT', '/api/settings', { json: { notifications: { telegram: { botToken: '••••••••', chatId: '43' } } } });
    assert.equal(p.settings.get().notifications.telegram.botToken, '123456:abcdefghijklmnopqrstuvwxyz');
    assert.equal(p.settings.get().notifications.telegram.chatId, '43');
    assert.equal((await p.req('PUT', '/api/settings', { json: { proxy: { domain: 'not a domain' } } })).status, 400);
  });
});
