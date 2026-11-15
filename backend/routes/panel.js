'use strict';
// Browser push subscriptions and panel updates.
const { HttpError } = require('../util');

function routes(app, { push, updater, wrap }) {
  app.get('/api/push/key', (req, res) => res.json({ publicKey: push.publicKey(), subscribed: push.count(req.user.name) }));
  app.post('/api/push/subscribe', (req, res) => {
    push.subscribe((req.body || {}).subscription, req.user.name);
    res.status(201).json({ ok: true });
  });
  app.delete('/api/push/subscribe', (req, res) => {
    const endpoint = (req.body || {}).endpoint;
    if (typeof endpoint !== 'string') throw new HttpError(400, 'endpoint required');
    push.unsubscribe(endpoint, req.user.name);
    res.json({ ok: true });
  });
  app.post('/api/push/test', wrap(async (req, res) => {
    await push.send('Pi-PaaS', 'Notifications on this device work.', { level: 'info' }, { user: req.user.name });
    res.json({ ok: true });
  }));

  app.get('/api/panel/update', (req, res) => res.json(updater.status()));
  app.post('/api/panel/update/check', wrap(async (req, res) => res.json(await updater.check())));
  app.post('/api/panel/update', (req, res) => res.status(202).json(updater.apply()));
}

module.exports = { routes };
