'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const { makeZip, tmpDir } = require('./helpers');
const util = require('../backend/util');
const auth = require('../backend/auth');
const database = require('../backend/database');
const { migrate } = require('../backend/registry');
const { extractZip } = require('../backend/archive');
const config = require('../backend/config');
const { resolveCommand, appEnv } = require('../backend/processes');

describe('ids and names', () => {
  it('accepts only safe app ids', () => {
    assert.ok(util.isValidId('my-app'));
    assert.ok(util.isValidId('a1'));
    for (const bad of ['', '-x', 'A', '../x', 'a/b', 'a'.repeat(64), '__proto__', 'a b']) assert.equal(util.isValidId(bad), false, bad);
  });

  it('slugifies display names', () => {
    assert.equal(util.slugify("Bob's App"), 'bob-s-app');
    assert.equal(util.slugify('  Caffè Città!! '), 'caffe-citta');
    assert.equal(util.slugify('../../etc'), 'etc');
  });

  it('validates PostgreSQL identifiers', () => {
    assert.ok(util.isValidPgIdent('pipaas_my_app'));
    for (const bad of ['1abc', 'a-b', 'a;drop', 'A', 'a b', '', 'x'.repeat(64)]) assert.equal(util.isValidPgIdent(bad), false, bad);
  });

  it('validates environment variable names', () => {
    assert.ok(util.isValidEnvKey('API_KEY'));
    for (const bad of ['1X', 'A-B', 'A B', '']) assert.equal(util.isValidEnvKey(bad), false, bad);
  });
});

describe('safeResolve', () => {
  it('keeps paths inside the base folder', async () => {
    const base = await tmpDir();
    assert.equal(util.safeResolve(base, 'a/b.txt'), path.join(base, 'a/b.txt'));
    assert.equal(util.safeResolve(base, '/a.txt'), path.join(base, 'a.txt'));
    for (const bad of ['../x', 'a/../../x', '..', 'a\0b']) assert.throws(() => util.safeResolve(base, bad), /Invalid path/, bad);
    await fs.remove(base);
  });

  it('refuses symlinks that point outside', async () => {
    const base = await tmpDir();
    const outside = await tmpDir();
    await fs.symlink(outside, path.join(base, 'escape'));
    assert.throws(() => util.safeResolve(base, 'escape/secret.txt'), /Invalid path/);
    assert.throws(() => util.safeResolve(base, 'escape'), /Invalid path/);
    await fs.remove(base);
    await fs.remove(outside);
  });
});

describe('run', () => {
  it('passes arguments without a shell', async () => {
    const { stdout } = await util.run('echo', ['$(whoami)', ';', 'ls']);
    assert.equal(stdout.trim(), '$(whoami) ; ls');
  });

  it('reports failures with output', async () => {
    await assert.rejects(util.run('sh', ['-c', 'echo boom >&2; exit 3']), /exit code 3.*boom/s);
  });

  it('kills commands that run too long', async () => {
    await assert.rejects(util.run('sleep', ['5'], { timeout: 200 }), /timeout/);
  });
});

describe('auth', () => {
  it('hashes and verifies passwords', () => {
    const h = auth.hashPassword('correct horse');
    assert.ok(h.startsWith('scrypt$'));
    assert.ok(auth.verifyPassword('correct horse', h));
    assert.equal(auth.verifyPassword('wrong', h), false);
    assert.equal(auth.verifyPassword(undefined, h), false);
  });

  it('issues tokens that cannot be forged or reused after a password change', async () => {
    const dir = await tmpDir();
    const cfg = config.load({ PIPAAS_DATA_DIR: dir, PIPAAS_PASSWORD: 'first-password' });
    await fs.ensureDir(dir);
    const a = new auth.Auth(cfg, { warn() {} }).init();
    const tok = a.issueToken();
    assert.ok(a.verifyToken(tok));
    assert.equal(a.verifyToken(`${tok}x`), false);
    const [v, exp, nonce, sig] = tok.split('.');
    assert.equal(a.verifyToken([v, String(Number(exp) + 1000), nonce, sig].join('.')), false);
    assert.equal(a.verifyToken('garbage'), false);
    a.setPassword('second-password');
    assert.equal(a.verifyToken(tok), false);
    assert.equal((fs.statSync(cfg.authFile).mode & 0o777), 0o600);
    await fs.remove(dir);
  });

  it('generates a password file when none is configured', async () => {
    const dir = await tmpDir();
    const cfg = config.load({ PIPAAS_DATA_DIR: dir });
    const a = new auth.Auth(cfg, { warn() {} }).init();
    const pw = fs.readFileSync(cfg.initialPasswordFile, 'utf8').trim();
    assert.equal(pw.length, 16);
    assert.ok(a.checkPassword(pw));
    await fs.remove(dir);
  });

  it('rate-limits failed logins', () => {
    const a = new auth.Auth({}, {});
    for (let i = 0; i < 10; i++) a.recordFailure('1.2.3.4');
    assert.ok(a.tooManyAttempts('1.2.3.4'));
    assert.equal(a.tooManyAttempts('5.6.7.8'), false);
  });
});

