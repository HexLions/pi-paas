'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { startPanel, zipForm, waitFor, tmpDir } = require('./helpers');

process.env.PIPAAS_ALLOW_LOCAL_GIT = '1';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).toString().trim();
const server = (text) => `require('http').createServer((q,s)=>s.end(${JSON.stringify(text)})).listen(process.env.PORT)`;

function cli(p, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'cli', 'pipaas.js'), ...args], {
      env: { ...process.env, ...env, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('deploy sources, releases and the CLI', () => {
  let p;
  let repo;
  let work;
  const get = async (id) => (await p.req('GET', `/api/apps/${id}`)).data;
  const body = (a) => waitFor(() => fetch(`http://127.0.0.1:${a.port}/`).then((r) => r.text()).catch(() => null));

  before(async () => {
    p = await startPanel({ PIPAAS_PORT_RANGE: '39500-39540' });
    await p.login();
    work = await tmpDir();
    repo = path.join(work, 'repo');
    await fs.ensureDir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(repo, 'server.js'), server('git v1'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
  });
  after(async () => { await p.close(); await fs.remove(work); });

  it('validates git sources', async () => {
    for (const gitUrl of ['--upload-pack=touch /tmp/x', 'http://insecure.example/repo', 'https://user:tok@github.com/x/y.git', 'ext::sh -c id']) {
      const r = await p.req('POST', '/api/apps', { form: zipForm({ name: 'g', type: 'node', gitUrl }) });
      assert.equal(r.status, 400, gitUrl);
    }
    const r = await p.req('POST', '/api/apps', { form: zipForm({ name: 'g', type: 'node', gitUrl: `file://${repo}`, gitBranch: '--force' }) });
    assert.equal(r.status, 400);
  });

  it('deploys from git and redeploys on a signed push webhook', async () => {
    const r = await p.req('POST', '/api/apps', { form: zipForm({ name: 'from-git', type: 'node', gitUrl: `file://${repo}` }) });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    await p.service.settle();
    let a = await get('from-git');
    assert.equal(a.status, 'running', JSON.stringify(a.lastError));
    assert.equal(a.source.commit, git(repo, 'rev-parse', 'HEAD'));
    assert.equal(await body(a), 'git v1');
    assert.equal(await fs.pathExists(path.join(p.dataDir, 'apps/from-git/.git')), false);

    const src = (await p.req('GET', '/api/apps/from-git/source')).data;
    assert.match(src.webhookUrl, /\/api\/hooks\/from-git$/);

    await fs.writeFile(path.join(repo, 'server.js'), server('git v2'));
    git(repo, 'commit', '-q', '-am', 'second');
    const payload = JSON.stringify({ ref: 'refs/heads/main' });
    const sig = `sha256=${crypto.createHmac('sha256', src.webhookSecret).update(payload).digest('hex')}`;
    const hook = (headers, data = payload) => fetch(`${p.base}/api/hooks/from-git`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: data });

    assert.equal((await hook({ 'X-Hub-Signature-256': 'sha256=00' })).status, 401);
    assert.equal((await fetch(`${p.base}/api/hooks/nope`, { method: 'POST' })).status, 401);
    const other = JSON.stringify({ ref: 'refs/heads/dev' });
    const otherSig = `sha256=${crypto.createHmac('sha256', src.webhookSecret).update(other).digest('hex')}`;
    const ignored = await hook({ 'X-Hub-Signature-256': otherSig }, other);
    assert.equal(ignored.status, 202);
    assert.match((await ignored.json()).message, /Ignored/);

    assert.equal((await hook({ 'X-Hub-Signature-256': sig, 'X-GitHub-Event': 'push' })).status, 202);
    await p.service.settle();
    a = await get('from-git');
    assert.equal(a.version, 2);
    assert.equal(await body(a), 'git v2');
    // GitLab style token works too
    assert.equal((await hook({ 'X-Gitlab-Token': src.webhookSecret, 'X-Gitlab-Event': 'Push Hook' })).status, 202);
    await p.service.settle();
    assert.equal((await get('from-git')).version, 3);
  });

  it('keeps previous versions and rolls back to one', async () => {
    const rel = (await p.req('GET', '/api/apps/from-git/releases')).data;
    assert.deepEqual(rel.map((r) => r.version), [2, 1]);
    assert.equal((await p.req('POST', '/api/apps/from-git/releases/1/rollback')).status, 202);
    await p.service.settle();
    const a = await get('from-git');
    assert.equal(a.version, 1);
    assert.equal(a.status, 'running', JSON.stringify(a.lastError));
    assert.equal(await body(a), 'git v1');
    const after1 = (await p.req('GET', '/api/apps/from-git/releases')).data.map((r) => r.version);
    assert.deepEqual(after1, [3, 2]);
    assert.equal((await p.req('POST', '/api/apps/from-git/releases/99/rollback')).status, 404);
  });

  it('deploys a template from the catalogue', async () => {
    const list = (await p.req('GET', '/api/templates')).data;
    assert.ok(list.some((t) => t.id === 'notes-api'));
    const r = await p.req('POST', '/api/apps', { form: zipForm({ template: 'notes-api' }) });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    assert.equal(r.data.id, 'notes-api');
    await p.service.settle();
    const a = await get('notes-api');
    assert.equal(a.status, 'running', JSON.stringify(a.lastError));
    await body(a);
    const made = await fetch(`http://127.0.0.1:${a.port}/api/notes`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
    assert.equal(made.status, 201);
    assert.ok(await fs.pathExists(path.join(p.dataDir, 'volumes/notes-api/notes.json')));
  });

  it('deploys and updates from the command line with an API token', async () => {
    const token = (await p.req('POST', '/api/tokens', { json: { name: 'laptop' } })).data.token;
    const dir = path.join(work, 'my-cli-app');
    await fs.outputFile(path.join(dir, 'server.js'), server('cli v1'));
    await fs.outputFile(path.join(dir, '.env'), 'SECRET=1');
    await fs.outputFile(path.join(dir, 'node_modules/junk/index.js'), 'x');
    const env = { PIPAAS_URL: p.base, PIPAAS_TOKEN: token, XDG_CONFIG_HOME: work };
    let r = await cli(p, ['deploy', dir], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /as a node app/);
    assert.match(r.out, /is running/);
    assert.equal(await fs.pathExists(path.join(p.dataDir, 'apps/my-cli-app/.env')), false);
    assert.equal(await fs.pathExists(path.join(p.dataDir, 'apps/my-cli-app/node_modules/junk')), false);
    await fs.outputFile(path.join(dir, 'server.js'), server('cli v2'));
    r = await cli(p, ['deploy', dir], env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /v1 → v2/);
    assert.equal(await body(await get('my-cli-app')), 'cli v2');
    r = await cli(p, ['rollback', 'my-cli-app'], env);
    assert.match(r.out, /v1 {2}replaced/);
    r = await cli(p, ['apps'], env);
    assert.match(r.out, /my-cli-app\s+running/);
    r = await cli(p, ['deploy', dir], { ...env, PIPAAS_TOKEN: 'pp_000000000000_wrongwrongwrongwrongwrong' });
    assert.equal(r.code, 1);
    assert.match(r.out, /401/);
  });

  it('serves the CLI from the panel', async () => {
    const res = await fetch(`${p.base}/cli/pipaas.js`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /pipaas: deploy and manage/);
  });
});
