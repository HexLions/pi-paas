'use strict';
// Small admin commands for the machine running Pi-PaaS:
//   node backend/cli.js set-password            (asks, or reads stdin when piped)
//   node backend/cli.js set-password <password>
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

async function main([cmd, arg]) {
  const cfg = config.load();
  if (cmd !== 'set-password') {
    console.log('Usage: node backend/cli.js set-password [password]');
    process.exit(cmd ? 1 : 0);
  }
  await fs.ensureDir(cfg.dataDir);
  const password = arg || (await ask('New panel password (min 8 characters): '));
  new Auth(cfg).setPassword(password.trim());
  await fs.remove(cfg.initialPasswordFile);
  console.log(`Password updated in ${cfg.authFile}. Existing sessions are logged out.`);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
