'use strict';
// Sends alerts (crash, failed health check, failed deploy, hot CPU, full
// disk, failed backup, new version) to the channels set up in the panel:
// ntfy, Telegram, a generic webhook and browser push. Every alert is also
// kept in a short activity list the panel shows.
const os = require('os');

const REPEAT_MS = 30 * 60000; // the same alert at most every 30 minutes
const KEEP_EVENTS = 200;

class Notifier {
  constructor(settings, { log = console, push = null } = {}) {
    this.settings = settings;
    this.log = log;
    this.push = push; // { send(title, body, data) } set by the PWA module
    this.sentAt = new Map();
    this.events = [];
  }

  recent(limit = 50, app = null) {
    return this.events.filter((e) => !app || e.app === app).slice(-limit).reverse();
  }

  /**
   * kind: crash | unhealthy | recovered | deployFailed | temperature | disk | backupFailed | update | info
   * key: what counts as "the same alert" for rate limiting (defaults to kind + app).
   */
  async notify(kind, { title, message, app = null, key, level = 'warn' } = {}) {
    const event = { at: new Date().toISOString(), kind, level, title, message, app };
    this.events.push(event);
    if (this.events.length > KEEP_EVENTS) this.events.splice(0, this.events.length - KEEP_EVENTS);

    const cfg = this.settings.get().notifications;
    const topic = kind === 'recovered' ? 'unhealthy' : kind;
    if (cfg.events[topic] === false || kind === 'info') return [];
    const k = key || `${kind}:${app || ''}`;
    const last = this.sentAt.get(k);
    if (last && Date.now() - last < REPEAT_MS) return [];
    this.sentAt.set(k, Date.now());
    return this.send(title, message, { level, app, kind });
  }

  async send(title, message, meta = {}) {
    const cfg = this.settings.get().notifications;
    const host = os.hostname();
    const jobs = [];
    if (cfg.ntfy.enabled) jobs.push(['ntfy', () => this.ntfy(cfg.ntfy, title, message, meta)]);
    if (cfg.telegram.enabled) jobs.push(['telegram', () => this.telegram(cfg.telegram, `${title}\n${message}\n(${host})`)]);
    if (cfg.webhook.enabled) jobs.push(['webhook', () => post(cfg.webhook.url, { title, message, host, ...meta, at: new Date().toISOString() })]);
    if (cfg.push.enabled && this.push) jobs.push(['push', () => this.push.send(title, message, meta)]);
    const results = await Promise.all(jobs.map(async ([channel, fn]) => {
      try {
        await fn();
        return { channel, ok: true };
      } catch (err) {
        this.log.warn(`[notify] ${channel} failed: ${err.message}`);
        return { channel, ok: false, error: err.message };
      }
    }));
    return results;
  }

  async test() {
    const results = await this.send('Pi-PaaS test', `Notifications from ${os.hostname()} work.`, { kind: 'test', level: 'info' });
    if (!results.length) {
      const err = new Error('No notification channel is enabled');
      err.status = 400;
      throw err;
    }
    return results;
  }

  ntfy(c, title, message, meta) {
    const url = `${c.url.replace(/\/+$/, '')}/${encodeURIComponent(c.topic)}`;
    const headers = {
      Title: asciiHeader(title),
      Priority: meta.level === 'error' ? '4' : '3',
      Tags: meta.level === 'error' ? 'rotating_light' : meta.level === 'ok' ? 'white_check_mark' : 'warning',
    };
    if (c.token) headers.Authorization = `Bearer ${c.token}`;
    return request(url, { method: 'POST', headers, body: message });
  }

  telegram(c, text) {
    const base = process.env.PIPAAS_TELEGRAM_API || 'https://api.telegram.org';
    return post(`${base}/bot${c.botToken}/sendMessage`, { chat_id: c.chatId, text, disable_web_page_preview: true });
  }
}

/** HTTP headers must be Latin-1; ntfy reads RFC 2047 encoded titles. */
function asciiHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
}

async function request(url, opts) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
  }
  return res;
}

function post(url, body) {
  return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

module.exports = { Notifier, asciiHeader };
