'use strict';
// Runtimes, metrics, health, activity and scheduled tasks.
const runtimes = require('../runtimes');

function routes(app, { service, monitor, notifier, jobs, proxy, wrap }) {
  app.get('/api/runtimes', (req, res) => res.json(runtimes.availableRuntimes(service.cfg)));

  app.get('/api/proxy', (req, res) => res.json({
    http: proxy.ports.http, https: proxy.ports.https, certificates: proxy.certStatus(),
  }));

  app.get('/api/system/history', (req, res) => res.json(monitor.system));

  // One call with everything a dashboard widget needs (HexDeck, Home Assistant…).
  app.get('/api/summary', wrap(async (req, res) => {
    const { systemInfo } = require('../http');
    const sys = await systemInfo(service.cfg);
    const apps = service.list(req.hostname).map((a) => ({
      id: a.id, name: a.name, type: a.type, status: a.status, port: a.port, url: (a.links && a.links[0]) || a.url, version: a.version,
      cpu: a.metrics ? a.metrics.cpu : null, memory: a.metrics ? a.metrics.mem : null,
      healthy: a.metrics && a.metrics.health ? a.metrics.health.ok : null, lastError: a.lastError ? a.lastError.message : null,
    }));
    const count = (s) => apps.filter((a) => a.status === s).length;
    res.json({
      version: sys.version,
      hostname: sys.hostname,
      system: { temperature: sys.temperature, load: sys.load[0], cpus: sys.cpus, memory: sys.memory, disk: sys.disk, uptime: sys.uptime },
      totals: { apps: apps.length, running: count('running'), stopped: count('stopped'), crashed: count('crashed'), unhealthy: apps.filter((a) => a.healthy === false).length },
      apps,
    });
  }));

  app.get('/api/events', (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    res.json(notifier.recent(limit, req.query.app || null));
  });

  app.get('/api/apps/:id/metrics', (req, res) => {
    service.mustGet(req.params.id);
    res.json({ series: monitor.history(req.params.id), current: monitor.current(req.params.id) });
  });

  app.get('/api/apps/:id/jobs', (req, res) => {
    service.mustGet(req.params.id);
    res.json(jobs.list(req.params.id));
  });
  app.post('/api/apps/:id/jobs', (req, res) => {
    service.mustGet(req.params.id);
    res.status(201).json(jobs.add(req.params.id, req.body || {}));
  });
  app.put('/api/apps/:id/jobs/:job', (req, res) => {
    service.mustGet(req.params.id);
    res.json(jobs.edit(req.params.id, req.params.job, req.body || {}));
  });
  app.delete('/api/apps/:id/jobs/:job', (req, res) => {
    service.mustGet(req.params.id);
    jobs.remove(req.params.id, req.params.job);
    res.json({ ok: true });
  });
  app.post('/api/apps/:id/jobs/:job/run', wrap(async (req, res) => {
    service.mustGet(req.params.id);
    // Answer at once; the result lands in the log and on the task.
    const p = jobs.runNow(req.params.id, req.params.job);
    p.catch(() => {});
    await Promise.race([p, new Promise((r) => setTimeout(r, 300))]); // quick refusals (busy, unknown) still reach the caller
    res.status(202).json({ ok: true });
  }));
}

module.exports = { routes };
