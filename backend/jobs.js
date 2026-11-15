'use strict';
// Scheduled tasks per app: a shell command run on a cron schedule in the
// app folder, with the app's environment and user. Output goes to the app
// log; the last result is kept on the job.
const crypto = require('crypto');
const path = require('path');
const cron = require('node-cron');
const { run, HttpError } = require('./util');
const { appEnv } = require('./processes');

const MAX_JOBS = 20;
const TIMEOUT_MS = 30 * 60000;

class Jobs {
  constructor({ cfg, registry, pm, notifier, runAs = null, log = console }) {
    Object.assign(this, { cfg, registry, pm, notifier, runAs, log });
    this.tasks = new Map(); // `${appId}/${jobId}` -> cron task
    this.running = new Set();
  }

  list(id) {
    return (this.registry.get(id).jobs || []).map((j) => ({ ...j, running: this.running.has(`${id}/${j.id}`) }));
  }

  validate({ name, schedule, command, enabled = true }) {
    if (!name || typeof name !== 'string' || name.length > 60) throw new HttpError(400, 'Give the task a name (max 60 characters)');
    if (typeof schedule !== 'string' || !cron.validate(schedule)) throw new HttpError(400, 'Invalid schedule: use cron syntax, e.g. "0 * * * *" for every hour');
    if (schedule.trim().split(/\s+/).length !== 5) throw new HttpError(400, 'Use a 5-field schedule (minute hour day month weekday)');
    if (!command || typeof command !== 'string' || command.length > 2000 || /[\0\r\n]/.test(command)) throw new HttpError(400, 'Invalid command (one line, max 2000 characters)');
    return { name: name.trim(), schedule: schedule.trim(), command: command.trim(), enabled: !!enabled };
  }

  add(id, body) {
    const app = this.registry.get(id);
    const jobs = app.jobs || [];
    if (jobs.length >= MAX_JOBS) throw new HttpError(400, `At most ${MAX_JOBS} tasks per app`);
    const job = { id: crypto.randomBytes(4).toString('hex'), ...this.validate(body), lastRun: null };
    this.registry.update(id, { jobs: [...jobs, job] });
    this.schedule(id, job);
    return job;
  }

  edit(id, jobId, body) {
    const app = this.registry.get(id);
    const jobs = app.jobs || [];
    const i = jobs.findIndex((j) => j.id === jobId);
    if (i < 0) throw new HttpError(404, 'Task not found');
    const job = { ...jobs[i], ...this.validate({ ...jobs[i], ...body }) };
    const next = [...jobs];
    next[i] = job;
    this.registry.update(id, { jobs: next });
    this.schedule(id, job);
    return job;
  }

  remove(id, jobId) {
    const app = this.registry.get(id);
    const jobs = app.jobs || [];
    if (!jobs.some((j) => j.id === jobId)) throw new HttpError(404, 'Task not found');
    this.cancel(id, jobId);
    this.registry.update(id, { jobs: jobs.filter((j) => j.id !== jobId) });
  }

  schedule(id, job) {
    this.cancel(id, job.id);
    if (!job.enabled) return;
    this.tasks.set(`${id}/${job.id}`, cron.schedule(job.schedule, () => { this.runNow(id, job.id).catch(() => {}); }));
  }

  cancel(id, jobId) {
    const key = `${id}/${jobId}`;
    const t = this.tasks.get(key);
    if (t) { t.stop(); this.tasks.delete(key); }
  }

  cancelApp(id) {
    for (const key of [...this.tasks.keys()]) if (key.startsWith(`${id}/`)) { this.tasks.get(key).stop(); this.tasks.delete(key); }
  }

  async runNow(id, jobId) {
    const app = this.registry.get(id);
    if (!app) return null;
    const job = (app.jobs || []).find((j) => j.id === jobId);
    if (!job) throw new HttpError(404, 'Task not found');
    const key = `${id}/${jobId}`;
    if (this.running.has(key)) throw new HttpError(409, 'This task is still running');
    this.running.add(key);
    const started = Date.now();
    this.pm.note(id, `Task "${job.name}" started: ${job.command}`);
    let code = 0;
    let error = null;
    try {
      // Docker Edition: the task runs inside the app's container, not next to the Docker socket.
      if (this.cfg.containerMode) {
        await run('docker', ['exec', `pipaas-${id}`, 'sh', '-c', job.command], {
          timeout: TIMEOUT_MS, onOutput: (chunk) => this.pm.appendLog(id, chunk),
        });
      } else await run('/bin/sh', ['-c', job.command], {
        cwd: path.join(this.cfg.appsDir, id),
        env: appEnv(this.cfg, id, app),
        timeout: TIMEOUT_MS,
        onOutput: (chunk) => this.pm.appendLog(id, chunk),
        ...(this.runAs || {}),
      });
    } catch (err) {
      code = err.code === undefined ? -1 : err.code;
      error = err.message.slice(0, 300);
    } finally {
      this.running.delete(key);
    }
    const lastRun = { at: new Date(started).toISOString(), durationMs: Date.now() - started, code, error };
    this.pm.note(id, `Task "${job.name}" ${code === 0 ? 'finished' : `failed (${error})`} in ${Math.round(lastRun.durationMs / 1000)} s`);
    const current = this.registry.get(id);
    if (current) {
      this.registry.update(id, { jobs: (current.jobs || []).map((j) => (j.id === jobId ? { ...j, lastRun } : j)) });
    }
    if (code !== 0 && this.notifier) {
      this.notifier.notify('crash', { app: id, key: `job:${key}`, level: 'error', title: `Task "${job.name}" of ${app.name} failed`, message: error || `exit code ${code}` });
    }
    return lastRun;
  }

  restoreAll() {
    for (const app of this.registry.all()) for (const job of app.jobs || []) this.schedule(app.id, job);
  }

  stopAll() {
    for (const t of this.tasks.values()) t.stop();
    this.tasks.clear();
  }
}

module.exports = { Jobs };
