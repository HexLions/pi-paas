#!/usr/bin/env node
'use strict';
// Static file server for "static" and "react" apps. A single file with no
// dependencies, so it can be copied somewhere the unprivileged app user can
// read and run it.
//
//   node static-server.js <root> <port> [--spa]
//
// --spa sends index.html for unknown paths without a file extension, which is
// what client-side routers (React Router, Vue Router) need.
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8', csv: 'text/csv; charset=utf-8', webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf', zip: 'application/zip', wasm: 'application/wasm',
};

function createStaticServer(rootDir, { spa = false } = {}) {
  const root = fs.realpathSync(path.resolve(rootDir));

  function inside(p) {
    return p === root || p.startsWith(root + path.sep);
  }

  /** Map a URL path to a real file inside root, or null. */
  function lookup(urlPath) {
    let rel;
    try { rel = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
    if (rel.includes('\0')) return null;
    let file = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
    if (!inside(file)) return null;
    try {
      let st = fs.statSync(file);
      if (st.isDirectory()) {
        file = path.join(file, 'index.html');
        st = fs.statSync(file);
      }
      const real = fs.realpathSync(file);
      if (!inside(real) || !st.isFile()) return null;
      return { file: real, st };
    } catch {
      return null;
    }
  }

  function send(req, res, found, status = 200) {
    const { file, st } = found;
    const ext = path.extname(file).slice(1).toLowerCase();
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Last-Modified', st.mtime.toUTCString());
    res.setHeader('ETag', etag);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    // Hashed build assets can be cached; HTML must always be revalidated.
    res.setHeader('Cache-Control', ext === 'html' ? 'no-cache' : 'public, max-age=3600');
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      return res.end();
    }
    let start = 0;
    let end = st.size - 1;
    const range = status === 200 && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && st.size > 0) {
      if (range[1] === '') { start = Math.max(0, st.size - Number(range[2])); } else {
        start = Number(range[1]);
        if (range[2] !== '') end = Math.min(end, Number(range[2]));
      }
      if (start > end || start >= st.size) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${st.size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    } else {
      res.statusCode = status;
    }
    res.setHeader('Content-Length', st.size === 0 ? 0 : end - start + 1);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    const urlPath = (req.url || '/').split('?')[0];
    const found = lookup(urlPath);
    if (found) return send(req, res, found);
    if (spa && !path.posix.extname(urlPath)) {
      const index = lookup('/index.html');
      if (index) return send(req, res, index);
    }
    const notFound = lookup('/404.html');
    if (notFound) return send(req, res, notFound, 404);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
}

if (require.main === module) {
  const [dir, port, ...flags] = process.argv.slice(2);
  if (!dir || !port) {
    console.error('Usage: static-server.js <root> <port> [--spa]');
    process.exit(2);
  }
  const server = createStaticServer(dir, { spa: flags.includes('--spa') });
  server.listen(Number(port), process.env.HOST || '0.0.0.0', () => {
    console.log(`Serving ${dir} on port ${port}${flags.includes('--spa') ? ' (single-page app)' : ''}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createStaticServer };
