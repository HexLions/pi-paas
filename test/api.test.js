'use strict';
// End-to-end tests against a real panel: real HTTP, real child processes.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const { startPanel, makeZip, zipForm, waitFor } = require('./helpers');

const NODE_APP = makeZip([
  { name: 'demo/' },
  { name: 'demo/server.js', data: "require('http').createServer((q, s) => s.end('v1 ' + (process.env.GREETING || '') + ' ' + process.env.DATA_DIR)).listen(process.env.PORT);" },
]);

async function getApp(p, id) {
  return (await p.req('GET', `/api/apps/${id}`)).data;
}

async function waitIdle(p, id) {
  await p.service.settle();
  return getApp(p, id);
}

describe('API', () => {
  let p;
  before(async () => { p = await startPanel(); });
  after(async () => { await p.close(); });

  it('serves health without login but nothing else', async () => {
    assert.equal((await p.req('GET', '/api/health')).status, 200);
    assert.equal((await p.req('GET', '/api/apps')).status, 401);
    assert.equal((await p.req('GET', '/api/auth/status')).data.authenticated, false);
  });

  it('rejects state-changing calls without the CSRF header', async () => {
    const res = await p.req('POST', '/api/auth/login', { json: { password: 'test-password' }, headers: { 'X-PiPaaS': '' } });
    assert.equal(res.status, 403);
  });

  it('rejects a wrong password and accepts the right one', async () => {
    assert.equal((await p.login('nope-nope')).status, 401);
    const ok = await p.login();
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await p.req('GET', '/api/auth/status')).data.authenticated, true);
  });

  it('sends security headers', async () => {
    const res = await p.req('GET', '/', { raw: true });
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });

  it('validates deploy input', async () => {
    let r = await p.req('POST', '/api/apps', { form: zipForm({ name: 'x', type: 'php' }, 'a.zip', NODE_APP) });
    assert.equal(r.status, 400);
    r = await p.req('POST', '/api/apps', { form: zipForm({ name: 'x', type: 'node' }, 'evil.exe', Buffer.from('x')) });
    assert.equal(r.status, 400);
    r = await p.req('POST', '/api/apps', { form: zipForm({ name: 'x', type: 'node', port: '80' }, 'a.zip', NODE_APP) });
    assert.equal(r.status, 400);
    assert.deepEqual(await fs.readdir(path.join(p.dataDir, 'uploads')), []);
  });

  it('deploys a single HTML file as a static app', async () => {
    const r = await p.req('POST', '/api/apps', { form: zipForm({ name: 'Hello Page', type: 'static' }, 'page.html', Buffer.from('<h1>static ok</h1>')) });
    assert.equal(r.status, 202);
    assert.equal(r.data.id, 'hello-page');
    const app = await waitIdle(p, 'hello-page');
    assert.equal(app.status, 'running', JSON.stringify(app.lastError));
    const body = await waitFor(async () => {
      try { return await (await fetch(`http://127.0.0.1:${app.port}/`)).text(); } catch { return null; }
    });
    assert.match(body, /static ok/);
  });

  it('refuses a second app with the same name', async () => {
    const r = await p.req('POST', '/api/apps', { form: zipForm({ name: 'hello page', type: 'static' }, 'page.html', Buffer.from('x')) });
    assert.equal(r.status, 409);
  });

  it('deploys a Node app from a ZIP and runs it with its settings', async () => {
    const r = await p.req('POST', '/api/apps', { form: zipForm({ name: 'demo', type: 'node', dbType: 'sqlite', dbName: 'main' }, 'demo.zip', NODE_APP) });
    assert.equal(r.status, 202);
    let app = await waitIdle(p, 'demo');
    assert.equal(app.status, 'running', JSON.stringify(app.lastError));
    assert.equal(app.dbInfo.name, 'main.db');
    const url = `http://127.0.0.1:${app.port}/`;
    assert.match(await waitFor(() => fetch(url).then((x) => x.text()).catch(() => null)), /^v1 /);

    const s = await p.req('PUT', '/api/apps/demo/settings', { json: { env: { GREETING: 'ciao' } } });
    assert.equal(s.status, 200);
    assert.match(await waitFor(() => fetch(url).then((x) => x.text()).catch(() => null)), /v1 ciao .*volumes\/demo/);
    app = await getApp(p, 'demo');
    assert.deepEqual(app.envKeys, ['GREETING']);

    const bad = await p.req('PUT', '/api/apps/demo/settings', { json: { env: { PORT: '1' } } });
    assert.equal(bad.status, 400);
  });

  it('keeps the panel password away from apps', async () => {
    const env = (await p.req('GET', '/api/apps/demo/settings')).data.env;
    assert.equal(env.PIPAAS_PASSWORD, undefined);
  });

  it('stops, starts and restarts', async () => {
    assert.equal((await p.req('POST', '/api/apps/demo/stop')).data.status, 'stopped');
    assert.equal((await getApp(p, 'demo')).desired, 'stopped');
    assert.equal((await p.req('POST', '/api/apps/demo/start')).data.status, 'running');
    assert.equal((await p.req('POST', '/api/apps/demo/restart')).data.status, 'running');
  });

  it('shows the log tail', async () => {
    const r = await p.req('GET', '/api/apps/demo/logs');
    assert.match(r.data.logs, /Starting: node server\.js/);
  });

  it('edits files and blocks traversal', async () => {
    const tree = await p.req('GET', '/api/apps/demo/files');
    assert.ok(tree.data.files.some((f) => f.path === 'server.js'));
    const f = await p.req('GET', '/api/apps/demo/files/server.js');
    assert.match(f.data.content, /createServer/);
    const saved = await p.req('PUT', '/api/apps/demo/files/notes/todo.md', { json: { content: '# todo' } });
    assert.equal(saved.status, 200);
    const stale = await p.req('PUT', '/api/apps/demo/files/server.js', { json: { content: 'x', mtime: 1 } });
    assert.equal(stale.status, 409);
    const enc = await p.req('GET', '/api/apps/demo/files/..%2F..%2Fregistry.json');
    assert.equal(enc.status, 400);
    // fetch() resolves dot segments itself, so this one never reaches the app route.
    const dots = await p.req('GET', '/api/apps/demo/files/%2E%2E/%2E%2E/auth.json');
    assert.notEqual(dots.status, 200);
    assert.doesNotMatch(JSON.stringify(dots.data), /scrypt/);
    const created = await p.req('POST', '/api/apps/demo/files', { json: { filePath: '../../x.txt' } });
    assert.equal(created.status, 400);
    assert.equal((await p.req('DELETE', '/api/apps/demo/files/notes%2Ftodo.md')).status, 200);
  });

  it('rejects unknown app ids', async () => {
    assert.equal((await p.req('GET', '/api/apps/__proto__')).status, 404);
    assert.equal((await p.req('POST', '/api/apps/nope/start')).status, 404);
  });

  it('backs up and restores an app', async () => {
    await fs.writeFile(path.join(p.dataDir, 'volumes/demo/keep.txt'), 'precious');
    const b = await p.req('POST', '/api/apps/demo/backups');
    assert.equal(b.status, 200);
    assert.match(b.data.filename, /^\d+\.tar\.gz$/);
    await fs.writeFile(path.join(p.dataDir, 'volumes/demo/keep.txt'), 'overwritten');
    await fs.writeFile(path.join(p.dataDir, 'apps/demo/server.js'), 'broken(');
    const list = await p.req('GET', '/api/apps/demo/backups');
    assert.equal(list.data.backups.length, 1);
    const r = await p.req('POST', `/api/apps/demo/backups/${b.data.filename}/restore`);
    assert.equal(r.status, 202);
    const app = await waitIdle(p, 'demo');
    assert.equal(app.status, 'running', JSON.stringify(app.lastError));
    assert.equal(await fs.readFile(path.join(p.dataDir, 'volumes/demo/keep.txt'), 'utf8'), 'precious');
    assert.match(await fs.readFile(path.join(p.dataDir, 'apps/demo/server.js'), 'utf8'), /createServer/);
    assert.equal((await p.req('GET', '/api/apps/demo/backups/..%2F..%2Fauth.json/download')).status, 400);
    assert.equal((await p.req('DELETE', `/api/apps/demo/backups/${b.data.filename}`)).status, 200);
  });

  it('puts the previous version back when an update fails to build', async () => {
    const broken = makeZip([
      { name: 'package.json', data: JSON.stringify({ name: 'x', version: '1.0.0', scripts: { start: 'node server.js', build: 'exit 1' } }) },
      { name: 'server.js', data: 'x' },
    ]);
    // React apps run "npm run build", which this package fails on purpose.
    const reactish = await p.req('POST', '/api/apps', { form: zipForm({ name: 'rollback', type: 'static' }, 'p.html', Buffer.from('<p>old</p>')) });
    assert.equal(reactish.status, 202);
    await waitIdle(p, 'rollback');
    p.registry.update('rollback', { type: 'react' });
    const r = await p.req('PUT', '/api/apps/rollback', { form: zipForm({}, 'new.zip', broken) });
    assert.equal(r.status, 202);
    const app = await waitIdle(p, 'rollback');
    assert.equal(app.lastError.task, 'updating');
    assert.equal(await fs.readFile(path.join(p.dataDir, 'apps/rollback/index.html'), 'utf8'), '<p>old</p>');
    assert.equal(app.version, 1);
  });

  it('changes the port without a new file', async () => {
    const before = await getApp(p, 'hello-page');
    const r = await p.req('PUT', '/api/apps/hello-page', { form: zipForm({ port: String(before.port + 50) }) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.port, before.port + 50);
    const clash = await p.req('PUT', '/api/apps/hello-page', { form: zipForm({ port: String((await getApp(p, 'demo')).port) }) });
    assert.equal(clash.status, 409);
  });

  it('lists ports with their owners', async () => {
    const ports = (await p.req('GET', '/api/ports')).data;
    const demo = await getApp(p, 'demo');
    assert.equal(ports.find((x) => x.port === demo.port).appName, 'demo');
  });

  it('reports system information', async () => {
    const s = (await p.req('GET', '/api/system')).data;
    assert.ok(s.memory.total > 0);
    assert.deepEqual(s.portRange, [39100, 39199]);
  });

  it('changes the password and logs out other sessions', async () => {
    const wrong = await p.req('PUT', '/api/auth/password', { json: { current: 'x', next: 'new-password-1' } });
    assert.equal(wrong.status, 401);
    const short = await p.req('PUT', '/api/auth/password', { json: { current: 'test-password', next: 'short' } });
    assert.equal(short.status, 400);
    const ok = await p.req('PUT', '/api/auth/password', { json: { current: 'test-password', next: 'new-password-1' } });
    assert.equal(ok.status, 200);
    assert.equal((await p.req('GET', '/api/apps')).status, 200);
    p.setCookie('pipaas_session=v1.99999999999999.x.y');
    assert.equal((await p.req('GET', '/api/apps')).status, 401);
    assert.equal((await p.login('new-password-1')).status, 200);
  });

  it('deletes an app with everything it owns', async () => {
    const app = await getApp(p, 'demo');
    assert.equal((await p.req('DELETE', '/api/apps/demo')).status, 200);
    assert.equal((await p.req('GET', '/api/apps/demo')).status, 404);
    for (const d of ['apps/demo', 'volumes/demo', 'backups/demo', 'logs/demo.log']) {
      assert.equal(await fs.pathExists(path.join(p.dataDir, d)), false, d);
    }
    await assert.rejects(fetch(`http://127.0.0.1:${app.port}/`));
  });
});

describe('restart after crash', () => {
  let p;
  before(async () => { p = await startPanel({ PIPAAS_PORT_RANGE: '39200-39250' }); await p.login(); });
  after(async () => { await p.close(); });

  it('restarts a crashing app and gives up after repeated crashes', async () => {
    const crashy = makeZip([{ name: 'server.js', data: 'process.exit(1)' }]);
    await p.req('POST', '/api/apps', { form: zipForm({ name: 'crashy', type: 'node' }, 'c.zip', crashy) });
    await p.service.settle();
    // 1+2+4+8 s of backoff before the fifth crash parks it.
    const app = await waitFor(async () => {
      const a = (await p.req('GET', '/api/apps/crashy')).data;
      return a.status === 'crashed' ? a : null;
    }, { timeout: 25000, interval: 250 });
    assert.equal(app.desired, 'running');
    const log = (await p.req('GET', '/api/apps/crashy/logs')).data.logs;
    assert.match(log, /Restarting in 1s/);
    assert.match(log, /not restarting/);
  });
});
