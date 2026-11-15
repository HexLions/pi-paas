'use strict';
// Installs an app's dependencies and builds it. Output streams into the app
// log, so a slow "npm install" on a Pi can be followed live from the panel.
const fs = require('fs-extra');
const path = require('path');
const { run } = require('./util');
const { baseEnv } = require('./processes');
const runtimes = require('./runtimes');

async function buildApp(cfg, appDir, app, { runAs = null, onOutput, id = null } = {}) {
  const has = (f) => fs.existsSync(path.join(appDir, f));
  const opts = {
    cwd: appDir,
    env: { ...baseEnv(cfg, app), NODE_ENV: 'development' },
    timeout: cfg.buildTimeoutMs,
    onOutput,
    ...(runAs || {}),
  };
  const say = (msg) => onOutput && onOutput(Buffer.from(`[pi-paas] ${msg}\n`));
  const npmInstall = (prodOnly) => {
    const args = [has('package-lock.json') || has('npm-shrinkwrap.json') ? 'ci' : 'install', '--no-audit', '--no-fund'];
    if (prodOnly) args.push('--omit=dev');
    say(`npm ${args.join(' ')}`);
    return run('npm', args, prodOnly ? { ...opts, env: { ...opts.env, NODE_ENV: 'production' } } : opts);
  };

  if (app.type === 'node' && has('package.json')) {
    await npmInstall(true);
  } else if (app.type === 'react' && has('package.json')) {
    // Build tools (vite, react-scripts...) are devDependencies, so install everything.
    await npmInstall(false);
    const pkg = await fs.readJson(path.join(appDir, 'package.json'));
    if (pkg.scripts && pkg.scripts.build) {
      say('npm run build');
      await run('npm', ['run', 'build'], { ...opts, env: { ...opts.env, NODE_ENV: 'production' } });
    }
  } else if (app.type === 'python' && has('requirements.txt')) {
    const venv = path.join(appDir, 'venv');
    say('python3 -m venv venv');
    await run('python3', ['-m', 'venv', venv], opts);
    say('pip install -r requirements.txt');
    await run(path.join(venv, 'bin', 'pip'), ['install', '--disable-pip-version-check', '-r', 'requirements.txt'], opts);
  } else if (app.type === 'binary' && !app.startCommand) {
    const bin = runtimes.findBinary(appDir);
    if (!bin) throw new Error('No program found: name it app, server or main, or set a custom start command');
    await fs.chmod(path.join(appDir, bin), 0o755);
    say(`program: ./${bin}`);
  }
  for (const [cmd, args, extra = {}] of runtimes.extraBuildSteps(appDir, app, id)) {
    say(`${cmd} ${args.join(' ')}`);
    const stepOpts = extra.asPanel ? { ...opts, uid: undefined, gid: undefined, env: { ...opts.env, PATH: process.env.PATH } } : opts;
    await run(cmd, args, stepOpts);
  }
}

module.exports = { buildApp };