describe('database helpers', () => {
  it('quotes SQL literals and shell words', () => {
    assert.equal(database.sqlLiteral("it's"), "'it''s'");
    assert.equal(database.shQuote("a'b"), "'a'\\''b'");
  });

  it('refuses unsafe names before building SQL', () => {
    assert.throws(() => database.createSql('x; DROP DATABASE y', 'u', 'p'), /Invalid PostgreSQL name/);
    const sql = database.createSql('pipaas_app', 'pipaas_app_user', "p'w");
    assert.match(sql, /PASSWORD 'p''w'/);
  });

  it('never exposes the password in listings', () => {
    const pub = database.publicDbInfo({ type: 'postgres', name: 'n', user: 'u', password: 'secret', url: 'postgresql://u:secret@localhost/n' });
    assert.deepEqual(pub, { type: 'postgres', name: 'n', user: 'u' });
  });
});

describe('registry migration', () => {
  it('turns v1.0 status into desired state and fills defaults', () => {
    const m = migrate({ apps: { a: { name: 'A', status: 'running', pid: 42, port: 3001, dbInfo: { type: 'sqlite', path: '/x/data.db' } }, b: { name: 'B', status: 'stopped', port: 3002 } } });
    assert.equal(m.apps.a.desired, 'running');
    assert.equal(m.apps.b.desired, 'stopped');
    assert.equal(m.apps.a.pid, undefined);
    assert.equal(m.apps.a.status, undefined);
    assert.deepEqual(m.apps.a.env, {});
    assert.equal(m.apps.a.backupSchedule, 'off');
    assert.equal(m.apps.a.dbInfo.name, 'data.db');
  });
});

describe('extractZip', () => {
  async function zipFile(entries) {
    const dir = await tmpDir();
    const f = path.join(dir, 'a.zip');
    await fs.writeFile(f, makeZip(entries));
    return { dir, f };
  }

  it('extracts and flattens a single root folder', async () => {
    const { dir, f } = await zipFile([{ name: 'site/' }, { name: 'site/index.html', data: '<h1>hi</h1>' }, { name: 'site/css/a.css', data: 'a{}' }, { name: '__MACOSX/._x', data: 'junk' }]);
    const out = path.join(dir, 'out');
    await extractZip(f, out);
    assert.equal(await fs.readFile(path.join(out, 'index.html'), 'utf8'), '<h1>hi</h1>');
    assert.ok(await fs.pathExists(path.join(out, 'css/a.css')));
    assert.equal(await fs.pathExists(path.join(out, '__MACOSX')), false);
    await fs.remove(dir);
  });

  it('refuses path traversal (zip slip)', async () => {
    const { dir, f } = await zipFile([{ name: '../evil.txt', data: 'x' }]);
    await assert.rejects(extractZip(f, path.join(dir, 'out')), /Unsafe path|invalid relative path/i);
    assert.equal(await fs.pathExists(path.join(dir, 'evil.txt')), false);
    await fs.remove(dir);
  });

  it('refuses symbolic links', async () => {
    const { dir, f } = await zipFile([{ name: 'link', data: '/etc/passwd', mode: 0o120777 }]);
    await assert.rejects(extractZip(f, path.join(dir, 'out')), /Symbolic links/);
    await fs.remove(dir);
  });

  it('stops archives that expand too much', async () => {
    const { dir, f } = await zipFile([{ name: 'big.bin', data: 'x'.repeat(5000) }]);
    await assert.rejects(extractZip(f, path.join(dir, 'out'), { maxBytes: 1000 }), /expands beyond/);
    await fs.remove(dir);
  });
});

describe('start command detection', () => {
  it('picks the entry point from the app type and files', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'app.py'), '');
    assert.deepEqual(resolveCommand(dir, { type: 'python', port: 1 }).args, ['app.py']);
    await fs.writeFile(path.join(dir, 'server.py'), '');
    assert.deepEqual(resolveCommand(dir, { type: 'python', port: 1 }).args, ['server.py']);
    await fs.writeJson(path.join(dir, 'package.json'), { scripts: { start: 'node x.js' } });
    assert.equal(resolveCommand(dir, { type: 'node', port: 1 }).cmd, 'npm');
    assert.equal(resolveCommand(dir, { type: 'node', port: 1, startCommand: 'echo hi' }).cmd, '/bin/sh');
    await assert.rejects(async () => resolveCommand(await tmpDir(), { type: 'node', port: 1 }), /No entry point/);
    await fs.remove(dir);
  });

  it('gives apps a clean environment without panel secrets', () => {
    process.env.PIPAAS_PASSWORD = 'leak-me';
    const cfg = config.load({ PIPAAS_DATA_DIR: '/tmp/x' });
    const env = appEnv(cfg, 'a', { port: 3005, env: { FOO: 'bar' }, dbInfo: { type: 'postgres', name: 'db', user: 'u', password: 'p', url: 'postgresql://u:p@localhost:5432/db' } });
    delete process.env.PIPAAS_PASSWORD;
    assert.equal(env.PORT, '3005');
    assert.equal(env.FOO, 'bar');
    assert.equal(env.PGUSER, 'u');
    assert.equal(env.DATA_DIR, '/tmp/x/volumes/a');
    assert.equal(env.PIPAAS_PASSWORD, undefined);
  });
});
