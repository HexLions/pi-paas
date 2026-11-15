// Notes API: GET/POST /api/notes, DELETE /api/notes/:id. Data lives in DATA_DIR.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = path.join(process.env.DATA_DIR || __dirname, 'notes.json');
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
const save = (notes) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(notes, null, 2)); fs.renameSync(`${file}.tmp`, file); };
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

http.createServer((req, res) => {
  if (req.url === '/' && req.method === 'GET') return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
  if (req.url === '/api/notes' && req.method === 'GET') return send(res, 200, load());
  if (req.url === '/api/notes' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      let text;
      try { text = String(JSON.parse(body).text || '').trim(); } catch { return send(res, 400, { error: 'Send JSON: {"text": "..."}' }); }
      if (!text) return send(res, 400, { error: 'Text is empty' });
      const note = { id: crypto.randomBytes(4).toString('hex'), text: text.slice(0, 2000), at: new Date().toISOString() };
      save([note, ...load()]);
      send(res, 201, note);
    });
    return undefined;
  }
  const m = /^\/api\/notes\/([0-9a-f]{8})$/.exec(req.url);
  if (m && req.method === 'DELETE') {
    save(load().filter((n) => n.id !== m[1]));
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found' });
}).listen(process.env.PORT || 3000, () => console.log(`Notes API on port ${process.env.PORT || 3000}`));
