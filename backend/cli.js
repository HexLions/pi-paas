'use strict';
// Admin commands for the machine running Pi-PaaS (stop nothing, edit auth.json):
//   node backend/cli.js set-password [user] [password]   (asks, or reads stdin when piped)
//   node backend/cli.js add-user <user> <viewer|operator|admin> [password]
//   node backend/cli.js reset-2fa <user>
//   node backend/cli.js users
// The panel picks up changes after a restart.
const readline = require('readline');
const fs = require('fs-extra');
const config = require('./config');
const { Auth } = require('./auth');

async function ask(question) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0];
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

const USAGE = `Usage:
  node backend/cli.js set-password [user] [password]
  node backend/cli.js add-user <user> <viewer|operator|admin> [password]
  node backend/cli.js reset-2fa <user>
  node backend/cli.js users`;

async function main([cmd, ...args]) {
  const cfg = config.load();
  await fs.ensureDir(cfg.dataDir);
  const auth = new Auth({ ...cfg, initialPassword: cfg.initialPassword || 'placeholder-unused' }, { warn() {} });
  if (fs.existsSync(cfg.authFile)) auth.init();
  else auth.state = { version: 2, secret: require('crypto').randomBytes(32).toString('hex'), users: {}, tokens: [] };

  if (cmd === 'set-password') {
    const [user = 'admin', pw] = args;
    const password = pw || (await ask(`New password for ${user} (min 8 characters): `));
    auth.setPassword(password.trim(), user);
    if (user === 'admin') await fs.remove(cfg.initialPasswordFile);
    console.log(`Password for ${user} updated. Their sessions are logged out (restart the panel to apply).`);
  } else if (cmd === 'add-user') {
    const [user, role, pw] = args;
    if (!user || !role) throw new Error(USAGE);
    const password = pw || (await ask(`Password for ${user} (min 8 characters): `));
    auth.createUser(user, password.trim(), role);
    console.log(`User ${user} (${role}) created.`);
  } else if (cmd === 'reset-2fa') {
    if (!args[0]) throw new Error(USAGE);
    auth.disableTotp(args[0]);
    console.log(`2FA removed for ${args[0]}.`);
  } else if (cmd === 'users') {
    for (const u of auth.listUsers()) console.log(`${u.name}\t${u.role}${u.totp ? '\t2FA' : ''}`);
  } else {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
