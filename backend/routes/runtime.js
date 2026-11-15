'use strict';
// Runtimes, metrics, health, activity and scheduled tasks.
const runtimes = require('../runtimes');

function routes(app, { service, monitor, notifier, jobs, wrap }) {
  app.get('/api/runtimes', (req, res) => res.json(runtimes.availableRuntimes()));

  app.get('/api/system/history', (req, res) => res.json(monitor.system));

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
