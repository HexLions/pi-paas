'use strict';
// SQL console, live logs and log search, backup checks and offsite backups.
const fs = require('fs-extra');
const path = require('path');
const sqlconsole = require('../sqlconsole');
const { HttpError } = require('../util');
const { roleRank } = require('../auth');

const MAX_STREAMS = 50;
const SEARCH_BYTES = 8 * 1024 * 1024;
let streams = 0;
let searching = false;

function routes(app, { cfg, service, backups, wrap }) {
  // ----- SQL console -----
  app.get('/api/apps/:id/sql/tables', wrap(async (req, res) => {
    const a = service.mustGet(req.params.id);
    if (!a.dbInfo) throw new HttpError(404, 'App has no database');
    if (!sqlconsole.available(a.dbInfo)) throw new HttpError(400, 'No SQL client for this database on the machine');
    res.json(await sqlconsole.tables(a.dbInfo));
  }));

  app.post('/api/apps/:id/sql', wrap(async (req, res) => {
    const a = service.mustGet(req.params.id);
    const { sql, write } = req.body || {};
    if (write && roleRank(req.user.role) < roleRank('admin')) throw new HttpError(403, 'Changing data needs the admin role');
    res.json(await sqlconsole.query(a.dbInfo, sql, { write: !!write }));
  }));

  // ----- live logs (Server-Sent Events) -----
  app.get('/api/apps/:id/logs/stream', wrap(async (req, res) => {
    service.mustGet(req.params.id);
    if (streams >= MAX_STREAMS) throw new HttpError(429, 'Too many open log streams');
    streams += 1;
    // Release the slot however the stream ends, even if the first read fails.
    let released = false;
    const release = () => { if (!released) { released = true; streams -= 1; } };
    req.on('close', release);
    const file = path.join(cfg.logDir, `${req.params.id}.log`);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let pos = 0;
    let busy = false;
    const readFrom = async (start, end) => {
      const fh = await fs.promises.open(file, 'r');
      try {
        const len = Math.min(end - start, 256 * 1024);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        return { text: buf.toString('utf8'), next: start + len };
      } finally { await fh.close(); }
    };
    const size = async () => (await fs.stat(file).catch(() => ({ size: 0 }))).size;
    const initial = await size();
    const from = Math.max(0, initial - 32 * 1024);
    if (initial > 0) {
      let { text } = await readFrom(from, initial);
      if (from > 0) text = text.slice(text.indexOf('\n') + 1);
      send('log', { text });
    } else {
      send('log', { text: '' });
    }
    pos = initial;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const now = await size();
        if (now < pos) { pos = 0; send('reset', {}); }
        while (now > pos) {
          const { text, next } = await readFrom(pos, now);
          pos = next;
          send('log', { text });
        }
      } catch { /* file rotated between stat and read */ } finally { busy = false; }
    };
    const poll = setInterval(tick, 1000);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(poll); clearInterval(ping); });
  }));

  // ----- log search -----
  app.get('/api/apps/:id/logs/search', wrap(async (req, res) => {
    service.mustGet(req.params.id);
    const q = String(req.query.q || '');
    if (!q || q.length > 200) throw new HttpError(400, 'Search for 1 to 200 characters');
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 300, 1000);
    // One search at a time: each reads up to 2 x 8 MB on a small machine.
    if (searching) throw new HttpError(429, 'Another log search is running, try again in a moment');
    searching = true;
    try {
    const needle = q.toLowerCase();
    const matches = [];
    let total = 0;
    for (const f of [`${req.params.id}.log.1`, `${req.params.id}.log`]) {
      const file = path.join(cfg.logDir, f);
      const st = await fs.stat(file).catch(() => null);
      if (!st) continue;
      const fh = await fs.promises.open(file, 'r');
      let text;
      try {
        const len = Math.min(st.size, SEARCH_BYTES);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.size - len);
        text = buf.toString('utf8');
      } finally { await fh.close(); }
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(needle)) {
          total += 1;
          matches.push({ file: f.endsWith('.1') ? 'previous' : 'current', line: i + 1, text: line.slice(0, 2000) });
        }
      });
    }
    res.json({ matches: matches.slice(-limit), total, truncated: total > limit });
    } finally {
      searching = false;
    }
  }));

  // ----- backups: verification and offsite copies -----
  app.post('/api/apps/:id/backups/:filename/verify', wrap(async (req, res) => {
    service.mustGet(req.params.id);
    backups.file(req.params.id, req.params.filename);
    if (!(await fs.pathExists(backups.file(req.params.id, req.params.filename)))) throw new HttpError(404, 'Backup not found');
    res.json(await backups.verify(req.params.id, req.params.filename));
  }));

  app.post('/api/apps/:id/backups/:filename/offsite', wrap(async (req, res) => {
    service.mustGet(req.params.id);
    if (!(await fs.pathExists(backups.file(req.params.id, req.params.filename)))) throw new HttpError(404, 'Backup not found');
    await backups.offsite(req.params.id, req.params.filename);
    res.json({ ok: true });
  }));

  app.get('/api/apps/:id/backups-remote', wrap(async (req, res) => {
    service.mustGet(req.params.id);
    res.json(await backups.remoteList(req.params.id));
  }));

  app.post('/api/apps/:id/backups-remote/:name/restore', wrap(async (req, res) => {
    service.mustGet(req.params.id);
    service.assertIdle(req.params.id);
    const local = await backups.fetchRemote(req.params.id, req.params.name);
    const task = await service.restore(req.params.id, local);
    res.status(202).json({ message: 'Restore started', task, local });
  }));
}

module.exports = { routes };
