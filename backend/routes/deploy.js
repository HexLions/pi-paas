'use strict';
// Git pulls, push webhooks, previous versions and the template catalogue.
const path = require('path');
const sources = require('../sources');
const { HttpError, isValidId } = require('../util');

function publicRoutes(app, { service, registry, log }) {
  // Called by GitHub / GitLab / Gitea on push. Authenticated by the app's
  // webhook secret (HMAC signature or token), not by a session.
  app.post('/api/hooks/:id', (req, res) => {
    const id = req.params.id;
    const a = isValidId(id) ? registry.get(id) : null;
    // Same answer for "no such app" and "bad signature": nothing to probe.
    if (!a || !a.source || a.source.type !== 'git' || !sources.verifyHook(req, a.source.hookSecret)) {
      return res.status(401).json({ error: 'Invalid webhook' });
    }
    const event = req.get('X-GitHub-Event') || req.get('X-Gitea-Event') || req.get('X-Gitlab-Event') || 'push';
    if (/ping/i.test(event)) return res.json({ ok: true, message: 'pong' });
    const branch = sources.pushedBranch(req.body);
    if (branch && branch !== a.source.branch) return res.status(202).json({ ok: true, message: `Ignored: push to ${branch}, app follows ${a.source.branch}` });
    if (service.tasks.has(id)) {
      // A deploy is running: remember to pull again when it ends.
      service.pendingPull = service.pendingPull || new Set();
      service.pendingPull.add(id);
      return res.status(202).json({ ok: true, message: 'Queued after the current job' });
    }
    service.pull(id, null, `webhook ${event}`);
    log.log(`[hook] ${id}: pull started by ${event}`);
    res.status(202).json({ ok: true, message: 'Deploy started' });
  });
}

function routes(app, { service, wrap }) {
  app.get('/api/templates', (req, res) => res.json(sources.listTemplates()));

  app.post('/api/apps/:id/pull', (req, res) => {
    res.status(202).json(service.pull(req.params.id, req.hostname));
  });

  app.get('/api/apps/:id/source', (req, res) => {
    const a = service.mustGet(req.params.id);
    if (req.user.role === 'viewer') throw new HttpError(403, 'This needs the operator role');
    const s = a.source || { type: 'upload' };
    const base = `${req.protocol}://${req.get('host')}${req.baseUrl || ''}`;
    res.json({
      type: s.type, url: s.url, branch: s.branch, subdir: s.subdir, commit: s.commit, template: s.template, hasToken: !!s.token,
      ...(s.type === 'git' ? { webhookUrl: `${base}/api/hooks/${req.params.id}`, webhookSecret: s.hookSecret } : {}),
    });
  });

  app.put('/api/apps/:id/source', (req, res) => {
    const a = service.mustGet(req.params.id);
    if (!a.source || a.source.type !== 'git') throw new HttpError(400, 'This app was not deployed from git');
    const { gitBranch, gitToken, gitSubdir, rotateSecret } = req.body || {};
    const next = sources.parseSource({
      gitUrl: a.source.url, gitBranch: gitBranch || a.source.branch, gitSubdir: gitSubdir === undefined ? a.source.subdir : gitSubdir,
      gitToken: gitToken === undefined ? a.source.token : gitToken,
    });
    next.hookSecret = rotateSecret ? next.hookSecret : a.source.hookSecret;
    next.commit = a.source.commit;
    service.registry.update(req.params.id, { source: next });
    res.json({ ok: true });
  });

  app.get('/api/apps/:id/releases', (req, res) => res.json(service.listReleases(req.params.id)));

  app.post('/api/apps/:id/releases/:version/rollback', wrap(async (req, res) => {
    res.status(202).json(await service.rollback(req.params.id, req.params.version, req.hostname));
  }));

  // The command-line client, served by the panel itself.
  app.get('/cli/pipaas.js', (req, res) => {
    res.type('application/javascript').sendFile(path.join(__dirname, '..', '..', 'cli', 'pipaas.js'));
  });
}

module.exports = { public: publicRoutes, routes };
