'use strict';
// Web Push without dependencies: message encryption per RFC 8291
// (aes128gcm) and server identification per RFC 8292 (VAPID, ES256).
// Subscriptions and the VAPID key pair live in push.json (mode 600).
const crypto = require('crypto');
const fs = require('fs-extra');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Encrypt a payload for one subscription (RFC 8291). Exported for tests. */
function encrypt(payload, uaPublicB64, authB64, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPublic = fromB64u(uaPublicB64);
  const authSecret = fromB64u(authB64);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Invalid subscription keys');
  const as = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** VAPID Authorization header for a push service origin (RFC 8292). */
function vapidHeader(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** Push services of the browsers people use; anything else could aim the panel at internal hosts. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^web\.push\.apple\.com$/, /\.notify\.windows\.com$/];

function pushHostAllowed(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

function validSubscription(sub) {
  return sub && typeof sub.endpoint === 'string' && /^https:\/\/[^\s]+$/.test(sub.endpoint) && sub.endpoint.length < 1000
    && (process.env.PIPAAS_PUSH_ANY_HOST === '1' || pushHostAllowed(sub.endpoint))
    && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string'
    && fromB64u(sub.keys.p256dh).length === 65 && fromB64u(sub.keys.auth).length === 16;
}

class Push {
  constructor(cfg, log = console) {
    this.file = cfg.pushFile;
    this.log = log;
    this.state = null;
  }

  load() {
    if (fs.existsSync(this.file)) this.state = fs.readJsonSync(this.file);
    if (!this.state || !this.state.keys) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = publicKey.export({ format: 'jwk' });
      const raw = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
      this.state = { keys: { publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }) }, subscriptions: [] };
      this.save();
    }
    return this;
  }

  save() {
    fs.writeJsonSync(this.file, this.state, { spaces: 2, mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  publicKey() {
    return this.state.keys.publicKey;
  }

  subscribe(sub, user) {
    if (!validSubscription(sub)) throw Object.assign(new Error('Invalid push subscription'), { status: 400 });
    this.state.subscriptions = this.state.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    this.state.subscriptions.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, user, createdAt: new Date().toISOString() });
    // At most 10 devices per user: one user cannot push everyone else out.
    const mine = this.state.subscriptions.filter((s) => s.user === user);
    if (mine.length > 10) this.state.subscriptions = this.state.subscriptions.filter((s) => s !== mine[0]);
    this.save();
  }

  unsubscribe(endpoint, user) {
    this.state.subscriptions = this.state.subscriptions.filter((s) => !(s.endpoint === endpoint && s.user === user));
    this.save();
  }

  count(user) {
    return this.state.subscriptions.filter((s) => !user || s.user === user).length;
  }

  /** Send to every subscribed browser; drops subscriptions the push service says are gone. */
  async send(title, body, data = {}, { user = null } = {}) {
    const targets = this.state.subscriptions.filter((s) => !user || s.user === user);
    if (!targets.length) throw new Error(user ? 'This user has not turned on notifications on any device' : 'No browser has turned on notifications yet');
    const payload = JSON.stringify({ title, body, app: data.app || null, level: data.level || 'info' });
    const subject = process.env.PIPAAS_PUSH_SUBJECT || 'mailto:admin@pi-paas.invalid';
    const gone = [];
    const results = await Promise.all(targets.map(async (s) => {
      try {
        const res = await fetch(s.endpoint, {
          method: 'POST',
          headers: {
            Authorization: vapidHeader(s.endpoint, this.state.keys, subject),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: '86400',
            Urgency: data.level === 'error' ? 'high' : 'normal',
          },
          body: encrypt(payload, s.keys.p256dh, s.keys.auth),
          signal: AbortSignal.timeout(10000),
        });
        if (res.status === 404 || res.status === 410) gone.push(s.endpoint);
        return res.ok;
      } catch {
        return false;
      }
    }));
    if (gone.length) {
      this.state.subscriptions = this.state.subscriptions.filter((s) => !gone.includes(s.endpoint));
      this.save();
    }
    if (!results.some(Boolean)) throw new Error('No push service accepted the message');
  }
}

module.exports = { Push, encrypt, vapidHeader, validSubscription, pushHostAllowed };
