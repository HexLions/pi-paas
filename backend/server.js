'use strict';
// Pi-PaaS entry point. createPanel() wires everything together without
// listening, so tests can drive the same code the service runs.
const fs = require('fs-extra');
const config = require('./config');
const { Registry } = require('./registry');
const { Auth } = require('./auth');
const { ProcessManager } = require('./processes');
const { Backups } = require('./backups');
const { AppService } = require('./apps');
const { createHttpApp } = require('./http');
const { run } = require('./util');

async function resolveRunAs(cfg, log) {
  if (!cfg.appUser) return null;
  if (process.getuid() !== 0) {
    log.warn(`[config] PIPAAS_APP_USER=${cfg.appUser} needs the panel to run as root; running apps as the current user instead`);
    return null;
  }
  const uid = Number((await run('id', ['-u', cfg.appUser])).stdout.trim());
  const gid = Number((await run('id', ['-g', cfg.appUser])).stdout.trim());
  return { uid, gid };
}

async function createPanel({ cfg = config.load(), log = console } = {}) {
  for (const d of [cfg.dataDir, cfg.appsDir, cfg.volumesDir, cfg.uploadDir, cfg.logDir, cfg.backupDir, cfg.homeDir]) {
    await fs.ensureDir(d);
  }
  const runAs = await resolveRunAs(cfg, log);
  // With a separate app user it must be able to walk into apps/, volumes/ and home/.
  await fs.chmod(cfg.dataDir, runAs ? 0o711 : 0o700).catch(() => {});
  for (const d of [cfg.uploadDir, cfg.logDir, cfg.backupDir]) await fs.chmod(d, 0o700).catch(() => {});
  // Leftovers from uploads or restores interrupted by a crash.
  await fs.emptyDir(cfg.uploadDir);

  const registry = new Registry(cfg.registryFile).load();
  const auth = new Auth(cfg, log);
  if (!cfg.authDisabled) auth.init();
  const pm = new ProcessManager(cfg, registry, { log, runAs });
  const backups = new Backups(cfg, registry, log);
  const service = new AppService(cfg, registry, pm, backups, { log, runAs });
  const app = createHttpApp({ cfg, auth, service, backups, log });
  return { cfg, registry, auth, pm, backups, service, app };
}

async function main() {
  const panel = await createPanel();
  const { cfg, service, backups, pm, app } = panel;
  if (cfg.authDisabled) console.warn('[auth] PIPAAS_AUTH=off: the panel is open to anyone who can reach it');

  const server = app.listen(cfg.port, cfg.host, () => {
    console.log(`Pi-PaaS ${cfg.version} listening on http://${cfg.host}:${cfg.port} (data: ${cfg.dataDir})`);
    service.restoreAll();
    backups.restoreSchedules();
  });
  server.requestTimeout = 0; // large uploads on slow Wi-Fi

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    console.log(`[panel] ${sig}: stopping apps`);
    server.close();
    backups.stopAll();
    await pm.stopAll();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createPanel };
