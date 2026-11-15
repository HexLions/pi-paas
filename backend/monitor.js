'use strict';
// Background watcher:
//  - every 10 s: CPU and memory of each app (all processes of its group, read
//    from /proc) and of the whole machine, kept for one hour;
//  - every 30 s: an HTTP health check per app;
//  - every 5 min: CPU temperature and disk space alerts.
const fs = require('fs');
const os = require('os');
const http = require('http');

const SAMPLE_MS = 10000;
const HEALTH_MS = 30000;
const SYSTEM_MS = 5 * 60000;
const KEEP = 360; // one hour of 10 s samples
const START_GRACE_MS = 45000;
const FAILS_BEFORE_ALERT = 3;
const CLK_TCK = 100; // USER_HZ, 100 on every Linux the Pi runs

/** One pass over /proc: { pgid -> { ticks, rssKb, procs } } for the wanted groups. */
function readGroups(pgids, procDir = '/proc') {
  const want = new Set(pgids);
  const out = new Map();
  if (!want.size) return out;
  let entries;
  try { entries = fs.readdirSync(procDir); } catch { return out; }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try { stat = fs.readFileSync(`${procDir}/${name}/stat`, 'utf8'); } catch { continue; }
    // The command name may contain spaces and brackets: split after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgrp = Number(rest[2]);
    if (!want.has(pgrp)) continue;
    const ticks = Number(rest[11]) + Number(rest[12]);
    let rssKb = 0;
    try {
      const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`${procDir}/${name}/status`, 'utf8'));
      if (m) rssKb = Number(m[1]);
    } catch { /* process just ended */ }
    const g = out.get(pgrp) || { ticks: 0, rssKb: 0, procs: 0 };
    g.ticks += ticks;
    g.rssKb += rssKb;
    g.procs += 1;
    out.set(pgrp, g);
  }
  return out;
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const [k, v] of Object.entries(c.times)) {
      total += v;
      if (k === 'idle') idle += v;
    }
  }
  return { idle, total };
}

function readTemp() {
  try { return Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 1000; } catch { return null; }
}

function probe(port, pathName, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout: timeoutMs, headers: { 'User-Agent': 'Pi-PaaS health check' } }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, status: res.statusCode, ms: Date.now() - started });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', ms: Date.now() - started }); });
    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message, ms: Date.now() - started }));
  });
}

class Monitor {
  constructor({ cfg, registry, pm, service, settings, notifier, log = console }) {
    Object.assign(this, { cfg, registry, pm, service, settings, notifier, log });
    this.series = new Map(); // id -> [{t, cpu, mem}]
    this.lastTicks = new Map(); // id -> { ticks, at, pid }
    this.system = [];
    this.lastCpu = null;
    this.health = new Map(); // id -> { ok, fails, status, ms, at, error, alerted }
    this.timers = [];
    this.graceMs = START_GRACE_MS;
  }

