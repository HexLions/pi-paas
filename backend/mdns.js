'use strict';
// Answers multicast DNS questions for <app>.local on the LAN, so phones and
// laptops can open http://blog.local instead of http://192.168.1.20:3001.
// Runs next to avahi: it only answers for app names, never the machine's own.
const os = require('os');

class Mdns {
  constructor({ registry, settings, log = console, options = {} }) {
    Object.assign(this, { registry, settings, log, options });
    this.server = null;
  }

  lanAddresses() {
    const v4 = [];
    const v6 = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const i of list || []) {
        if (i.internal) continue;
        if (i.family === 'IPv4') v4.push(i.address);
        else if (i.family === 'IPv6' && !i.address.startsWith('fe80')) v6.push(i.address);
      }
    }
    return { v4, v6 };
  }

  /** Which app a .local name belongs to, or null. */
  appFor(name) {
    const n = String(name).toLowerCase().replace(/\.$/, '');
    if (!n.endsWith('.local')) return null;
    const id = n.slice(0, -6);
    if (id === os.hostname().toLowerCase()) return null;
    return this.registry.get(id) ? id : null;
  }

  answersFor(question) {
    const id = this.appFor(question.name);
    if (!id) return [];
    const { v4, v6 } = this.lanAddresses();
    const name = `${id}.local`;
    const out = [];
    if (question.type === 'A' || question.type === 'ANY') for (const a of v4) out.push({ name, type: 'A', ttl: 120, flush: true, data: a });
    if (question.type === 'AAAA' || question.type === 'ANY') for (const a of v6) out.push({ name, type: 'AAAA', ttl: 120, flush: true, data: a });
    return out;
  }

  start() {
    if (!this.settings.get().mdns.enabled) return this;
    try {
      this.server = require('multicast-dns')({ reuseAddr: true, ...this.options });
    } catch (err) {
      this.log.warn(`[mdns] off: ${err.message}`);
      return this;
    }
    this.server.on('error', (err) => this.log.warn(`[mdns] ${err.message}`));
    this.server.on('query', (q) => {
      const answers = (q.questions || []).flatMap((x) => this.answersFor(x));
      if (answers.length) this.server.respond({ answers });
    });
    this.log.log('[mdns] answering for <app>.local');
    return this;
  }

  stop() {
    if (this.server) this.server.destroy();
    this.server = null;
  }
}

module.exports = { Mdns };
