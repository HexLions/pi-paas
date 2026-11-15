'use strict';
// Where an app's code comes from: an uploaded .zip/.html, a git repository,
// or one of the bundled templates. materialize() puts the code into a folder.
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { extractZip } = require('./archive');
const { run, HttpError, safeResolve } = require('./util');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

function listTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs.readdirSync(TEMPLATES_DIR).filter((n) => fs.existsSync(path.join(TEMPLATES_DIR, n, 'template.json'))).map((n) => {
    const meta = fs.readJsonSync(path.join(TEMPLATES_DIR, n, 'template.json'));
    return { id: n, ...meta };
  }).sort((a, b) => (a.order || 99) - (b.order || 99));
}

function validGitUrl(url) {
  if (typeof url !== 'string' || url.length > 500 || /[\s\0]/.test(url) || url.startsWith('-')) return false;
  if (/^https:\/\/[^/]+\/.+/.test(url)) return true;
  if (/^ssh:\/\/[^/]+\/.+/.test(url)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(url)) return true; // git@github.com:me/repo.git
  if (process.env.PIPAAS_ALLOW_LOCAL_GIT === '1' && /^file:\/\/\//.test(url)) return true;
  return false;
}

function validBranch(b) {
  return typeof b === 'string' && /^[A-Za-z0-9._/-]{1,100}$/.test(b) && !b.startsWith('-') && !b.includes('..');
}

function validSubdir(d) {
  return d === '' || (typeof d === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(d) && !d.split('/').includes('..') && !d.startsWith('/'));
}

/** Build a source descriptor from request fields. Throws 400 on bad input. */
function parseSource({ file, gitUrl, gitBranch, gitToken, gitSubdir, template }) {
  if (file) return { type: 'upload' };
  if (template) {
    if (!listTemplates().some((t) => t.id === template)) throw new HttpError(400, 'Unknown template');
    return { type: 'template', template };
  }
  if (gitUrl) {
    const url = String(gitUrl).trim();
    if (!validGitUrl(url)) throw new HttpError(400, 'Use an https:// or ssh git URL (for example https://github.com/me/site.git)');
    if (/^https:\/\/[^/]*@/.test(url)) throw new HttpError(400, 'Put the access token in its own field, not in the URL');
    const branch = gitBranch ? String(gitBranch).trim() : 'main';
    if (!validBranch(branch)) throw new HttpError(400, 'Invalid branch name');
    const subdir = gitSubdir ? String(gitSubdir).trim().replace(/^\/+|\/+$/g, '') : '';
    if (!validSubdir(subdir)) throw new HttpError(400, 'Invalid folder inside the repository');
    if (gitToken && (typeof gitToken !== 'string' || gitToken.length > 300 || /[\s\0]/.test(gitToken))) throw new HttpError(400, 'Invalid access token');
    return {
      type: 'git', url, branch, subdir, token: gitToken || '', hookSecret: crypto.randomBytes(20).toString('hex'),
    };
  }
  throw new HttpError(400, 'Choose a .zip or .html file, a git repository or a template');
}

/**
 * Credentials for https git go in through git's config environment
 * (GIT_CONFIG_COUNT), never on the command line or in .git/config.
 */
function gitEnv(source) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || '/root',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  if (source.token && source.url.startsWith('https://')) {
    const basic = Buffer.from(`x-access-token:${source.token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return env;
}

async function cloneGit(source, dest, onOutput) {
  const tmp = `${dest}.clone-${Date.now()}`;
  await fs.remove(tmp);
  try {
    await run('git', ['clone', '--depth', '1', '--single-branch', '--no-tags', '--branch', source.branch, '--', source.url, tmp], {
      env: gitEnv(source), timeout: 10 * 60000, onOutput,
    });
    const { stdout } = await run('git', ['-C', tmp, 'rev-parse', 'HEAD'], { env: gitEnv(source) });
    const { stdout: msg } = await run('git', ['-C', tmp, 'log', '-1', '--format=%s'], { env: gitEnv(source) }).catch(() => ({ stdout: '' }));
    await fs.remove(path.join(tmp, '.git'));
    const from = source.subdir ? safeResolve(tmp, source.subdir) : tmp;
    if (!(await fs.pathExists(from))) throw new Error(`Folder "${source.subdir}" not found in the repository`);
    await fs.remove(dest);
    await fs.move(from, dest);
    return { commit: stdout.trim(), message: msg.trim().slice(0, 200) };
  } finally {
    await fs.remove(tmp);
  }
}

/** Put the code into dest (which must not exist yet or will be replaced). */
async function materialize(source, dest, { file, onOutput } = {}) {
  await fs.remove(dest);
  if (source.type === 'upload') {
    await fs.ensureDir(dest);
    if (/\.html?$/i.test(file.originalname)) {
      await fs.move(file.path, path.join(dest, 'index.html'), { overwrite: true });
    } else {
      try {
        await extractZip(file.path, dest);
      } finally {
        await fs.remove(file.path);
      }
    }
    return {};
  }
  if (source.type === 'template') {
    await fs.copy(path.join(TEMPLATES_DIR, source.template, 'files'), dest);
    return {};
  }
  if (source.type === 'git') return cloneGit(source, dest, onOutput);
  throw new Error(`Unknown source ${source.type}`);
}

/** Check a webhook call: GitHub/Gitea signature, GitLab token, or ?token=. */
function verifyHook(req, secret) {
  const sig = req.get('X-Hub-Signature-256') || req.get('X-Gitea-Signature') && `sha256=${req.get('X-Gitea-Signature')}`;
  if (sig && req.rawBody) {
    const want = `sha256=${crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')}`;
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  }
  const token = req.get('X-Gitlab-Token') || (typeof req.query.token === 'string' ? req.query.token : '');
  if (token) return token.length === secret.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
  return false;
}

/** The branch a push event is about, when the payload says (GitHub, GitLab, Gitea). */
function pushedBranch(body) {
  const ref = body && typeof body.ref === 'string' ? body.ref : null;
  return ref && ref.startsWith('refs/heads/') ? ref.slice(11) : null;
}

module.exports = {
  TEMPLATES_DIR, listTemplates, parseSource, materialize, verifyHook, pushedBranch, validGitUrl, validBranch, gitEnv,
};
