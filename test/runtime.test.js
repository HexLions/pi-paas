'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const http = require('http');
const path = require('path');
const { startPanel, makeZip, zipForm, waitFor, tmpDir } = require('./helpers');
const runtimes = require('../backend/runtimes');
const { readGroups } = require('../backend/monitor');

describe('runtimes', () => {
  it('starts each app type with the right command', async () => {
    const d = await tmpDir();
    const cfg = { volumesDir: '/data/volumes' };
    await fs.outputFile(path.join(d, 'public/index.php'), '<?php echo 1;');
    let c = runtimes.resolveCommand(d, { type: 'php', port: 3005 });
    assert.deepEqual([c.cmd, ...c.args], ['php', '-S', '0.0.0.0:3005', '-t', path.join(d, 'public')]);
    await fs.writeFile(path.join(d, 'main.ts'), '');
    c = runtimes.resolveCommand(d, { type: 'deno', port: 1 }, { cfg, id: 'x' });
    assert.equal(c.cmd, 'deno');
    assert.ok(c.args.includes('--allow-write=/data/volumes/x'));
    assert.ok(!c.args.includes('--allow-all') && !c.args.includes('-A'));
    await fs.writeJson(path.join(d, 'deno.json'), { tasks: { start: 'deno run -A main.ts' } });
    assert.deepEqual(runtimes.resolveCommand(d, { type: 'deno', port: 1 }, { cfg, id: 'x' }).args, ['task', 'start']);
    await fs.writeJson(path.join(d, 'package.json'), { scripts: { start: 'bun server.ts' } });
    assert.deepEqual(runtimes.resolveCommand(d, { type: 'bun', port: 1 }).args, ['run', 'start']);
    await fs.writeFile(path.join(d, 'server'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(runtimes.resolveCommand(d, { type: 'binary', port: 1 }).cmd, path.join(d, 'server'));
    await fs.remove(d);
  });

  it('runs docker apps in the foreground with host networking and hidden env values', () => {
    const c = runtimes.resolveCommand('/a', { type: 'docker', port: 3009, limits: { memoryMb: 256, cpuPercent: 50 } }, { id: 'web', cfg: { volumesDir: '/v' }, env: { PORT: '3009', SECRET: 'shh' }, runAs: { uid: 999, gid: 999 } });
    assert.equal(c.cmd, 'docker');
    assert.ok(c.args.join(' ').includes('--name pipaas-web --network host'));
    assert.ok(c.args.includes('SECRET'));
    assert.ok(!c.args.join(' ').includes('shh'));
    assert.ok(c.args.join(' ').includes('--memory 256m --cpus 0.50'));
    assert.ok(c.args.join(' ').includes('--user 999:999'));
    assert.equal(c.args.at(-1), 'pipaas-web:latest');
    const env = runtimes.dockerEnv({ SQLITE_PATH: '/v/web/data.db', DATABASE_URL: 'sqlite:/v/web/data.db' }, '/v/web');
    assert.equal(env.SQLITE_PATH, '/data/data.db');
    assert.equal(env.DATABASE_URL, 'sqlite:/data/data.db');
  });

  it('puts limits around a command', () => {
    const cmd = { cmd: 'node', args: ['s.js'] };
    const sd = runtimes.applyLimits(cmd, { type: 'node', limits: { memoryMb: 128, cpuPercent: 50, nice: 10 } }, { systemd: true, runAs: { uid: 5, gid: 6 } });
    assert.equal(sd.cmd, 'nice');
    assert.deepEqual(sd.args, ['-n', '10', 'systemd-run', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=128M', '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=50%', '--uid=5', '--gid=6', '--', 'node', 's.js']);
    assert.equal(sd.setsUser, true);
    const plain = runtimes.applyLimits(cmd, { type: 'node', limits: { memoryMb: 128 } }, { systemd: false, env: {} });
    assert.equal(plain.cmd, 'node');
    assert.match(plain.env.NODE_OPTIONS, /--max-old-space-size=96/);
    assert.throws(() => runtimes.validateLimits({ memoryMb: 5 }), /between 32/);
    assert.deepEqual(runtimes.validateLimits({ memoryMb: '256', cpuPercent: '', nice: 0 }), { memoryMb: 256 });
  });

  it('reads process groups from /proc', async () => {
    const d = await tmpDir();
    const mk = async (pid, pgrp, ticks, rss) => {
      await fs.outputFile(path.join(d, `${pid}/stat`), `${pid} (we ird) name) S 1 ${pgrp} ${pgrp} 0 -1 0 0 0 0 0 ${ticks} ${ticks} 0 0 20 0 1 0 0 0 0`);
      await fs.outputFile(path.join(d, `${pid}/status`), `Name:\tx\nVmRSS:\t   ${rss} kB\n`);
    };
    await mk(100, 100, 10, 1000);
    await mk(101, 100, 5, 500);
    await mk(200, 200, 7, 70);
    const g = readGroups([100], d);
    assert.deepEqual(g.get(100), { ticks: 30, rssKb: 1500, procs: 2 });
    assert.equal(g.has(200), false);
    await fs.remove(d);
  });
});

describe('monitoring, notifications and tasks', () => {
  let p;
  let hook;
  const received = [];
  before(async () => {
    hook = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push({ url: req.url, headers: req.headers, body }); res.end('ok'); });
    });
    await new Promise((r) => hook.listen(0, '127.0.0.1', r));
    p = await startPanel({ PIPAAS_PORT_RANGE: '39400-39430' });
    await p.login();
    const port = hook.address().port;
    const r = await p.req('PUT', '/api/settings', { json: { notifications: { webhook: { enabled: true, url: `http://127.0.0.1:${port}/hook` }, ntfy: { enabled: true, url: `http://127.0.0.1:${port}/`, topic: 'pi' } } } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  });
  after(async () => { await p.close(); hook.close(); });

  it('sends a test notification to every channel', async () => {
    const r = await p.req('POST', '/api/settings/test-notification');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.results.map((x) => [x.channel, x.ok]).sort(), [['ntfy', true], ['webhook', true]]);
    const ntfy = received.find((x) => x.url === '/pi');
    assert.equal(ntfy.headers.title, 'Pi-PaaS test');
    assert.match(JSON.parse(received.find((x) => x.url === '/hook').body).title, /test/);
  });

  it('measures app memory and CPU, and alerts on failed health checks', async () => {
    const app = makeZip([{ name: 'server.js', data: "require('http').createServer((q,s)=>{s.statusCode=q.url==='/bad'?500:200;s.end(String(process.env.NODE_OPTIONS||''))}).listen(process.env.PORT)" }]);
    await p.req('POST', '/api/apps', { form: zipForm({ name: 'probe', type: 'node' }, 'p.zip', app) });
    await p.service.settle();
    p.monitor.sample(Date.now() - 1000);
    await new Promise((r) => setTimeout(r, 200));
    p.monitor.sample();
    const m = (await p.req('GET', '/api/apps/probe/metrics')).data;
    assert.ok(m.series.length >= 1);
    assert.ok(m.current.mem > 1024 * 1024, `rss ${m.current.mem}`);

    p.monitor.graceMs = 0;
    await p.req('PUT', '/api/apps/probe/settings', { json: { health: { path: '/bad' }, limits: { memoryMb: 200 } } });
    const url = `http://127.0.0.1:${(await p.req('GET', '/api/apps/probe')).data.port}/`;
    assert.match(await waitFor(() => fetch(url).then((x) => x.text()).catch(() => null)), /--max-old-space-size=150/);
    for (let i = 0; i < 3; i++) await p.monitor.checkHealth();
    const view = (await p.req('GET', '/api/apps/probe')).data;
    assert.equal(view.metrics.health.ok, false);
    assert.equal(view.metrics.health.status, 500);
    await waitFor(() => received.find((x) => x.url === '/hook' && /not responding/.test(x.body)));
    const events = (await p.req('GET', '/api/events?app=probe')).data;
    assert.equal(events[0].kind, 'unhealthy');
  });

  it('runs scheduled tasks with the app environment', async () => {
    assert.equal((await p.req('POST', '/api/apps/probe/jobs', { json: { name: 'x', schedule: 'every minute', command: 'true' } })).status, 400);
    const job = (await p.req('POST', '/api/apps/probe/jobs', { json: { name: 'Write file', schedule: '0 3 * * *', command: 'echo "$PIPAAS_APP_ID" > "$DATA_DIR/out.txt"' } })).data;
    assert.equal((await p.req('POST', `/api/apps/probe/jobs/${job.id}/run`)).status, 202);
    await waitFor(async () => (await p.req('GET', '/api/apps/probe/jobs')).data[0].lastRun);
    assert.equal((await fs.readFile(path.join(p.dataDir, 'volumes/probe/out.txt'), 'utf8')).trim(), 'probe');
    const failing = (await p.req('POST', '/api/apps/probe/jobs', { json: { name: 'Fails', schedule: '0 4 * * *', command: 'exit 7' } })).data;
    await p.req('POST', `/api/apps/probe/jobs/${failing.id}/run`);
    const last = await waitFor(async () => (await p.req('GET', '/api/apps/probe/jobs')).data.find((j) => j.id === failing.id).lastRun);
    assert.equal(last.code, 7);
    assert.equal((await p.req('DELETE', `/api/apps/probe/jobs/${failing.id}`)).status, 200);
    assert.match((await p.req('GET', '/api/apps/probe/logs')).data.logs, /Task "Write file" finished/);
  });

  it('runs a "binary" app from an executable in the ZIP', async () => {
    const bin = makeZip([{ name: 'app', data: `#!/bin/sh\nexec ${process.execPath} -e "require('http').createServer((q,s)=>s.end('bin ok')).listen(process.env.PORT)"\n`, mode: 0o100755 }]);
    const r = await p.req('POST', '/api/apps', { form: zipForm({ name: 'bin', type: 'binary' }, 'b.zip', bin) });
    assert.equal(r.status, 202);
    const a = await (async () => { await p.service.settle(); return (await p.req('GET', '/api/apps/bin')).data; })();
    assert.equal(a.status, 'running', JSON.stringify(a.lastError));
    assert.equal(await waitFor(() => fetch(`http://127.0.0.1:${a.port}/`).then((x) => x.text()).catch(() => null)), 'bin ok');
  });

  it('refuses app types whose runtime is missing', async () => {
    const missing = Object.entries((await p.req('GET', '/api/runtimes')).data).find(([, ok]) => !ok);
    if (!missing) return;
    const r = await p.req('POST', '/api/apps', { form: zipForm({ name: 'nope', type: missing[0] }, 'n.zip', makeZip([{ name: 'x', data: 'x' }])) });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /not installed/);
  });
});
