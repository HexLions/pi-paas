'use strict';
// Panel self-update from GitHub releases.
//  - check(): the latest release, compared with the running version;
//  - apply(): a git checkout of the code folder moves to the release tag;
//    a copied install gets the release tarball, prepared next to the code,
//    swapped in (the old code stays in <code>.previous) and the panel exits
//    so systemd / OpenRC start the new version.
const fs = require('fs-extra');
const path = require('path');
const { run } = require('./util');

const CODE_DIR = path.join(__dirname, '..');
const CHECK_EVERY = 24 * 3600000;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/** >0 when a is newer than b. Pre-releases sort before their release. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

class Updater {
  constructor({ cfg, settings, notifier, log = console, codeDir = CODE_DIR }) {
    Object.assign(this, { cfg, settings, notifier, log, codeDir });
    this.repo = process.env.PIPAAS_UPDATE_REPO || 'HexLions/pi-paas';
    this.api = (process.env.PIPAAS_UPDATE_API || 'https://api.github.com').replace(/\/+$/, '');
    this.latest = null;
    this.checkedAt = null;
    this.error = null;
    this.state = 'idle'; // idle | updating | restarting | failed
    this.log2 = [];
    this.exit = () => process.exit(0);
  }

  mode() {
    // In a container the code belongs to the image: update by pulling a new one.
    if (this.cfg.containerMode || fs.existsSync('/.dockerenv')) return 'image';
    return fs.existsSync(path.join(this.codeDir, '.git')) ? 'git' : 'tarball';
  }

  status() {
    const available = this.latest && compareVersions(this.latest.version, this.cfg.version) > 0;
    return {
      current: this.cfg.version,
      latest: this.latest,
      available: !!available,
      checkedAt: this.checkedAt,
      error: this.error,
      mode: this.mode(),
      state: this.state,
      output: this.log2.slice(-40).join(''),
    };
  }

  start() {
    const tick = () => { if (this.settings.get().updates.check) this.check().catch(() => {}); };
    this.timer = setInterval(tick, CHECK_EVERY);
    this.timer.unref();
    setTimeout(tick, 60000).unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  async check() {
    try {
      const res = await fetch(`${this.api}/repos/${this.repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `pi-paas/${this.cfg.version}` },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) throw new Error('No releases published yet');
      if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
      const r = await res.json();
      if (!parseVersion(r.tag_name)) throw new Error(`Unexpected release tag ${r.tag_name}`);
      const prev = this.latest && this.latest.version;
      this.latest = {
        version: r.tag_name.replace(/^v/, ''), tag: r.tag_name, url: r.html_url, notes: String(r.body || '').slice(0, 20000), publishedAt: r.published_at,
      };
      this.error = null;
      if (compareVersions(this.latest.version, this.cfg.version) > 0 && prev !== this.latest.version) {
        this.notifier.notify('update', { level: 'info', key: `update:${this.latest.version}`, title: `Pi-PaaS ${this.latest.version} is available`, message: `You run ${this.cfg.version}. Update from the panel settings.` });
      }
    } catch (err) {
      this.error = err.message;
    }
    this.checkedAt = new Date().toISOString();
    return this.status();
  }

  out(chunk) {
    this.log2.push(String(chunk));
    if (this.log2.length > 400) this.log2.splice(0, 200);
  }

  /** Start the update in the background; the panel restarts at the end. */
  apply() {
    const st = this.status();
    if (!st.available) throw Object.assign(new Error('No newer version to install'), { status: 400 });
    if (this.state === 'updating' || this.state === 'restarting') throw Object.assign(new Error('An update is already running'), { status: 409 });
    if (this.mode() === 'image') {
      throw Object.assign(new Error('Pi-PaaS runs in a container: pull the new image and recreate the container (docker compose pull && docker compose up -d, or "Re-pull image" in Portainer)'), { status: 400 });
    }
    this.state = 'updating';
    this.log2 = [];
    this.running = (this.mode() === 'git' ? this.applyGit(st.latest) : this.applyTarball(st.latest)).then(() => {
      this.state = 'restarting';
      this.out(`Installed ${st.latest.version}. Restarting the panel…\n`);
      this.log.log(`[update] ${this.cfg.version} -> ${st.latest.version}, restarting`);
      setTimeout(() => this.exit(), 1500);
    }).catch((err) => {
      this.state = 'failed';
      this.error = err.message;
      this.out(`Update failed: ${err.message}\n`);
      this.log.error(`[update] failed: ${err.message}`);
    });
    return this.status();
  }

  async applyGit(latest) {
    const git = (...args) => run('git', ['-C', this.codeDir, ...args], { timeout: 5 * 60000, onOutput: (c) => this.out(c) });
    const { stdout } = await git('status', '--porcelain', '--untracked-files=no');
    if (stdout.trim()) throw new Error('The code folder has local changes; commit or undo them, or update with git yourself');
    this.out(`git fetch ${latest.tag}\n`);
    await git('fetch', '--no-tags', 'origin', `refs/tags/${latest.tag}:refs/tags/${latest.tag}`);
    await git('checkout', '--quiet', '--detach', latest.tag);
    await this.npm(this.codeDir);
  }

  async applyTarball(latest) {
    const next = `${this.codeDir}.next`;
    const prev = `${this.codeDir}.previous`;
    const tgz = `${next}.tar.gz`;
    await fs.remove(next);
    await fs.ensureDir(next);
    try {
      const url = `${process.env.PIPAAS_UPDATE_DOWNLOAD || 'https://codeload.github.com'}/${this.repo}/tar.gz/refs/tags/${latest.tag}`;
      this.out(`Downloading ${url}\n`);
      const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60000) });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      await fs.writeFile(tgz, Buffer.from(await res.arrayBuffer()));
      await run('tar', ['-xzf', tgz, '-C', next, '--strip-components=1', '--no-same-owner'], { timeout: 5 * 60000 });
      if (!(await fs.pathExists(path.join(next, 'backend', 'server.js')))) throw new Error('the download does not look like Pi-PaaS');
      await this.npm(next);
      await fs.remove(prev);
      await fs.move(this.codeDir, prev);
      await fs.move(next, this.codeDir);
      this.out(`The previous version is kept in ${prev}\n`);
    } catch (err) {
      await fs.remove(next);
      throw err;
    } finally {
      await fs.remove(tgz);
    }
  }

  async npm(dir) {
    this.out('npm ci --omit=dev\n');
    const hasLock = await fs.pathExists(path.join(dir, 'package-lock.json'));
    await run('npm', [hasLock ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, timeout: 15 * 60000, onOutput: (c) => this.out(c) });
  }
}

module.exports = { Updater, compareVersions, parseVersion };
