'use strict';
// Regressions for the findings of the security review of 1.2.0.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const { execFileSync } = require('child_process');
const { startPanel, zipForm, tmpDir } = require('./helpers');
const sqlconsole = require('../backend/sqlconsole');
const push = require('../backend/push');
const auth = require('../backend/auth');

process.env.PIPAAS_ALLOW_LOCAL_GIT = '1';

describe('security regressions', () => {
  let p;
  before(async () => {
    p = await startPanel({ PIPAAS_PORT_RANGE: '39870-39880' });
    await p.login();
    await p.req('POST', '/api/users', { json: { username: 'op', password: 'operator-pw', role: 'operator' } });
    await p.req('POST', '/api/users', { json: { username: 'vi', password: 'viewer-pw1', role: 'viewer' } });
  });
  after(async () => { await p.close(); });
  const as = async (u, pw) => { p.setCookie(''); await p.req('POST', '/api/auth/login', { json: { username: u, password: pw } }); };

  it('does not let case or trailing slashes slip past the role rules', async () => {
    await as('op', 'operator-pw');
    for (const [m, u] of [['GET', '/api/USERS'], ['GET', '/api/Users/'], ['POST', '/api/USERS'], ['PUT', '/api/Settings'], ['POST', '/api/Panel/update'], ['DELETE', '/api/apps/x/'], ['DELETE', '/api/APPS/x']]) {
      const r = await p.req(m, u, m === 'GET' ? {} : { json: { username: 'evil', password: 'evil-pass1', role: 'admin' } });
      assert.ok([403, 404].includes(r.status), `${m} ${u} -> ${r.status}`);
    }
    await as('vi', 'viewer-pw1');
    for (const u of ['/api/apps/x/DB', '/api/apps/x/Settings', '/api/apps/x/Files/a', '/api/apps/x/backups/1.tar.gz/Download']) {
      const r = await p.req('GET', u);
      assert.ok([403, 404].includes(r.status), `${u} -> ${r.status}`);
    }
    const head = await p.req('HEAD', '/api/apps/x/settings', { raw: true });
    assert.ok([403, 404].includes(head.status));
    await p.login();
    assert.deepEqual((await p.req('GET', '/api/users')).data.map((u) => u.name).sort(), ['admin', 'op', 'vi']);
  });

  it('keeps psql commands and extra statements out of the SQL console', async () => {
    const pg = { type: 'postgres', name: 'db', user: 'u', password: 'p' };
    await assert.rejects(sqlconsole.query(pg, '\\! id'), /Backslashes are not allowed/);
    await assert.rejects(sqlconsole.query(pg, "select 1 \\g /tmp/x"), /Backslashes/);
    for (const sql of ["SELECT E'\\''; COMMIT; DELETE FROM t; --'", "SELECT /*'*/ 1; DELETE FROM t", "SELECT $q$'$q$; DELETE FROM t"]) {
      assert.throws(() => sqlconsole.assertSingleStatement(sql), /one statement/, sql);
    }
    await assert.rejects(sqlconsole.query({ type: 'sqlite', path: '/nonexistent/x.db' }, '.shell id'), (err) => !/shell/.test(String(err.stdout || '')));
  });

  it('refuses a git repository with a link pointing outside the app', async () => {
    const work = await tmpDir();
    const repo = path.join(work, 'repo');
    await fs.ensureDir(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'index.html'), 'hi');
    await fs.symlink('/etc/passwd', path.join(repo, 'app'));
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'x'], { cwd: repo });
    await p.req('POST', '/api/apps', { form: zipForm({ name: 'linky', type: 'binary', gitUrl: `file://${repo}` }) });
    await p.service.settle();
    const a = (await p.req('GET', '/api/apps/linky')).data;
    assert.match(a.lastError.message, /symbolic links that point outside/);
    assert.notEqual(a.status, 'running');
    await fs.remove(work);
  });

  it('asks for the password before replacing an active second factor', async () => {
    await as('op', 'operator-pw');
    const s = (await p.req('POST', '/api/auth/totp')).data;
    assert.equal((await p.req('PUT', '/api/auth/totp', { json: { code: auth.totp(s.secret) } })).status, 200);
    p.setCookie('');
    await p.req('POST', '/api/auth/login', { json: { username: 'op', password: 'operator-pw', code: auth.totp(s.secret, Date.now() + 30000) } });
    assert.equal((await p.req('POST', '/api/auth/totp')).status, 401);
    assert.equal((await p.req('POST', '/api/auth/totp', { json: { password: 'operator-pw' } })).status, 200);
  });

  it('only accepts push endpoints of real push services', () => {
    assert.ok(push.pushHostAllowed('https://fcm.googleapis.com/fcm/send/abc'));
    assert.ok(push.pushHostAllowed('https://web.push.apple.com/abc'));
    for (const u of ['https://192.168.1.1/x', 'https://localhost/x', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.example/x']) {
      assert.equal(push.pushHostAllowed(u), false, u);
    }
  });

  it('picks up passwords changed with cli.js while the panel runs', async () => {
    const { Auth } = auth;
    const other = new Auth(p.cfg, { warn() {} }).init();
    await new Promise((r) => setTimeout(r, 20));
    other.setPassword('changed-by-cli', 'vi');
    assert.ok(p.auth.checkPassword('changed-by-cli', 'vi'));
  });
});
