'use strict';
// Panel accounts. auth.json holds the users (scrypt password hash, role,
// optional TOTP secret) and the API tokens (only their SHA-256 is stored).
// Sessions are stateless HMAC-signed cookies that carry the user name and a
// per-user generation number: changing a user's password, role or 2FA bumps
// the generation and logs that user out everywhere.
const crypto = require('crypto');
const fs = require('fs-extra');

const COOKIE = 'pipaas_session';
const SESSION_DAYS = 7;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const ROLES = ['viewer', 'operator', 'admin'];
const USER_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

function roleRank(role) {
  return ROLES.indexOf(role);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** A dummy hash so a login for an unknown user costs the same time. */
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function generatePassword() {
  // 16 characters from an alphabet without look-alikes (0/O, 1/l/I).
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

// ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret, time = Date.now(), step = 30) {
  const counter = Math.floor(time / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}

/** Accept the current code and one step either side (clock drift). */
function verifyTotp(secret, code, time = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  return [-1, 0, 1].some((d) => {
    const want = Buffer.from(totp(secret, time + d * 30000));
    return crypto.timingSafeEqual(want, Buffer.from(String(code)));
  });
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

class Auth {
  constructor(cfg, log = console) {
    this.cfg = cfg;
    this.log = log;
    this.state = null;
    this.attempts = new Map();
    this.usedCodes = new Map();
  }

  /** Load auth.json (migrating the v1.1 single-password file), creating it when missing. */
  init() {
    if (fs.existsSync(this.cfg.authFile)) {
      const raw = fs.readJsonSync(this.cfg.authFile);
      this.state = migrate(raw);
      if (raw !== this.state) this.save();
      this.mtime = fs.statSync(this.cfg.authFile).mtimeMs;
      return this;
    }
    this.state = { version: 2, secret: crypto.randomBytes(32).toString('hex'), users: {}, tokens: [] };
    let password = this.cfg.initialPassword;
    if (!password) {
      password = generatePassword();
      fs.writeFileSync(this.cfg.initialPasswordFile, `${password}\n`, { mode: 0o600 });
      this.log.warn(`[auth] No password set. Generated one and saved it to ${this.cfg.initialPasswordFile}`);
      this.log.warn(`[auth] Initial login: admin / ${password}`);
    }
    this.createUser('admin', password, 'admin');
    return this;
  }

  save() {
    const tmp = `${this.cfg.authFile}.tmp`;
    fs.writeJsonSync(tmp, this.state, { spaces: 2, mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.cfg.authFile);
    this.mtime = fs.statSync(this.cfg.authFile).mtimeMs;
  }

  /** Pick up edits made by cli.js while the panel runs (set-password, reset-2fa). */
  refresh() {
    try {
      const m = fs.statSync(this.cfg.authFile).mtimeMs;
      if (this.mtime && m !== this.mtime) {
        this.state = migrate(fs.readJsonSync(this.cfg.authFile));
        this.mtime = m;
      }
    } catch { /* file briefly missing during a rename */ }
  }

  // ---------- users ----------

  user(name) {
    this.refresh();
    return Object.prototype.hasOwnProperty.call(this.state.users, name) ? this.state.users[name] : null;
  }

  listUsers() {
    return Object.entries(this.state.users).map(([name, u]) => ({
      name, role: u.role, totp: !!(u.totp && u.totp.enabled), createdAt: u.createdAt || null, lastLogin: u.lastLogin || null,
    }));
  }

  admins() {
    return Object.values(this.state.users).filter((u) => u.role === 'admin').length;
  }

  createUser(name, password, role) {
    if (!USER_RE.test(name || '')) throw httpError(400, 'User names use a-z, 0-9, dot, dash and underscore (max 32)');
    if (this.user(name)) throw httpError(409, 'That user already exists');
    if (!ROLES.includes(role)) throw httpError(400, `Role must be one of: ${ROLES.join(', ')}`);
    checkPasswordRules(password);
    this.state.users[name] = { hash: hashPassword(password), role, gen: 1, totp: null, createdAt: new Date().toISOString() };
    this.save();
  }

  updateUser(name, { role, password }) {
    const u = this.user(name);
    if (!u) throw httpError(404, 'User not found');
    if (role !== undefined) {
      if (!ROLES.includes(role)) throw httpError(400, `Role must be one of: ${ROLES.join(', ')}`);
      if (u.role === 'admin' && role !== 'admin' && this.admins() === 1) throw httpError(400, 'The last admin cannot lose the admin role');
      u.role = role;
    }
    if (password !== undefined) {
      checkPasswordRules(password);
      u.hash = hashPassword(password);
    }
    u.gen = (u.gen || 1) + 1;
    this.save();
  }

  deleteUser(name) {
    const u = this.user(name);
    if (!u) throw httpError(404, 'User not found');
    if (u.role === 'admin' && this.admins() === 1) throw httpError(400, 'The last admin cannot be deleted');
    delete this.state.users[name];
    this.state.tokens = this.state.tokens.filter((t) => t.user !== name);
    this.save();
  }

  /** v1.1 compatibility: set the password of the (first) admin. */
  setPassword(password, name = 'admin') {
    if (!this.state) this.state = { version: 2, secret: crypto.randomBytes(32).toString('hex'), users: {}, tokens: [] };
    if (!this.user(name)) {
      checkPasswordRules(password);
      this.state.users[name] = { hash: hashPassword(password), role: 'admin', gen: 1, totp: null, createdAt: new Date().toISOString() };
      this.save();
      return;
    }
    this.updateUser(name, { password });
  }

  // ---------- login ----------

  /**
   * Check a login. Returns the user name, or throws 401 with needCode when
   * the password was right but a 2FA code is missing or wrong.
   */
  login(name, password, code) {
    const u = this.user(name || 'admin');
    if (!verifyPassword(password, u ? u.hash : DUMMY_HASH) || !u) throw httpError(401, 'Wrong user name or password');
    if (u.totp && u.totp.enabled) {
      if (!code) throw httpError(401, 'Enter the code from your authenticator app', { needCode: true });
      if (!verifyTotp(u.totp.secret, code) || this.codeReused(name, code)) throw httpError(401, 'Wrong or expired code', { needCode: true });
    }
    u.lastLogin = new Date().toISOString();
    this.save();
    return name || 'admin';
  }

  /** A TOTP code works once per user, so a sniffed code cannot be replayed. */
  codeReused(name, code) {
    const key = `${name}:${code}`;
    const now = Date.now();
    for (const [k, t] of this.usedCodes) if (now - t > 120000) this.usedCodes.delete(k);
    if (this.usedCodes.has(key)) return true;
    this.usedCodes.set(key, now);
    return false;
  }

  checkPassword(password, name = 'admin') {
    const u = this.user(name);
    return verifyPassword(password, u ? u.hash : DUMMY_HASH) && !!u;
  }

  // ---------- 2FA setup ----------

  startTotp(name) {
    const u = this.user(name);
    if (!u) throw httpError(404, 'User not found');
    const secret = base32Encode(crypto.randomBytes(20));
    u.totpPending = secret;
    this.save();
    const label = encodeURIComponent(`Pi-PaaS:${name}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Pi-PaaS&algorithm=SHA1&digits=6&period=30` };
  }

  enableTotp(name, code) {
    const u = this.user(name);
    if (!u || !u.totpPending) throw httpError(400, 'Start the 2FA setup first');
    if (!verifyTotp(u.totpPending, code)) throw httpError(400, 'Wrong code: check the time on your phone and try again');
    u.totp = { secret: u.totpPending, enabled: true, since: new Date().toISOString() };
    delete u.totpPending;
    u.gen = (u.gen || 1) + 1;
    this.save();
  }

  disableTotp(name) {
    const u = this.user(name);
    if (!u) throw httpError(404, 'User not found');
    u.totp = null;
    delete u.totpPending;
    u.gen = (u.gen || 1) + 1;
    this.save();
  }

  // ---------- sessions ----------

  sign(payload) {
    return crypto.createHmac('sha256', this.state.secret).update(payload).digest('base64url');
  }

  issueToken(name = 'admin') {
    const u = this.user(name);
    const exp = Date.now() + SESSION_DAYS * 86400000;
    const payload = `v2.${Buffer.from(name).toString('base64url')}.${u ? u.gen || 1 : 0}.${exp}.${crypto.randomBytes(8).toString('hex')}`;
    return `${payload}.${this.sign(payload)}`;
  }

  /** Returns { name, role } for a valid session cookie, else null. */
  sessionUser(token) {
    if (typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i < 0) return null;
    const payload = token.slice(0, i);
    const sig = Buffer.from(token.slice(i + 1));
    const good = Buffer.from(this.sign(payload));
    if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return null;
    const [v, nameB64, gen, exp] = payload.split('.');
    if (v !== 'v2' || !(Number(exp) > Date.now())) return null;
    const name = Buffer.from(nameB64, 'base64url').toString();
    const u = this.user(name);
    if (!u || String(u.gen || 1) !== gen) return null;
    return { name, role: u.role, via: 'session' };
  }

  /** Back-compat for callers that only need a yes/no. */
  verifyToken(token) {
    return !!this.sessionUser(token);
  }

  // ---------- API tokens ----------

  createApiToken(user, name, role) {
    const u = this.user(user);
    if (!u) throw httpError(404, 'User not found');
    if (!name || typeof name !== 'string' || name.length > 60) throw httpError(400, 'Give the token a name (max 60 characters)');
    const r = role || u.role;
    if (!ROLES.includes(r)) throw httpError(400, `Role must be one of: ${ROLES.join(', ')}`);
    if (roleRank(r) > roleRank(u.role)) throw httpError(403, 'A token cannot have more rights than its owner');
    const id = crypto.randomBytes(6).toString('hex');
    const secret = crypto.randomBytes(24).toString('base64url');
    this.state.tokens.push({ id, name: name.trim(), user, role: r, hash: sha256(secret), createdAt: new Date().toISOString(), lastUsed: null });
    this.save();
    return { id, token: `pp_${id}_${secret}` };
  }

  listApiTokens(user, all = false) {
    return this.state.tokens.filter((t) => all || t.user === user).map(({ hash, ...t }) => t);
  }

  deleteApiToken(id, user, all = false) {
    const t = this.state.tokens.find((x) => x.id === id);
    if (!t || (!all && t.user !== user)) throw httpError(404, 'Token not found');
    this.state.tokens = this.state.tokens.filter((x) => x.id !== id);
    this.save();
  }

  /** Returns { name, role } for "Bearer pp_<id>_<secret>", else null. */
  apiTokenUser(header) {
    const m = /^Bearer pp_([0-9a-f]{12})_([A-Za-z0-9_-]{20,64})$/.exec(header || '');
    if (!m) return null;
    const t = this.state.tokens.find((x) => x.id === m[1]);
    if (!t) return null;
    const a = Buffer.from(sha256(m[2]));
    const b = Buffer.from(t.hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const u = this.user(t.user);
    if (!u) return null;
    // Never more than the owner has today.
    const role = roleRank(t.role) <= roleRank(u.role) ? t.role : u.role;
    if (!t.lastUsed || Date.now() - Date.parse(t.lastUsed) > 3600000) {
      t.lastUsed = new Date().toISOString();
      this.save();
    }
    return { name: t.user, role, via: 'token', tokenId: t.id };
  }

  // ---------- login rate limit ----------

  tooManyAttempts(key) {
    const rec = this.attempts.get(key);
    if (!rec || Date.now() - rec.since > 15 * 60000) return false;
    return rec.count >= 10;
  }

  recordFailure(key) {
    const now = Date.now();
    const rec = this.attempts.get(key);
    if (!rec || now - rec.since > 15 * 60000) this.attempts.set(key, { since: now, count: 1 });
    else rec.count += 1;
    if (this.attempts.size > 5000) this.attempts.clear();
  }

  clearFailures(key) {
    this.attempts.delete(key);
  }
}

function checkPasswordRules(password) {
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  if (password.length > 200) throw httpError(400, 'Password is too long');
}

/** v1.1 stored { hash, secret } for a single admin. */
function migrate(raw) {
  if (raw && raw.version === 2 && raw.users) {
    if (!Array.isArray(raw.tokens)) raw.tokens = [];
    return raw;
  }
  return {
    version: 2,
    secret: (raw && raw.secret) || crypto.randomBytes(32).toString('hex'),
    users: { admin: { hash: raw.hash, role: 'admin', gen: 2, totp: null, createdAt: new Date().toISOString() } },
    tokens: [],
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookie */ }
    }
  }
  return out;
}

function sessionCookie(token, req, maxAgeSec) {
  const attrs = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (req.secure) attrs.push('Secure');
  return attrs.join('; ');
}

module.exports = {
  Auth, COOKIE, SESSION_DAYS, ROLES, roleRank, hashPassword, verifyPassword, generatePassword, parseCookies, sessionCookie,
  totp, verifyTotp, base32Encode, base32Decode, migrate,
};
