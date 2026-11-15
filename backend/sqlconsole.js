'use strict';
// SQL console for an app's own database. SQLite is opened in-process with
// node:sqlite (or the sqlite3 program on older Node); PostgreSQL is queried
// with psql logged in as the app's own role, so a query can never reach
// another app's data. Read-only unless the caller asks for writes.
const { run, HttpError, commandExists } = require('./util');

const MAX_ROWS = 500;
const MAX_SQL = 20000;

/**
 * Reject more than one statement: drivers would silently run only the first,
 * and psql would run them all. Understands '' and "" quotes, E'' strings with
 * backslash escapes, $tag$ dollar quoting, line comments and nested block
 * comments.
 */
function assertSingleStatement(sql) {
  let i = 0;
  let ended = false;
  const n = sql.length;
  const more = () => { throw new HttpError(400, 'Run one statement at a time'); };
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') { const nl = sql.indexOf('\n', i); i = nl < 0 ? n : nl + 1; continue; }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth += 1; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { depth -= 1; i += 2; } else i += 1;
      }
      if (depth) throw new HttpError(400, 'Unclosed comment');
      continue;
    }
    if (/\s/.test(c)) { i += 1; continue; }
    if (ended) more();
    if (c === ';') { ended = true; i += 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      // E'...' allows backslash escapes; everything else doubles the quote.
      const escapes = c === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && !/[A-Za-z0-9_]/.test(sql[i - 2] || '');
      i += 1;
      for (;;) {
        if (i >= n) throw new HttpError(400, 'Unclosed quote');
        if (escapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end < 0) throw new HttpError(400, 'Unclosed dollar quote');
        i = end + m[0].length;
        continue;
      }
    }
    i += 1;
  }
}

function sqliteModule() {
  try {
    // Avoid the experimental warning in the panel log.
    const emit = process.emitWarning;
    process.emitWarning = () => {};
    try { return require('node:sqlite'); } finally { process.emitWarning = emit; }
  } catch { return null; }
}

function available(dbInfo) {
  if (!dbInfo) return false;
  if (dbInfo.type === 'sqlite') return !!sqliteModule();
  return commandExists('psql');
}

function shape(columns, rows) {
  const truncated = rows.length > MAX_ROWS;
  return { columns, rows: rows.slice(0, MAX_ROWS), truncated };
}

async function querySqlite(path, sql, write) {
  const mod = sqliteModule();
  if (mod) {
    let db;
    try {
      db = new mod.DatabaseSync(path, { readOnly: !write });
    } catch (err) {
      throw new HttpError(400, write ? `Cannot open the database: ${err.message}` : 'The database file does not exist yet (the app creates it when it first writes)');
    }
    try {
      const stmt = db.prepare(sql);
      const cols = typeof stmt.columns === 'function' ? stmt.columns().map((c) => c.name) : [];
      if (!cols.length) {
        const r = stmt.run();
        return { columns: ['changes'], rows: [[Number(r.changes)]], truncated: false };
      }
      const rows = [];
      for (const row of stmt.iterate()) {
        rows.push(cols.map((c) => normalize(row[c])));
        if (rows.length > MAX_ROWS) break;
      }
      return shape(cols, rows);
    } catch (err) {
      throw new HttpError(400, err.message.replace(/^SQLITE_\w+: /, ''));
    } finally {
      db.close();
    }
  }
  // No fallback to the sqlite3 program: its dot-commands (.shell, .system)
  // and readfile()/writefile() would reach the whole machine.
  throw new HttpError(400, 'The SQLite console needs Node.js 22.5 or newer on the Pi');
}

function normalize(v) {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  return v;
}

/** Minimal RFC 4180 CSV parser for psql --csv output. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function queryPostgres(info, sql, write) {
  if (!info.user) throw new HttpError(400, 'This database was created by Pi-PaaS 1.0 without its own login; the console needs one');
  // psql treats a backslash as one of its own commands (\! runs a shell):
  // refuse it outright; the SQL itself goes in through stdin.
  if (sql.includes('\\')) throw new HttpError(400, 'Backslashes are not allowed in the console (psql would read them as its own commands)');
  const args = ['-X', '-q', '--csv', '-v', 'ON_ERROR_STOP=1', '-h', 'localhost', '-U', info.user, '-d', info.name];
  const input = `SET statement_timeout = 15000;\n${write ? '' : 'SET default_transaction_read_only = on;\n'}${sql.trim()}\n;\n`;
  let out;
  try {
    out = (await run('psql', args, { input, env: { PATH: process.env.PATH, PGPASSWORD: info.password || '', PGCONNECT_TIMEOUT: '5' }, timeout: 20000 })).stdout;
  } catch (err) {
    throw new HttpError(400, (err.stderr || err.message).replace(/^psql:[^:]*:\d+: /gm, '').trim().slice(0, 500));
  }
  const rows = parseCsv(out.replace(/^SET\n/gm, ''));
  if (!rows.length) return { columns: [], rows: [], truncated: false };
  return shape(rows[0], rows.slice(1));
}

async function query(dbInfo, sql, { write = false } = {}) {
  if (!dbInfo) throw new HttpError(400, 'App has no database');
  if (typeof sql !== 'string' || !sql.trim()) throw new HttpError(400, 'Write a query');
  if (sql.length > MAX_SQL) throw new HttpError(400, 'Query too long');
  assertSingleStatement(sql);
  const started = Date.now();
  const r = dbInfo.type === 'sqlite' ? await querySqlite(dbInfo.path, sql, write) : await queryPostgres(dbInfo, sql, write);
  return { ...r, ms: Date.now() - started };
}

async function tables(dbInfo) {
  const sql = dbInfo.type === 'sqlite'
    ? "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    : "SELECT table_name AS name, lower(table_type) AS type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name";
  try {
    return (await query(dbInfo, sql)).rows.map(([name, type]) => ({ name, type }));
  } catch (err) {
    if (/does not exist yet/.test(err.message)) return [];
    throw err;
  }
}

module.exports = { query, tables, available, assertSingleStatement, parseCsv };