  start() {
    this.timers.push(setInterval(() => this.sample(), SAMPLE_MS));
    this.timers.push(setInterval(() => this.checkHealth().catch(() => {}), HEALTH_MS));
    this.timers.push(setInterval(() => this.checkSystem().catch(() => {}), SYSTEM_MS));
    for (const t of this.timers) t.unref();
    this.sample();
    return this;
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  sample(now = Date.now()) {
    const running = this.registry.all().map((a) => ({ id: a.id, pid: this.pm.info(a.id).pid })).filter((a) => a.pid);
    const groups = readGroups(running.map((a) => a.pid));
    for (const { id, pid } of running) {
      const g = groups.get(pid);
      if (!g) continue;
      const prev = this.lastTicks.get(id);
      let cpu = null;
      if (prev && prev.pid === pid && now > prev.at) {
        cpu = Math.max(0, ((g.ticks - prev.ticks) / CLK_TCK) / ((now - prev.at) / 1000) * 100);
      }
      this.lastTicks.set(id, { ticks: g.ticks, at: now, pid });
      push(this.series, id, { t: now, cpu: cpu === null ? null : round(cpu), mem: g.rssKb * 1024, procs: g.procs });
    }
    for (const id of [...this.series.keys()]) if (!this.registry.get(id)) { this.series.delete(id); this.lastTicks.delete(id); }

    const times = cpuTimes();
    let cpu = null;
    if (this.lastCpu && times.total > this.lastCpu.total) {
      cpu = 100 * (1 - (times.idle - this.lastCpu.idle) / (times.total - this.lastCpu.total));
    }
    this.lastCpu = times;
    this.system.push({ t: now, cpu: cpu === null ? null : round(cpu), mem: os.totalmem() - os.freemem(), temp: readTemp() });
    if (this.system.length > KEEP) this.system.shift();
  }

  current(id) {
    const s = this.series.get(id);
    const last = s && s[s.length - 1];
    const h = this.health.get(id);
    return {
      cpu: last ? last.cpu : null,
      mem: last ? last.mem : null,
      health: h ? { ok: h.ok, status: h.status || null, ms: h.ms, at: h.at, error: h.error || null } : null,
    };
  }

  history(id) {
    return this.series.get(id) || [];
  }

  async checkHealth() {
    for (const app of this.registry.all()) {
      const info = this.pm.info(app.id);
      const hc = app.health || {};
      if (info.status !== 'running' || hc.enabled === false || app.type === 'binary' && !hc.path) {
        this.health.delete(app.id);
        continue;
      }
      if (info.startedAt && Date.now() - Date.parse(info.startedAt) < this.graceMs) continue;
      const r = await probe(app.port, hc.path || '/');
      const h = this.health.get(app.id) || { fails: 0, alerted: false };
      Object.assign(h, { ok: r.ok, status: r.status, ms: r.ms, error: r.error, at: new Date().toISOString() });
      h.fails = r.ok ? 0 : h.fails + 1;
      this.health.set(app.id, h);
      if (h.fails >= FAILS_BEFORE_ALERT && !h.alerted) {
        h.alerted = true;
        this.pm.note(app.id, `Health check failed ${h.fails} times (${r.error || `HTTP ${r.status}`})`);
        this.notifier.notify('unhealthy', {
          app: app.id, level: 'error', title: `${app.name} is not responding`,
          message: `GET ${hc.path || '/'} on port ${app.port} failed ${h.fails} times: ${r.error || `HTTP ${r.status}`}.${hc.restart ? ' Restarting it.' : ''}`,
        });
        if (hc.restart) {
          h.fails = 0;
          h.alerted = false;
          this.pm.restart(app.id).catch((err) => this.pm.note(app.id, `Restart after failed health check failed: ${err.message}`));
        }
      } else if (r.ok && h.alerted) {
        h.alerted = false;
        this.notifier.notify('recovered', { app: app.id, level: 'ok', title: `${app.name} is responding again`, message: `GET ${hc.path || '/'} answered HTTP ${r.status}.` });
      }
    }
  }

  async checkSystem() {
    const n = this.settings.get().notifications;
    const temp = readTemp();
    if (temp !== null && temp >= n.tempLimit) {
      this.notifier.notify('temperature', { level: 'error', title: `CPU at ${temp.toFixed(0)} °C`, message: `The temperature is above the ${n.tempLimit} °C limit. Check the cooling.` });
    }
    try {
      const s = fs.statfsSync(this.cfg.dataDir);
      const used = 100 * (1 - s.bavail / s.blocks);
      if (used >= n.diskLimitPercent) {
        this.notifier.notify('disk', { level: 'error', title: `Disk ${used.toFixed(0)} % full`, message: `Only ${(s.bavail * s.bsize / 1073741824).toFixed(1)} GB left for app data. Delete old backups or logs.` });
      }
    } catch { /* statfs needs Node 18.15+ */ }
  }
}

function push(map, id, v) {
  const s = map.get(id) || [];
  s.push(v);
  if (s.length > KEEP) s.shift();
  map.set(id, s);
}

function round(n) {
  return Math.round(n * 10) / 10;
}

module.exports = { Monitor, readGroups, probe };
