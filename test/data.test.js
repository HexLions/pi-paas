'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { startPanel, makeZip, zipForm, waitFor, tmpDir } = require('./helpers');
const crypt = require('../backend/crypt');
const sqlconsole = require('../backend/sqlconsole');

describe('backup encryption', () => {
  it('round-trips and refuses a wrong passphrase', async () => {
    const d = await tmpDir();
    const src = path.join(d, 'a.bin');
    await fs.writeFile(src, Buffer.alloc(300000, 7));
    await crypt.encryptFile(src, path.join(d, 'a.enc'), 'correct horse battery');
    assert.ok(crypt.isEncrypted(path.join(d, 'a.enc')));
    assert.ok(!(await fs.readFile(path.join(d, 'a.enc'))).includes(Buffer.alloc(64, 7)));
    await crypt.decryptFile(path.join(d, 'a.enc'), path.join(d, 'b.bin'), 'correct horse battery');
    assert.ok((await fs.readFile(path.join(d, 'b.bin'))).equals(await fs.readFile(src)));
    await assert.rejects(crypt.decryptFile(path.join(d, 'a.enc'), path.join(d, 'c.bin'), 'wrong passphrase!!'), /Wrong passphrase/);
    assert.equal(await fs.pathExists(path.join(d, 'c.bin')), false);
    await fs.remove(d);
  });
});

describe('SQL statements', () => {
  it('allows exactly one statement', () => {
    sqlconsole.assertSingleStatement('select 1;');
    sqlconsole.assertSingleStatement("select ';' as x");
    sqlconsole.assertSingleStatement('select 1; -- done');
    assert.throws(() => sqlconsole.assertSingleStatement('select 1; drop table t'), /one statement/);
    assert.deepEqual(sqlconsole.parseCsv('a,b\n1,"x,""y"""\n'), [['a', 'b'], ['1', 'x,"y"']]);
  });
});

describe('data features', () => {
  let p;
  let nas;
  before(async () => {
    nas = await tmpDir();
    p = await startPanel({ PIPAAS_PORT_RANGE: '39700-39730' });
    await p.login();
    const appCode = "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)";
    await p.req('POST', '/api/apps', { form: zipForm({ name: 'shop', type: 'node', dbType: 'sqlite' }, 's.zip', makeZip([{ name: 'server.js', data: appCode }])) });
    await p.service.settle();
  });
  after(async () => { await p.close(); await fs.remove(nas); });

  it('copies encrypted, verified backups to a folder and restores from there', async () => {
    const r = await p.req('PUT', '/api/settings', { json: { backups: { target: 'folder', folder: nas, passphrase: 'a long backup passphrase' } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.backups.passphrase, '••••••••');
    await fs.writeFile(path.join(p.dataDir, 'volumes/shop/orders.txt'), 'order 1');
    const b = (await p.req('POST', '/api/apps/shop/backups')).data;
    await p.backups.settle();
    const listed = (await p.req('GET', '/api/apps/shop/backups')).data.backups[0];
    assert.equal(listed.verified.ok, true);
    assert.equal(listed.offsite.ok, true, JSON.stringify(listed.offsite));
    assert.equal(listed.offsite.encrypted, true);
    const remoteFile = path.join(nas, os.hostname(), 'shop', `${b.filename}.enc`);
    assert.ok(crypt.isEncrypted(remoteFile));

    const remote = (await p.req('GET', '/api/apps/shop/backups-remote')).data;
    assert.equal(remote[0].name, `${b.filename}.enc`);
    // Lose the local copy and the data, then restore from the NAS.
    await p.req('DELETE', `/api/apps/shop/backups/${b.filename}`);
    await fs.writeFile(path.join(p.dataDir, 'volumes/shop/orders.txt'), 'lost');
    const rr = await p.req('POST', `/api/apps/shop/backups-remote/${remote[0].name}/restore`);
    assert.equal(rr.status, 202, JSON.stringify(rr.data));
    await p.service.settle();
    assert.equal(await fs.readFile(path.join(p.dataDir, 'volumes/shop/orders.txt'), 'utf8'), 'order 1');
    assert.equal((await p.req('POST', '/api/apps/shop/backups-remote/..%2Fx/restore')).status, 400);
  });

  it('flags a backup that cannot be restored', async () => {
    const name = `${Date.now()}.tar.gz`;
    await fs.writeFile(path.join(p.dataDir, 'backups/shop', name), 'not a tar file');
    const v = (await p.req('POST', `/api/apps/shop/backups/${name}/verify`)).data;
    assert.equal(v.ok, false);
    await p.req('PUT', '/api/settings', { json: { backups: { target: 'none' } } });
  });

  // node:sqlite arrived in Node 22.5; on older Node the console says so instead.
  let hasSqlite = true;
  try { require('node:sqlite'); } catch { hasSqlite = false; }
  it('runs SQL on the app database with role checks', { skip: !hasSqlite && 'needs node:sqlite (Node 22.5+)' }, async () => {
    let r = await p.req('POST', '/api/apps/shop/sql', { json: { sql: 'SELECT 1' } });
    assert.equal(r.status, 400); // the database file does not exist yet
    r = await p.req('POST', '/api/apps/shop/sql', { json: { sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)', write: true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await p.req('POST', '/api/apps/shop/sql', { json: { sql: "INSERT INTO items (name) VALUES ('lamp'), ('chair')", write: true } });
    r = await p.req('POST', '/api/apps/shop/sql', { json: { sql: 'SELECT id, name FROM items ORDER BY id' } });
    assert.deepEqual(r.data.columns, ['id', 'name']);
    assert.deepEqual(r.data.rows, [[1, 'lamp'], [2, 'chair']]);
    r = await p.req('POST', '/api/apps/shop/sql', { json: { sql: 'DELETE FROM items' } });
    assert.equal(r.status, 400, 'read-only by default');
    assert.match(r.data.error, /readonly|read-only/i);
    r = await p.req('POST', '/api/apps/shop/sql', { json: { sql: 'SELECT 1; DELETE FROM items', write: true } });
    assert.equal(r.status, 400);
    assert.deepEqual((await p.req('GET', '/api/apps/shop/sql/tables')).data, [{ name: 'items', type: 'table' }]);

    await p.req('POST', '/api/users', { json: { username: 'op', password: 'operator-pw', role: 'operator' } });
    p.setCookie('');
    await p.req('POST', '/api/auth/login', { json: { username: 'op', password: 'operator-pw' } });
    assert.equal((await p.req('POST', '/api/apps/shop/sql', { json: { sql: 'SELECT count(*) FROM items' } })).status, 200);
    assert.equal((await p.req('POST', '/api/apps/shop/sql', { json: { sql: 'DELETE FROM items', write: true } })).status, 403);
    await p.login();
  });

  it('streams new log lines and searches the log', async () => {
    const res = await fetch(`${p.base}/api/apps/shop/logs/stream`, { headers: { Cookie: p.cookie() } });
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const reader = res.body.getReader();
    let got = '';
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        got += Buffer.from(value).toString();
      }
    })();
    await waitFor(() => got.includes('event: log'));
    p.pm.note('shop', 'hello live stream');
    await waitFor(() => got.includes('hello live stream'), { timeout: 5000 });
    await reader.cancel();
    await pump.catch(() => {});

    const s = (await p.req('GET', '/api/apps/shop/logs/search?q=LIVE%20stream')).data;
    assert.equal(s.matches.at(-1).file, 'current');
    assert.match(s.matches.at(-1).text, /hello live stream/);
    assert.equal((await p.req('GET', '/api/apps/shop/logs/search?q=')).status, 400);
  });
});
