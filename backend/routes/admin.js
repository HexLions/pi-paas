'use strict';
// Accounts, 2FA, API tokens and panel settings.
const { HttpError } = require('../util');
const { roleRank } = require('../auth');

function routes(app, { auth, settings, notifier, wrap }) {
  const self = (req) => {
    if (req.user.via === 'token') throw new HttpError(403, 'Use the panel for account changes');
    return req.user.name;
  };

  // ----- own 2FA -----
  app.post('/api/auth/totp', (req, res) => {
    res.json(auth.startTotp(self(req)));
  });
  app.put('/api/auth/totp', (req, res) => {
    auth.enableTotp(self(req), (req.body || {}).code);
    res.json({ ok: true });
  });
  app.delete('/api/auth/totp', (req, res) => {
    const name = self(req);
    if (!auth.checkPassword((req.body || {}).password, name)) throw new HttpError(401, 'Password is wrong');
    auth.disableTotp(name);
    res.json({ ok: true });
  });

  // ----- users (admin) -----
  app.get('/api/users', (req, res) => res.json(auth.listUsers()));
  app.post('/api/users', (req, res) => {
    const { username, password, role } = req.body || {};
    auth.createUser(String(username || '').trim().toLowerCase(), password, role);
    res.status(201).json({ ok: true });
  });
  app.put('/api/users/:name', (req, res) => {
    const { role, password } = req.body || {};
    if (req.params.name === req.user.name && role && role !== 'admin') throw new HttpError(400, 'You cannot remove your own admin role');
    auth.updateUser(req.params.name, { role, password });
    res.json({ ok: true });
  });
  app.delete('/api/users/:name/totp', (req, res) => {
    auth.disableTotp(req.params.name);
    res.json({ ok: true });
  });
  app.delete('/api/users/:name', (req, res) => {
    if (req.params.name === req.user.name) throw new HttpError(400, 'You cannot delete yourself');
    auth.deleteUser(req.params.name);
    res.json({ ok: true });
  });

  // ----- API tokens -----
  const isAdmin = (req) => roleRank(req.user.role) >= roleRank('admin');
  app.get('/api/tokens', (req, res) => res.json(auth.listApiTokens(req.user.name, isAdmin(req) && req.query.all === '1')));
  app.post('/api/tokens', (req, res) => {
    const { name, role } = req.body || {};
    res.status(201).json(auth.createApiToken(self(req), name, role));
  });
  app.delete('/api/tokens/:id', (req, res) => {
    auth.deleteApiToken(req.params.id, req.user.name, isAdmin(req));
    res.json({ ok: true });
  });

  // ----- panel settings (admin) -----
  app.get('/api/settings', (req, res) => res.json(settings.masked()));
  app.put('/api/settings', (req, res) => {
    settings.update(req.body || {});
    res.json(settings.masked());
  });
  app.post('/api/settings/test-notification', wrap(async (req, res) => {
    const results = await notifier.test();
    res.json({ results });
  }));
}

module.exports = { routes };
