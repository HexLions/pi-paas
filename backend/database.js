'use strict';
// Per-app databases. SQLite is just a file in the app's volume. PostgreSQL
// gets its own database AND its own login role with a random password, so
// DATABASE_URL works out of the box and apps cannot read each other's data.
//
// Every command runs as the postgres system user without a shell: SQL goes in
// through stdin and every identifier is checked against isValidPgIdent first.
const crypto = require('crypto');
const fs = require('fs-extra');
const { run, commandExists, isValidPgIdent, HttpError } = require('./util');

function assertIdent(name) {
  if (!isValidPgIdent(name)) throw new HttpError(400, `Invalid PostgreSQL name "${name}" (use a-z, 0-9 and _, start with a letter)`);
}

/** Single-quote a value for a POSIX shell (only used for su -c on systems without runuser). */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Quote a SQL string literal. */
function sqlLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function asPostgres(argv, opts = {}) {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot && commandExists('runuser')) return run('runuser', ['-u', 'postgres', '--', ...argv], opts);
  if (isRoot) return run('su', ['-s', '/bin/sh', 'postgres', '-c', argv.map(shQuote).join(' ')], opts);
  return run('sudo', ['-n', '-u', 'postgres', '--', ...argv], opts);
}

function psql(sql, db = 'postgres') {
  return asPostgres(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db], { input: sql, timeout: 60000 });
}

function pgUrl(info) {
  const auth = info.user ? `${encodeURIComponent(info.user)}:${encodeURIComponent(info.password || '')}@` : '';
  return `postgresql://${auth}localhost:5432/${info.name}`;
}

/** SQL that creates a role + database pair. Exported for tests. */
function createSql(name, user, password) {
  assertIdent(name);
  assertIdent(user);
  return [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlLiteral(user)}) THEN CREATE ROLE ${user} LOGIN PASSWORD ${sqlLiteral(password)}; ELSE ALTER ROLE ${user} LOGIN PASSWORD ${sqlLiteral(password)}; END IF; END $$;`,
  ].join('\n');
}

async function createPostgres(name) {
  assertIdent(name);
  const user = name.length > 58 ? `${name.slice(0, 58)}_user` : `${name}_user`;
  const password = crypto.randomBytes(18).toString('base64url');
  await psql(createSql(name, user, password));
  try {
    await asPostgres(['createdb', '-O', user, name], { timeout: 60000 });
  } catch (err) {
    if (!/already exists/.test(err.message)) throw err;
    await psql(`ALTER DATABASE ${name} OWNER TO ${user};`);
  }
  const info = { type: 'postgres', name, user, password };
  info.url = pgUrl(info);
  return info;
}

async function dropPostgres(info) {
  if (!info || !isValidPgIdent(info.name)) return;
  await asPostgres(['dropdb', '--if-exists', info.name], { timeout: 60000 }).catch(() => {});
  if (info.user && isValidPgIdent(info.user)) await psql(`DROP ROLE IF EXISTS ${info.user};`).catch(() => {});
}

async function renamePostgres(info, newName) {
  assertIdent(info.name);
  assertIdent(newName);
  // Nobody may be connected while a database is renamed.
  await psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlLiteral(info.name)} AND pid <> pg_backend_pid();\nALTER DATABASE ${info.name} RENAME TO ${newName};`);
  const next = { ...info, name: newName };
  next.url = pgUrl(next);
  return next;
}

async function dumpPostgres(info, outFile) {
  assertIdent(info.name);
  await asPostgres(['pg_dump', '--no-owner', '--no-privileges', info.name], { timeout: 30 * 60000, stdoutFile: outFile });
}

async function restorePostgres(info, dumpFile) {
  assertIdent(info.name);
  await asPostgres(['dropdb', '--if-exists', info.name], { timeout: 60000 });
  await asPostgres(['createdb', ...(info.user ? ['-O', info.user] : []), info.name], { timeout: 60000 });
  const sql = await fs.readFile(dumpFile, 'utf8');
  const asOwner = info.user ? `SET ROLE ${info.user};\n` : '';
  await psql(asOwner + sql, info.name);
}

function postgresAvailable() {
  return commandExists('psql') && commandExists('createdb');
}

/** Strip secrets before anything leaves the server in a listing. */
function publicDbInfo(info) {
  if (!info) return null;
  const { password, url, ...rest } = info;
  return rest;
}

module.exports = {
  createPostgres,
  dropPostgres,
  renamePostgres,
  dumpPostgres,
  restorePostgres,
  postgresAvailable,
  publicDbInfo,
  pgUrl,
  createSql,
  sqlLiteral,
  shQuote,
};
