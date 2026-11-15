'use strict';
// Built-in reverse proxy. Listens on port 80 (and 443 once a certificate
// exists) and sends each request to the app named by the Host header:
//   <app>.local            (announced on the LAN by mdns.js)
//   <app>.<domain>         (when a base domain is set in the panel settings)
//   any custom domain added to an app
// The machine's own name and IP address reach the panel itself.
// Certificates come from Let's Encrypt (HTTP-01) for public names.
const fs = require('fs-extra');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const tls = require('tls');

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const RENEW_DAYS = 30;

function normHost(h) {
  return String(h || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

function validDomain(d) {
  return HOST_RE.test(d) && !d.endsWith('.local');
}

function page(status, title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}main{max-width:30em;padding:24px}h1{font-size:22px}p{color:GrayText}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p><p><small>Pi-PaaS · ${status}</small></p></main></body></html>`;
}

class Proxy {
  constructor({ cfg, registry, pm, settings, log = console }) {
    Object.assign(this, { cfg, registry, pm, settings, log });
    this.challenges = new Map(); // token -> key authorization
    this.certs = new Map(); // host -> { key, cert, notAfter, ctx }
    this.issuing = new Set();
    this.failed = new Map(); // host -> { at, error }
    this.httpServer = null;
    this.httpsServer = null;
    this.ports = { http: null, https: null };
  }

  certDir() { return path.join(this.cfg.dataDir, 'certs'); }

  // ---------- routing ----------

  localNames() {
    const h = os.hostname().toLowerCase();
    return new Set([h, `${h}.local`, 'localhost', ...this.addresses()]);
  }

  addresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) out.push(i.address.toLowerCase());
    return out;
  }

  /** Every public name of an app, for links and certificates. */
  namesFor(id, app = this.registry.get(id)) {
    const s = this.settings.get();
    const names = [];
    if (s.mdns.enabled) names.push(`${id}.local`);
    if (s.proxy.domain) names.push(`${id}.${s.proxy.domain}`);
    for (const d of (app && app.domains) || []) names.push(d);
    return names;
  }

  /** 'panel' | { id, app } | null */
  route(hostHeader) {
    const host = normHost(hostHeader);
    if (!host || this.localNames().has(host)) return 'panel';
    const domain = this.settings.get().proxy.domain;
    if (domain && host === `panel.${domain}`) return 'panel';
    for (const app of this.registry.all()) {
      if (host === `${app.id}.local` || (domain && host === `${app.id}.${domain}`) || (app.domains || []).includes(host)) return { id: app.id, app };
    }
    if (net.isIP(host)) return 'panel';
    return null;
  }

  // ---------- servers ----------

  async start() {
    const s = this.settings.get();
    if (!s.proxy.enabled || this.cfg.proxyPort === null) return this;
    this.httpServer = http.createServer((req, res) => this.handle(req, res, false));
    this.httpServer.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, false));
    this.ports.http = await listen(this.httpServer, this.cfg.proxyPort, this.cfg.host).catch((err) => {
      this.log.warn(`[proxy] cannot listen on port ${this.cfg.proxyPort} (${err.code}); app names without :port are off. Another web server may be using it.`);
      this.httpServer = null;
      return null;
    });
    await this.loadCerts();
    await this.startHttps();
    this.renewTimer = setInterval(() => this.ensureCerts().catch((err) => this.log.warn(`[acme] ${err.message}`)), 12 * 3600000);
    this.renewTimer.unref();
    this.ensureCerts().catch((err) => this.log.warn(`[acme] ${err.message}`));
    if (this.ports.http) this.log.log(`[proxy] app names on port ${this.ports.http}${this.ports.https ? `, https on ${this.ports.https}` : ''}`);
    return this;
  }

  async startHttps() {
    if (this.httpsServer || this.cfg.httpsPort === null || !this.certs.size) return;
    const fallback = [...this.certs.values()][0];
    this.httpsServer = https.createServer({
      key: fallback.key,
      cert: fallback.cert,
      SNICallback: (servername, cb) => {
        const c = this.certs.get(normHost(servername));
        cb(null, c ? c.ctx : fallback.ctx);
      },
    }, (req, res) => this.handle(req, res, true));
    this.httpsServer.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head, true));
    this.ports.https = await listen(this.httpsServer, this.cfg.httpsPort, this.cfg.host).catch((err) => {
      this.log.warn(`[proxy] cannot listen on port ${this.cfg.httpsPort} for https (${err.code})`);
      this.httpsServer = null;
      return null;
    });
  }

  async stop() {
    clearInterval(this.renewTimer);
    await Promise.all([this.httpServer, this.httpsServer].filter(Boolean).map((s) => new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); })));
    this.httpServer = null;
    this.httpsServer = null;
  }

  target(route) {
    if (route === 'panel') return { port: this.cfg.port, name: 'panel' };
    const info = this.pm.info(route.id);
    return { port: route.app.port, name: route.app.name, running: info.status === 'running' };
  }

  handle(req, res, secure) {
    const url = req.url || '/';
    if (!secure && url.startsWith('/.well-known/acme-challenge/')) {
      const token = url.split('/').pop();
      const auth = this.challenges.get(token);
      res.writeHead(auth ? 200 : 404, { 'Content-Type': 'text/plain' });
      return res.end(auth || 'Not found');
    }
    const host = normHost(req.headers.host);
    const route = this.route(host);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page(404, 'No app here', `No app is published at ${host || 'this address'}.`));
    }
    if (!secure && route !== 'panel' && this.ports.https && this.certs.has(host)) {
      const port = this.ports.https === 443 ? '' : `:${this.ports.https}`;
      res.writeHead(308, { Location: `https://${host}${port}${url}` });
      return res.end();
    }
    const t = this.target(route);
    if (route !== 'panel' && !t.running) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '10' });
      return res.end(page(503, `${t.name} is not running`, 'Start it from the Pi-PaaS panel, or wait a moment if it is restarting.'));
    }
    const headers = { ...req.headers };
    const prior = req.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = prior ? `${prior}, ${req.socket.remoteAddress}` : req.socket.remoteAddress;
    headers['x-forwarded-proto'] = secure ? 'https' : 'http';
    headers['x-forwarded-host'] = req.headers.host || '';
    const up = http.request({ host: '127.0.0.1', port: t.port, method: req.method, path: url, headers }, (r) => {
      res.writeHead(r.statusCode, r.rawHeaders.length ? rawToObject(r.rawHeaders) : r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(502, `${t.name} did not answer`, 'The app is running but refused the connection. Check that it listens on its PORT.'));
    });
    req.pipe(up);
    return undefined;
  }

  upgrade(req, socket, head, secure) {
    const route = this.route(req.headers.host);
    if (!route) return socket.destroy();
    const t = this.target(route);
    const up = net.connect(t.port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      lines.push(`X-Forwarded-For: ${req.socket.remoteAddress}`, `X-Forwarded-Proto: ${secure ? 'https' : 'http'}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    return undefined;
  }

  // ---------- certificates ----------

  async loadCerts() {
    await fs.ensureDir(this.certDir());
    await fs.chmod(this.certDir(), 0o700).catch(() => {});
    for (const f of await fs.readdir(this.certDir())) {
      if (!f.endsWith('.crt')) continue;
      const host = f.slice(0, -4);
      try {
        this.addCert(host, await fs.readFile(path.join(this.certDir(), `${host}.key`), 'utf8'), await fs.readFile(path.join(this.certDir(), f), 'utf8'));
      } catch (err) {
        this.log.warn(`[proxy] skipping certificate ${f}: ${err.message}`);
      }
    }
  }

  addCert(host, key, cert) {
    const x = new (require('crypto').X509Certificate)(cert);
    this.certs.set(host, { key, cert, notAfter: new Date(x.validTo), ctx: tls.createSecureContext({ key, cert }) });
  }

  /** Public names that should have a certificate (not .local, not IPs). */
  wantedCertNames() {
    const out = new Set();
    for (const app of this.registry.all()) for (const n of this.namesFor(app.id, app)) if (validDomain(n)) out.add(n);
    return [...out];
  }

  certStatus() {
    return this.wantedCertNames().map((host) => {
      const c = this.certs.get(host);
      const f = this.failed.get(host);
      return { host, validUntil: c ? c.notAfter.toISOString() : null, issuing: this.issuing.has(host), error: f ? f.error : null };
    });
  }

  async ensureCerts() {
    const s = this.settings.get().proxy;
    if (!s.acmeEmail || !this.ports.http) return;
    for (const host of this.wantedCertNames()) {
      const c = this.certs.get(host);
      if (c && c.notAfter - Date.now() > RENEW_DAYS * 86400000) continue;
      const f = this.failed.get(host);
      if (f && Date.now() - f.at < 6 * 3600000) continue; // don't hammer Let's Encrypt
      await this.issue(host).catch(() => {});
    }
  }

  async issue(host) {
    if (this.issuing.has(host)) return;
    this.issuing.add(host);
    const acme = require('acme-client');
    const s = this.settings.get().proxy;
    try {
      const accountFile = path.join(this.certDir(), 'account.key');
      if (!(await fs.pathExists(accountFile))) await fs.writeFile(accountFile, await acme.crypto.createPrivateKey(), { mode: 0o600 });
      const client = new acme.Client({
        directoryUrl: s.acmeStaging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
        accountKey: await fs.readFile(accountFile),
      });
      const [key, csr] = await acme.crypto.createCsr({ commonName: host });
      const cert = await client.auto({
        csr,
        email: s.acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => { this.challenges.set(challenge.token, keyAuthorization); },
        challengeRemoveFn: async (authz, challenge) => { this.challenges.delete(challenge.token); },
      });
      await fs.writeFile(path.join(this.certDir(), `${host}.key`), key, { mode: 0o600 });
      await fs.writeFile(path.join(this.certDir(), `${host}.crt`), cert);
      this.addCert(host, key.toString(), cert.toString());
      this.failed.delete(host);
      this.log.log(`[acme] certificate for ${host} until ${this.certs.get(host).notAfter.toISOString()}`);
      await this.startHttps();
    } catch (err) {
      this.failed.set(host, { at: Date.now(), error: err.message.slice(0, 300) });
      this.log.warn(`[acme] ${host}: ${err.message}`);
      throw err;
    } finally {
      this.issuing.delete(host);
    }
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
  });
}

/** Keep the app's header casing and repeated headers (Set-Cookie). */
function rawToObject(raw) {
  const out = {};
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i];
    if (out[k] === undefined) out[k] = raw[i + 1];
    else out[k] = [].concat(out[k], raw[i + 1]);
  }
  return out;
}

module.exports = { Proxy, normHost, validDomain };
