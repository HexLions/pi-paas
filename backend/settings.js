'use strict';
// Panel-wide settings edited from the UI (notifications, proxy, offsite
// backups, updates). Stored in settings.json (mode 600). Secret fields are
// masked when read back; sending the mask again keeps the stored value.
const fs = require('fs-extra');

const MASK = '••••••••';

const DEFAULTS = {
  notifications: {
    ntfy: { enabled: false, url: 'https://ntfy.sh/', topic: '', token: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    webhook: { enabled: false, url: '' },
    push: { enabled: true },
    events: { crash: true, unhealthy: true, deployFailed: true, temperature: true, disk: true, backupFailed: true, update: true },
    tempLimit: 75,
    diskLimitPercent: 90,
  },
  proxy: { enabled: true, domain: '', acmeEmail: '', acmeStaging: false },
  mdns: { enabled: true },
  backups: { target: 'none', folder: '', rclone: '', passphrase: '', verify: true },
  updates: { check: true },
};

const SECRETS = [
  ['notifications', 'ntfy', 'token'],
  ['notifications', 'telegram', 'botToken'],
  ['notifications', 'webhook', 'url'],
  ['backups', 'passphrase'],
];

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) continue; // unknown keys are dropped
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else if (typeof v === typeof base[k]) out[k] = v;
  }
  return out;
}

function getPath(obj, p) {
  return p.reduce((o, k) => (o ? o[k] : undefined), obj);
}

function setPath(obj, p, v) {
  const last = p[p.length - 1];
  const parent = p.slice(0, -1).reduce((o, k) => o[k], obj);
  parent[last] = v;
}

class Settings {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(DEFAULTS);
    this.listeners = [];
  }

  load() {
    if (fs.existsSync(this.file)) this.data = merge(structuredClone(DEFAULTS), fs.readJsonSync(this.file));
    return this;
  }

  get() {
    return this.data;
  }

  /** What the UI sees: secrets replaced by the mask when set. */
  masked() {
    const copy = structuredClone(this.data);
    for (const p of SECRETS) if (getPath(copy, p)) setPath(copy, p, MASK);
    return copy;
  }

  update(patch) {
    const next = merge(this.data, patch);
    for (const p of SECRETS) if (getPath(next, p) === MASK) setPath(next, p, getPath(this.data, p));
    validate(next);
    this.data = next;
    const tmp = `${this.file}.tmp`;
    fs.writeJsonSync(tmp, this.data, { spaces: 2, mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    for (const fn of this.listeners) {
      try { fn(this.data); } catch { /* a listener must not break saving */ }
    }
    return this.data;
  }

  onChange(fn) {
    this.listeners.push(fn);
  }
}

function validate(s) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const n = s.notifications;
  if (n.ntfy.enabled && (!/^https?:\/\//.test(n.ntfy.url) || !/^[A-Za-z0-9_-]{1,64}$/.test(n.ntfy.topic))) throw bad('ntfy needs a server URL and a topic (letters, digits, - and _)');
  if (n.telegram.enabled && (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(n.telegram.botToken) || !/^-?\d+$|^@\w+$/.test(n.telegram.chatId))) throw bad('Telegram needs a bot token (from @BotFather) and a chat id');
  if (n.webhook.enabled && !/^https?:\/\//.test(n.webhook.url)) throw bad('The webhook needs an http(s) URL');
  if (!(n.tempLimit >= 40 && n.tempLimit <= 100)) throw bad('Temperature limit must be between 40 and 100 °C');
  if (!(n.diskLimitPercent >= 50 && n.diskLimitPercent <= 99)) throw bad('Disk limit must be between 50 and 99 %');
  if (s.proxy.domain && !/^(?=.{1,200}$)([a-z0-9-]+\.)+[a-z]{2,}$/i.test(s.proxy.domain)) throw bad('Invalid domain');
  if (s.proxy.acmeEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.proxy.acmeEmail)) throw bad('Invalid e-mail address for certificates');
  if (!['none', 'folder', 'rclone'].includes(s.backups.target)) throw bad('Backup target must be none, folder or rclone');
  if (s.backups.target === 'folder' && !s.backups.folder.startsWith('/')) throw bad('The backup folder must be an absolute path');
  if (s.backups.target === 'rclone' && !/^[A-Za-z0-9_-]+:[^\0\n]*$/.test(s.backups.rclone)) throw bad('Use an rclone remote such as nas:pi-paas');
  if (s.backups.passphrase && s.backups.passphrase.length < 12) throw bad('The backup passphrase needs at least 12 characters');
}

module.exports = { Settings, DEFAULTS, MASK };
