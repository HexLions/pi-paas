'use strict';
// Panel login: one admin password, stored as a scrypt hash in auth.json.
// Sessions are stateless HMAC-signed cookies, so they survive panel restarts;
// changing the password rotates the signing secret and logs everyone out.
const crypto = require('crypto');
const fs = require('fs-extra');

const COOKIE = 'pipaas_session';
const SESSION_DAYS = 7;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

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

function generatePassword() {
  // 16 characters from an alphabet without look-alikes (0/O, 1/l/I).
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

class Auth {
  constructor(cfg, log = console) {
    this.cfg = cfg;
    this.log = log;
    this.state = null;
    this.attempts = new Map();
  }

  /** Load auth.json, creating it (and a first password) when missing. */
  init() {
    if (fs.existsSync(this.cfg.authFile)) {
      this.state = fs.readJsonSync(this.cfg.authFile);
      return this;
    }
    let password = this.cfg.initialPassword;
    if (!password) {
      password = generatePassword();
      fs.writeFileSync(this.cfg.initialPasswordFile, `${password}\n`, { mode: 0o600 });
      this.log.warn(`[auth] No password set. Generated one and saved it to ${this.cfg.initialPasswordFile}`);
      this.log.warn(`[auth] Initial password: ${password}`);
    }
    this.setPassword(password);
    return this;
  }

  setPassword(password) {
    if (typeof password !== 'string' || password.length < 8) {
      throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
    }
    this.state = { hash: hashPassword(password), secret: crypto.randomBytes(32).toString('hex') };
    fs.writeJsonSync(this.cfg.authFile, this.state, { spaces: 2, mode: 0o600 });
    fs.chmodSync(this.cfg.authFile, 0o600);
  }

  checkPassword(password) {
    return verifyPassword(password, this.state && this.state.hash);
  }

  sign(payload) {
    return crypto.createHmac('sha256', this.state.secret).update(payload).digest('base64url');
  }

  issueToken() {
    const exp = Date.now() + SESSION_DAYS * 86400000;
    const payload = `v1.${exp}.${crypto.randomBytes(8).toString('hex')}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verifyToken(token) {
    if (typeof token !== 'string') return false;
    const i = token.lastIndexOf('.');
    if (i < 0) return false;
    const payload = token.slice(0, i);
    const sig = Buffer.from(token.slice(i + 1));
    const good = Buffer.from(this.sign(payload));
    if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return false;
    const exp = Number(payload.split('.')[1]);
    return Number.isFinite(exp) && exp > Date.now();
  }

  /** Simple fixed-window limiter: 10 failed logins per 15 minutes per address. */
  tooManyAttempts(ip) {
    const now = Date.now();
    const rec = this.attempts.get(ip);
    if (!rec || now - rec.since > 15 * 60000) return false;
    return rec.count >= 10;
  }

  recordFailure(ip) {
    const now = Date.now();
    const rec = this.attempts.get(ip);
    if (!rec || now - rec.since > 15 * 60000) this.attempts.set(ip, { since: now, count: 1 });
    else rec.count += 1;
    if (this.attempts.size > 5000) this.attempts.clear();
  }

  clearFailures(ip) {
    this.attempts.delete(ip);
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, req, maxAgeSec) {
  const attrs = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (req.secure) attrs.push('Secure');
  return attrs.join('; ');
}

module.exports = {
  Auth, COOKIE, SESSION_DAYS, hashPassword, verifyPassword, generatePassword, parseCookies, sessionCookie,
};
