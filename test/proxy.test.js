'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startPanel, makeZip, zipForm, waitFor } = require('./helpers');
const { Mdns } = require('../backend/mdns');

function get(port, host, p = '/', secure = false) {
  return new Promise((resolve, reject) => {
    const mod = secure ? https : http;
    const req = mod.get({ host: '127.0.0.1', port, path: p, headers: { Host: host }, servername: host, rejectUnauthorized: false }, (res) => {
      const cert = secure ? res.socket.getPeerCertificate() : null;
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, cert }));
    });
    req.on('error', reject);
  });
}

describe('built-in proxy', () => {
  let p;
  before(async () => {
    p = await startPanel({ PIPAAS_PORT_RANGE: '39600-39630', PIPAAS_PROXY_PORT: '0', PIPAAS_HTTPS_PORT: '0' });
    await p.login();
    // A self-signed certificate stands in for one from Let's Encrypt.
    const certs = path.join(p.dataDir, 'certs');
    await fs.ensureDir(certs);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=blog.example.com',
      '-keyout', path.join(certs, 'blog.example.com.key'), '-out', path.join(certs, 'blog.example.com.crt')], { stdio: 'ignore' });
    const ws = "const s=require('http').createServer((q,r)=>r.end('hello from '+q.headers.host+' via '+q.headers['x-forwarded-proto']));"
      + "s.on('upgrade',(q,sock)=>{sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: echo\\r\\nConnection: Upgrade\\r\\n\\r\\n');sock.pipe(sock);});"
      + 's.listen(process.env.PORT)';
    await p.req('POST', '/api/apps', { form: zipForm({ name: 'blog', type: 'node' }, 'b.zip', makeZip([{ name: 'server.js', data: ws }])) });
    await p.service.settle();
    await p.proxy.start();
  });
  after(async () => { await p.close(); });

  it('routes <app>.local to the app and the machine name to the panel', async () => {
    const r = await waitFor(async () => { const x = await get(p.proxy.ports.http, 'blog.local'); return x.status === 200 ? x : null; });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'hello from blog.local via http');
    const panel = await get(p.proxy.ports.http, `${os.hostname()}.local`, '/api/health');
    assert.equal(JSON.parse(panel.body).ok, true);
    const nobody = await get(p.proxy.ports.http, 'nothing.local');
    assert.equal(nobody.status, 404);
    assert.match(nobody.body, /No app is published at nothing\.local/);
  });

  it('shows a clear page while an app is stopped', async () => {
    await p.req('POST', '/api/apps/blog/stop');
    const r = await get(p.proxy.ports.http, 'blog.local');
    assert.equal(r.status, 503);
    assert.match(r.body, /blog is not running/);
    await p.req('POST', '/api/apps/blog/start');
    await waitFor(async () => (await get(p.proxy.ports.http, 'blog.local')).status === 200);
  });

  it('accepts custom domains, refuses bad or taken ones', async () => {
    assert.equal((await p.req('PUT', '/api/apps/blog/settings', { json: { domains: ['not_a domain'] } })).status, 400);
    assert.equal((await p.req('PUT', '/api/apps/blog/settings', { json: { domains: ['x.local'] } })).status, 400);
    assert.equal((await p.req('PUT', '/api/apps/blog/settings', { json: { domains: ['blog.example.com', 'BLOG.example.com'] } })).status, 200);
    assert.deepEqual((await p.req('GET', '/api/apps/blog')).data.domains, ['blog.example.com']);
    await waitFor(async () => (await get(p.proxy.ports.http, 'blog.example.com', '/x')).status !== 503);
  });

  it('serves https with the certificate for the name asked, and redirects http to it', async () => {
    await p.proxy.startHttps();
    assert.ok(p.proxy.ports.https);
    const r = await get(p.proxy.ports.https, 'blog.example.com', '/', true);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'hello from blog.example.com via https');
    assert.equal(r.cert.subject.CN, 'blog.example.com');
    const redirect = await get(p.proxy.ports.http, 'blog.example.com', '/a?b=1');
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.location, `https://blog.example.com:${p.proxy.ports.https}/a?b=1`);
    const links = (await p.req('GET', '/api/apps/blog')).data.links;
    assert.ok(links.some((l) => l.startsWith('https://blog.example.com')));
    assert.ok(links.some((l) => l.startsWith('http://blog.local')));
  });

  it('answers ACME http-01 challenges', async () => {
    p.proxy.challenges.set('tok123', 'tok123.keyauth');
    const r = await get(p.proxy.ports.http, 'blog.example.com', '/.well-known/acme-challenge/tok123');
    assert.equal(r.status, 200);
    assert.equal(r.body, 'tok123.keyauth');
  });

  it('passes WebSocket upgrades through', async () => {
    await waitFor(async () => (await get(p.proxy.ports.http, 'blog.local')).status === 200);
    const sock = net.connect(p.proxy.ports.http, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write('GET /ws HTTP/1.1\r\nHost: blog.local\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
    let data = '';
    sock.on('data', (d) => { data += d; });
    await waitFor(() => data.includes('101'));
    sock.write('ping-pong');
    await waitFor(() => data.includes('ping-pong'));
    sock.destroy();
  });

  it('reports proxy and certificate status', async () => {
    const s = (await p.req('GET', '/api/proxy')).data;
    assert.equal(s.http, p.proxy.ports.http);
    assert.ok(s.certificates.find((c) => c.host === 'blog.example.com').validUntil);
  });

  it('answers mDNS questions only for app names', () => {
    const m = new Mdns({ registry: p.registry, settings: p.settings });
    const a = m.answersFor({ name: 'blog.local', type: 'A' });
    assert.ok(a.every((x) => x.name === 'blog.local' && x.type === 'A'));
    assert.deepEqual(m.answersFor({ name: 'nope.local', type: 'A' }), []);
    assert.deepEqual(m.answersFor({ name: `${os.hostname()}.local`, type: 'A' }), []);
    assert.deepEqual(m.answersFor({ name: 'blog.example.com', type: 'A' }), []);
  });
});
