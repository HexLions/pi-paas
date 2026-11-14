'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const { tmpDir } = require('./helpers');
const { createStaticServer } = require('../backend/static-server');

describe('static server', () => {
  let dir;
  let outside;
  let server;
  let base;
  before(async () => {
    dir = await tmpDir();
    outside = await tmpDir();
    await fs.writeFile(path.join(dir, 'index.html'), '<h1>home</h1>');
    await fs.outputFile(path.join(dir, 'assets/app.js'), 'console.log(1)');
    await fs.outputFile(path.join(dir, 'docs/index.html'), 'docs');
    await fs.writeFile(path.join(dir, 'data.bin'), Buffer.from('0123456789'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'leak.txt'));
    server = createStaticServer(dir, { spa: true });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await fs.remove(dir);
    await fs.remove(outside);
  });

  const get = (p, headers) => fetch(base + p, { headers });

  it('serves files with types and directory indexes', async () => {
    let r = await get('/');
    assert.equal(await r.text(), '<h1>home</h1>');
    assert.match(r.headers.get('content-type'), /text\/html/);
    r = await get('/assets/app.js');
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.equal(await (await get('/docs/')).text(), 'docs');
  });

  it('falls back to index.html for client-side routes only', async () => {
    assert.equal(await (await get('/users/42')).text(), '<h1>home</h1>');
    assert.equal((await get('/missing.png')).status, 404);
  });

  it('never leaves the root folder', async () => {
    for (const p of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%00']) {
      const r = await get(p);
      assert.doesNotMatch(await r.text(), /root:/, p);
    }
    const leak = await get('/leak.txt');
    assert.notEqual(await leak.text(), 'secret');
  });

  it('supports conditional and range requests', async () => {
    const first = await get('/assets/app.js');
    const etag = first.headers.get('etag');
    assert.equal((await get('/assets/app.js', { 'If-None-Match': etag })).status, 304);
    const part = await get('/data.bin', { Range: 'bytes=2-4' });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), '234');
    assert.equal((await get('/data.bin', { Range: 'bytes=50-60' })).status, 416);
  });

  it('refuses other methods', async () => {
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  });
});
