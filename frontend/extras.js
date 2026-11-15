/* Pi-PaaS panel, second half: metrics charts, previous versions, scheduled
   tasks, panel settings (account, 2FA, users, API tokens, notifications,
   network, offsite backups, updates, activity), browser push and the
   service worker. Builds on the helpers app.js exposes as window.Pi. */
(() => {
  'use strict';
  const Pi = window.Pi;
  const { api, t, esc, toast, busy, openM, fmtSize, fmtDate, $ } = Pi;
  const SVG = 'http://www.w3.org/2000/svg';

  // ---------- small helpers ----------

  function ago(iso) {
    if (!iso) return '';
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || 'en', { numeric: 'auto' });
    if (s < 60) return rtf.format(-s, 'second');
    if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
    if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
    return rtf.format(-Math.round(s / 86400), 'day');
  }

  function el(tag, attrs = {}, text) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.includes('-') || k === 'for' || k === 'role' || k === 'inputmode' || !(k in n)) n.setAttribute(k, v === true ? '' : v);
      else n[k] = v;
    }
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  // ---------- line chart (one series, one axis) ----------

  /**
   * points: [{t, v}] with v possibly null. Draws a 2px line with a light
   * area wash, hairline grid, an end dot with its value, and a crosshair
   * tooltip that snaps to the nearest sample.
   */
  function lineChart(container, { title, points, fmt, max }) {
    container.innerHTML = '';
    const fig = el('figure', { class: 'chart' });
    fig.append(el('figcaption', {}, title));
    container.append(fig);
    const data = points.filter((p) => p.v !== null && p.v !== undefined);
    if (data.length < 2) {
      fig.append(el('p', { class: 'dim small' }, t('notEnoughData')));
      return;
    }
    const W = 640;
    const H = 180;
    const pad = { l: 56, r: 64, t: 10, b: 24 };
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const yMax = niceMax(Math.max(max || 0, ...data.map((p) => p.v)) * 1.1);
    const x = (tt) => pad.l + ((tt - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'chart-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${title}: ${fmt(data[data.length - 1].v)}`);
    const add = (name, attrs) => {
      const n = document.createElementNS(SVG, name);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      svg.append(n);
      return n;
    };
    // Pick 4 or 5 intervals so every tick is a round number.
    const steps = [4, 5].find((n) => [1, 2, 2.5, 5].includes(Number(((yMax / n) / 10 ** Math.floor(Math.log10(yMax / n))).toFixed(2)))) || 4;
    for (let i = 0; i <= steps; i++) {
      const v = (yMax / steps) * i;
      add('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' });
      const lbl = add('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' });
      lbl.textContent = fmt(v);
    }
    const minutes = Math.max(1, Math.round((t1 - t0) / 60000));
    const tl = add('text', { x: pad.l, y: H - 6, class: 'axis' });
    tl.textContent = t('minutesAgo', { n: minutes });
    const tr = add('text', { x: W - pad.r, y: H - 6, 'text-anchor': 'end', class: 'axis' });
    tr.textContent = t('now');
    // Gaps (null samples, e.g. while stopped) break the line instead of bridging it.
    let d = '';
    let area = '';
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        d += run.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
        area += `M${x(run[0].t).toFixed(1)},${y(0)}${run.map((p) => `L${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}L${x(run[run.length - 1].t).toFixed(1)},${y(0)}Z`;
      }
      run = [];
    };
    for (const p of points) { if (p.v === null || p.v === undefined) flush(); else run.push(p); }
    flush();
    add('path', { d: area, class: 'area' });
    add('path', { d, class: 'line' });
    const last = data[data.length - 1];
    add('circle', { cx: x(last.t), cy: y(last.v), r: 4, class: 'dot' });
    const endLbl = add('text', { x: x(last.t) + 10, y: y(last.v) + 4, class: 'end-label' });
    endLbl.textContent = fmt(last.v);
    const cross = add('line', { x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, class: 'crosshair', visibility: 'hidden' });
    const hoverDot = add('circle', { r: 4, class: 'dot', visibility: 'hidden' });
    const hit = add('rect', { x: pad.l, y: 0, width: W - pad.l - pad.r, height: H, fill: 'transparent' });
    fig.append(svg);
    const tip = el('div', { class: 'chart-tip', role: 'status' });
    tip.hidden = true;
    fig.append(tip);
    const show = (evt) => {
      const r = svg.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * W;
      let best = data[0];
      for (const p of data) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
      cross.setAttribute('x1', x(best.t));
      cross.setAttribute('x2', x(best.t));
      cross.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', x(best.t));
      hoverDot.setAttribute('cy', y(best.v));
      hoverDot.setAttribute('visibility', 'visible');
      tip.replaceChildren(el('strong', {}, fmt(best.v)), el('span', {}, new Date(best.t).toLocaleTimeString()));
      tip.hidden = false;
      const left = (x(best.t) / W) * r.width;
      tip.style.left = `${Math.min(Math.max(left, 60), r.width - 60)}px`;
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); hoverDot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerleave', hide);
  }

  // ---------- metrics dialog ----------

  let metricsTimer = null;
  async function openMetrics(a) {
    Pi.state.cur.metrics = a.id;
    $('mName').textContent = a.name;
    $('mCharts').innerHTML = `<p class="dim">${esc(t('loading'))}</p>`;
    $('mTable').checked = false;
    $('mTableOut').innerHTML = '';
    openM('mMod');
    await loadMetrics();
    clearInterval(metricsTimer);
    metricsTimer = setInterval(() => {
      if (!$('mMod').classList.contains('on')) return clearInterval(metricsTimer);
      loadMetrics();
      return undefined;
    }, 10000);
  }

  async function loadMetrics() {
    const id = Pi.state.cur.metrics;
    let m;
    try { m = await api('GET', `api/apps/${id}/metrics`); } catch (err) { $('mCharts').textContent = err.message; return; }
    const h = m.current.health;
    $('mHealth').textContent = h ? (h.ok ? t('healthOk', { status: h.status, ms: h.ms }) : t('healthBad', { error: h.error || `HTTP ${h.status}` })) : t('healthUnknown');
    $('mHealth').className = h && !h.ok ? 'warn-text' : 'dim';
    $('mCharts').innerHTML = '';
    const cpu = el('div');
    const mem = el('div');
    $('mCharts').append(cpu, mem);
    lineChart(cpu, { title: t('chartCpu'), points: m.series.map((s) => ({ t: s.t, v: s.cpu })), fmt: (v) => `${v.toFixed(v < 10 ? 1 : 0)}%`, max: 10 });
    // Plot memory in MB so the axis gets round ticks (0, 25, 50 MB…).
    const mb = (v) => (v > 0 && v < 10 ? `${v.toFixed(1)} MB` : `${Math.round(v)} MB`);
    lineChart(mem, { title: t('chartMem'), points: m.series.map((s) => ({ t: s.t, v: s.mem == null ? null : s.mem / 1048576 })), fmt: mb, max: 32 });
    renderMetricsTable(m.series);
  }

  function renderMetricsTable(series) {
    const out = $('mTableOut');
    if (!$('mTable').checked) { out.innerHTML = ''; return; }
    const rows = series.slice(-60).reverse();
    out.innerHTML = `<div class="sql-out"><table><thead><tr><th>${esc(t('time'))}</th><th>CPU</th><th>${esc(t('memory'))}</th><th>${esc(t('processes'))}</th></tr></thead><tbody>${
      rows.map((s) => `<tr><td>${esc(new Date(s.t).toLocaleTimeString())}</td><td>${s.cpu === null ? '' : `${s.cpu}%`}</td><td>${esc(fmtSize(s.mem))}</td><td>${s.procs}</td></tr>`).join('')}</tbody></table></div>`;
  }
  $('mTable').addEventListener('change', () => loadMetrics());

  // ---------- previous versions ----------

  async function openReleases(a) {
    Pi.state.cur.releases = a.id;
    $('rName').textContent = a.name;
    $('rCurrent').textContent = t('currentVersion', { v: a.version });
    $('rList').innerHTML = `<div class="placeholder">${esc(t('loading'))}</div>`;
    openM('rMod');
    try {
      const list = await api('GET', `api/apps/${a.id}/releases`);
      $('rList').innerHTML = list.length ? list.map((r) => `<div class="bk-item">
        <div><div class="bk-date">v${esc(r.version)}${r.source && r.source.commit ? ` <code>${esc(r.source.commit.slice(0, 7))}</code>` : ''}</div>
        <div class="bk-size">${esc(t('replacedAgo', { when: ago(r.replacedAt) }))}</div></div>
        <div class="bk-acts"><button class="btn btn-s" type="button" data-rollback="${esc(r.version)}">${esc(t('rollback'))}</button></div></div>`).join('')
        : `<div class="placeholder">${esc(t('noReleases'))}</div>`;
    } catch (err) { $('rList').textContent = err.message; }
  }

  $('rList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rollback]');
    if (!b) return;
    const id = Pi.state.cur.releases;
    if (!confirm(t('rollbackConfirm', { v: b.dataset.rollback }))) return;
    try {
      await busy(b, () => api('POST', `api/apps/${id}/releases/${b.dataset.rollback}/rollback`));
      toast(t('rollbackStarted'));
      Pi.closeM('rMod');
      Pi.refresh();
      const a = Pi.state.apps.find((x) => x.id === id);
      if (a) Pi.openLogs(a);
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- scheduled tasks ----------

  async function openJobs(a) {
    Pi.state.cur.jobs = a.id;
    $('jName').textContent = a.name;
    $('jForm').reset();
    $('jSchedule').value = '0 3 * * *';
    openM('jMod');
    loadJobs();
  }

  async function loadJobs() {
    const id = Pi.state.cur.jobs;
    try {
      const jobs = await api('GET', `api/apps/${id}/jobs`);
      $('jList').innerHTML = jobs.length ? jobs.map((j) => {
        const lr = j.lastRun;
        const last = j.running ? t('jobRunning') : lr ? `${lr.code === 0 ? t('jobOk') : t('jobFailed', { code: lr.code })} ${ago(lr.at)}` : t('jobNever');
        return `<div class="bk-item">
          <div><div class="bk-date">${esc(j.name)} <code>${esc(j.schedule)}</code></div>
          <div class="bk-size"><code>${esc(j.command)}</code></div>
          <div class="bk-size ${lr && lr.code !== 0 ? 'warn-text' : ''}">${esc(last)}</div></div>
          <div class="bk-acts">
            <button class="btn btn-s" type="button" data-job-run="${esc(j.id)}">${esc(t('jobRun'))}</button>
            <button class="btn btn-s" type="button" data-job-toggle="${esc(j.id)}" data-on="${j.enabled ? '1' : '0'}">${esc(j.enabled ? t('jobPause') : t('jobResume'))}</button>
            <button class="btn btn-s btn-d" type="button" data-job-del="${esc(j.id)}">${esc(t('delete'))}</button>
          </div></div>`;
      }).join('') : `<div class="placeholder">${esc(t('noJobs'))}</div>`;
    } catch (err) { $('jList').textContent = err.message; }
  }

  $('jList').addEventListener('click', async (e) => {
    const id = Pi.state.cur.jobs;
    const run = e.target.closest('[data-job-run]');
    const tog = e.target.closest('[data-job-toggle]');
    const del = e.target.closest('[data-job-del]');
    try {
      if (run) {
        await busy(run, () => api('POST', `api/apps/${id}/jobs/${run.dataset.jobRun}/run`));
        toast(t('jobStarted'));
        setTimeout(loadJobs, 1500);
      } else if (tog) {
        await api('PUT', `api/apps/${id}/jobs/${tog.dataset.jobToggle}`, { enabled: tog.dataset.on !== '1' });
        loadJobs();
      } else if (del) {
        if (!confirm(t('jobDeleteConfirm'))) return;
        await api('DELETE', `api/apps/${id}/jobs/${del.dataset.jobDel}`);
        loadJobs();
        Pi.refresh();
      }
    } catch (err) { toast(err.message, 'err'); }
  });

  $('jForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `api/apps/${Pi.state.cur.jobs}/jobs`, { name: $('jJobName').value.trim(), schedule: $('jSchedule').value.trim(), command: $('jCommand').value.trim() });
      $('jForm').reset();
      $('jSchedule').value = '0 3 * * *';
      toast(t('jobAdded'));
      loadJobs();
      Pi.refresh();
    } catch (err) { toast(err.message, 'err'); }
  });

  Object.assign(Pi.actions, { metrics: openMetrics, releases: openReleases, jobs: openJobs });

  // ---------- panel settings ----------

  let tab = 'account';
  Pi.openPanelSettings = (which) => {
    document.querySelectorAll('#psTabs [data-admin]').forEach((b) => { b.hidden = !Pi.isAdmin(); });
    showTab(which || tab);
    openM('psMod');
  };
  $('psTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  function showTab(name) {
    tab = name;
    document.querySelectorAll('#psTabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    const body = $('psBody');
    body.innerHTML = `<p class="dim">${esc(t('loading'))}</p>`;
    ({ account: tabAccount, users: tabUsers, tokens: tabTokens, notify: tabNotify, network: tabNetwork, backup: tabBackup, update: tabUpdate, activity: tabActivity })[name](body)
      .catch((err) => { body.innerHTML = `<p class="sql-err">${esc(err.message)}</p>`; });
  }

  function section(body, title, help) {
    const s = el('section', { class: 'ps-section' });
    s.append(el('h3', { class: 'sub' }, title));
    if (help) s.append(el('p', { class: 'help' }, help));
    body.append(s);
    return s;
  }

  function field(parent, label, input, help) {
    const w = el('div', { class: 'fg' });
    const id = input.id || `f${Math.random().toString(36).slice(2, 8)}`;
    input.id = id;
    if (input.type === 'checkbox') {
      const l = el('label', { class: 'chk', for: id });
      l.append(input, document.createTextNode(` ${label}`));
      w.append(l);
    } else {
      w.append(el('label', { for: id }, label), input);
    }
    if (help) w.append(el('p', { class: 'help' }, help));
    parent.append(w);
    return input;
  }

  // ----- account: password, 2FA, notifications on this device -----

  async function tabAccount(body) {
    const st = await api('GET', 'api/auth/status');
    body.innerHTML = '';
    const me = section(body, t('signedInAs', { name: st.user.name, role: t(`role_${st.user.role}`) }));
    const pw = el('button', { class: 'btn', type: 'button' }, t('changePassword'));
    pw.addEventListener('click', () => { Pi.closeM('psMod'); $('pForm').reset(); openM('pMod'); });
    me.append(pw);

    const tf = section(body, t('twoFactor'), t('twoFactorHelp'));
    if (st.user.totp) {
      tf.append(el('p', { class: 'good-text' }, t('twoFactorOn')));
      const pass = field(tf, t('currentPassword'), el('input', { type: 'password', autocomplete: 'current-password' }));
      const off = el('button', { class: 'btn btn-d', type: 'button' }, t('twoFactorOff'));
      off.addEventListener('click', async () => {
        try {
          await api('DELETE', 'api/auth/totp', { password: pass.value });
          toast(t('twoFactorDisabled'));
          showTab('account');
        } catch (err) { toast(err.message, 'err'); }
      });
      tf.append(off);
    } else {
      const start = el('button', { class: 'btn primary', type: 'button' }, t('twoFactorSetup'));
      start.addEventListener('click', async () => {
        try {
          const s = await api('POST', 'api/auth/totp');
          start.remove();
          const qr = el('div', { class: 'qr' });
          if (window.qrcode) {
            const q = window.qrcode(0, 'M');
            q.addData(s.uri);
            q.make();
            qr.innerHTML = q.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
          }
          tf.append(qr, el('p', { class: 'help' }, t('twoFactorScan')), el('p', {}, ''), el('code', { class: 'secret-show' }, s.secret.replace(/(.{4})/g, '$1 ').trim()));
          const code = field(tf, t('totpCode'), el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxLength: 6 }));
          const ok = el('button', { class: 'btn primary', type: 'button' }, t('twoFactorConfirm'));
          ok.addEventListener('click', async () => {
            try {
              await api('PUT', 'api/auth/totp', { code: code.value.trim() });
              toast(t('twoFactorEnabled'));
              showTab('account');
            } catch (err) { toast(err.message, 'err'); }
          });
          tf.append(ok);
          code.focus();
        } catch (err) { toast(err.message, 'err'); }
      });
      tf.append(start);
    }

    const pushSec = section(body, t('pushTitle'), t('pushHelp'));
    renderPush(pushSec);
  }

  async function renderPush(sec) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      sec.append(el('p', { class: 'dim' }, t('pushUnsupported')));
      return;
    }
    if (!window.isSecureContext) {
      sec.append(el('p', { class: 'warn-text' }, t('pushNeedsHttps')));
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    const row = el('div', { class: 'row gap' });
    sec.append(row);
    if (sub) {
      row.append(el('span', { class: 'good-text' }, t('pushOn')));
      const test = el('button', { class: 'btn', type: 'button' }, t('pushTest'));
      test.addEventListener('click', async () => {
        try { await busy(test, () => api('POST', 'api/push/test')); toast(t('pushSent')); } catch (err) { toast(err.message, 'err'); }
      });
      const off = el('button', { class: 'btn', type: 'button' }, t('pushDisable'));
      off.addEventListener('click', async () => {
        try {
          await api('DELETE', 'api/push/subscribe', { endpoint: sub.endpoint });
          await sub.unsubscribe();
          showTab('account');
        } catch (err) { toast(err.message, 'err'); }
      });
      row.append(test, off);
    } else {
      const on = el('button', { class: 'btn primary', type: 'button' }, t('pushEnable'));
      on.addEventListener('click', async () => {
        try {
          if ((await Notification.requestPermission()) !== 'granted') throw new Error(t('pushDenied'));
          const { publicKey } = await api('GET', 'api/push/key');
          const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
          const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
          await api('POST', 'api/push/subscribe', { subscription: s.toJSON() });
          toast(t('pushOn'));
          showTab('account');
        } catch (err) { toast(err.message, 'err'); }
      });
      row.append(on);
    }
  }

  // ----- users -----

  async function tabUsers(body) {
    const users = await api('GET', 'api/users');
    body.innerHTML = '';
    const list = section(body, t('tabUsers'), t('rolesHelp'));
    for (const u of users) {
      const row = el('div', { class: 'bk-item' });
      const info = el('div');
      info.append(el('div', { class: 'bk-date' }, u.name), el('div', { class: 'bk-size' }, [u.totp ? t('twoFactorOn') : '', u.lastLogin ? t('lastLogin', { when: ago(u.lastLogin) }) : t('neverLoggedIn')].filter(Boolean).join(', ')));
      const role = el('select', { class: 'sel', 'aria-label': t('role') });
      for (const r of ['viewer', 'operator', 'admin']) role.append(el('option', { value: r, selected: r === u.role }, t(`role_${r}`)));
      role.addEventListener('change', async () => {
        try { await api('PUT', `api/users/${encodeURIComponent(u.name)}`, { role: role.value }); toast(t('saved')); } catch (err) { toast(err.message, 'err'); role.value = u.role; }
      });
      const acts = el('div', { class: 'bk-acts' });
      acts.append(role);
      if (u.totp) {
        const r2 = el('button', { class: 'btn btn-s', type: 'button' }, t('reset2fa'));
        r2.addEventListener('click', async () => {
          if (!confirm(t('reset2faConfirm', { name: u.name }))) return;
          try { await api('DELETE', `api/users/${encodeURIComponent(u.name)}/totp`); showTab('users'); } catch (err) { toast(err.message, 'err'); }
        });
        acts.append(r2);
      }
      const pw = el('button', { class: 'btn btn-s', type: 'button' }, t('setPassword'));
      pw.addEventListener('click', async () => {
        const p = prompt(t('newPasswordFor', { name: u.name }));
        if (!p) return;
        try { await api('PUT', `api/users/${encodeURIComponent(u.name)}`, { password: p }); toast(t('pwChanged')); } catch (err) { toast(err.message, 'err'); }
      });
      const del = el('button', { class: 'btn btn-s btn-d', type: 'button' }, t('delete'));
      del.addEventListener('click', async () => {
        if (!confirm(t('deleteUserConfirm', { name: u.name }))) return;
        try { await api('DELETE', `api/users/${encodeURIComponent(u.name)}`); showTab('users'); } catch (err) { toast(err.message, 'err'); }
      });
      acts.append(pw, del);
      row.append(info, acts);
      list.append(row);
    }
    const add = section(body, t('addUser'));
    const form = el('form', { class: 'row three' });
    const name = el('input', { required: true, autocomplete: 'off', placeholder: t('username'), 'aria-label': t('username') });
    const pass = el('input', { type: 'password', required: true, minLength: 8, autocomplete: 'new-password', placeholder: t('password'), 'aria-label': t('password') });
    const role = el('select', { class: 'sel', 'aria-label': t('role') });
    for (const r of ['viewer', 'operator', 'admin']) role.append(el('option', { value: r }, t(`role_${r}`)));
    const btn = el('button', { class: 'btn primary', type: 'submit' }, t('addUser'));
    form.append(name, pass, role, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', 'api/users', { username: name.value.trim().toLowerCase(), password: pass.value, role: role.value });
        toast(t('userAdded'));
        showTab('users');
      } catch (err) { toast(err.message, 'err'); }
    });
    add.append(form);
  }

  // ----- API tokens and the command line -----

  async function tabTokens(body) {
    const tokens = await api('GET', `api/tokens${Pi.isAdmin() ? '?all=1' : ''}`);
    body.innerHTML = '';
    const list = section(body, t('tabTokens'), t('tokensHelp'));
    if (!tokens.length) list.append(el('p', { class: 'dim' }, t('noTokens')));
    for (const tk of tokens) {
      const row = el('div', { class: 'bk-item' });
      const info = el('div');
      info.append(el('div', { class: 'bk-date' }, tk.name), el('div', { class: 'bk-size' }, `${tk.user}, ${t(`role_${tk.role}`)}, ${tk.lastUsed ? t('usedAgo', { when: ago(tk.lastUsed) }) : t('neverUsed')}`));
      const del = el('button', { class: 'btn btn-s btn-d', type: 'button' }, t('revoke'));
      del.addEventListener('click', async () => {
        if (!confirm(t('revokeConfirm', { name: tk.name }))) return;
        try { await api('DELETE', `api/tokens/${tk.id}`); showTab('tokens'); } catch (err) { toast(err.message, 'err'); }
      });
      const acts = el('div', { class: 'bk-acts' });
      acts.append(del);
      row.append(info, acts);
      list.append(row);
    }
    const add = section(body, t('newToken'));
    const form = el('form', { class: 'row three' });
    const name = el('input', { required: true, maxLength: 60, placeholder: t('tokenNamePh'), 'aria-label': t('tokenName') });
    const role = el('select', { class: 'sel', 'aria-label': t('role') });
    for (const r of ['viewer', 'operator', 'admin']) {
      if (['viewer', 'operator', 'admin'].indexOf(r) <= ['viewer', 'operator', 'admin'].indexOf(Pi.state.me.role)) role.append(el('option', { value: r, selected: r === Pi.state.me.role }, t(`role_${r}`)));
    }
    form.append(name, role, el('button', { class: 'btn primary', type: 'submit' }, t('createToken')));
    const shown = el('div');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', 'api/tokens', { name: name.value.trim(), role: role.value });
        shown.innerHTML = '';
        const code = el('code', { class: 'secret-show' }, r.token);
        const copy = el('button', { class: 'btn btn-s', type: 'button' }, t('copy'));
        copy.addEventListener('click', () => navigator.clipboard.writeText(r.token).then(() => toast(t('copied')), () => toast(t('copyFailed'), 'err')));
        const box = el('div', { class: 'copy' });
        box.append(code, copy);
        shown.append(el('p', { class: 'warn-text' }, t('tokenOnce')), box);
        name.value = '';
      } catch (err) { toast(err.message, 'err'); }
    });
    add.append(form, shown);
    const origin = location.href.replace(/[#?].*$/, '').replace(/\/$/, '');
    const cli = section(body, t('cliTitle'), t('cliHelp'));
    cli.append(el('pre', { class: 'cmd' }, `curl -o pipaas ${origin}/cli/pipaas.js && chmod +x pipaas\n./pipaas login ${origin}\n./pipaas deploy ./my-app`));
  }

  // ----- notifications -----

  async function tabNotify(body) {
    if (!Pi.isAdmin()) {
      body.innerHTML = '';
      renderPush(section(body, t('pushTitle'), t('pushHelp')));
      return;
    }
    const s = await api('GET', 'api/settings');
    const n = s.notifications;
    body.innerHTML = '';
    const form = el('form');
    const ch = section(form, t('channels'), t('channelsHelp'));
    const ntfyOn = field(ch, 'ntfy', el('input', { type: 'checkbox', checked: n.ntfy.enabled }));
    const ntfyUrl = field(ch, t('ntfyServer'), el('input', { value: n.ntfy.url, spellcheck: false }));
    const ntfyTopic = field(ch, t('ntfyTopic'), el('input', { value: n.ntfy.topic, spellcheck: false }));
    const ntfyToken = field(ch, t('ntfyToken'), el('input', { type: 'password', value: n.ntfy.token, autocomplete: 'off' }));
    const tgOn = field(ch, 'Telegram', el('input', { type: 'checkbox', checked: n.telegram.enabled }));
    const tgToken = field(ch, t('tgToken'), el('input', { type: 'password', value: n.telegram.botToken, autocomplete: 'off' }));
    const tgChat = field(ch, t('tgChat'), el('input', { value: n.telegram.chatId, spellcheck: false }));
    const whOn = field(ch, t('webhook'), el('input', { type: 'checkbox', checked: n.webhook.enabled }));
    const whUrl = field(ch, t('webhookAddress'), el('input', { type: 'password', value: n.webhook.url, autocomplete: 'off', placeholder: 'https://' }));
    const pushOn = field(ch, t('pushTitle'), el('input', { type: 'checkbox', checked: n.push.enabled }));
    const ev = section(form, t('whatToSend'));
    const evInputs = {};
    for (const k of ['crash', 'unhealthy', 'deployFailed', 'backupFailed', 'temperature', 'disk', 'update']) {
      evInputs[k] = field(ev, t(`ev_${k}`), el('input', { type: 'checkbox', checked: n.events[k] !== false }));
    }
    const lim = section(form, t('limits'));
    const temp = field(lim, t('tempLimit'), el('input', { type: 'number', min: 40, max: 100, value: n.tempLimit }));
    const disk = field(lim, t('diskLimit'), el('input', { type: 'number', min: 50, max: 99, value: n.diskLimitPercent }));
    const row = el('div', { class: 'row gap' });
    const save = el('button', { class: 'btn primary', type: 'submit' }, t('save'));
    const test = el('button', { class: 'btn', type: 'button' }, t('sendTest'));
    row.append(save, test);
    form.append(row);
    body.append(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await busy(save, () => api('PUT', 'api/settings', {
          notifications: {
            ntfy: { enabled: ntfyOn.checked, url: ntfyUrl.value.trim(), topic: ntfyTopic.value.trim(), token: ntfyToken.value },
            telegram: { enabled: tgOn.checked, botToken: tgToken.value.trim(), chatId: tgChat.value.trim() },
            webhook: { enabled: whOn.checked, url: whUrl.value.trim() },
            push: { enabled: pushOn.checked },
            events: Object.fromEntries(Object.entries(evInputs).map(([k, i]) => [k, i.checked])),
            tempLimit: Number(temp.value),
            diskLimitPercent: Number(disk.value),
          },
        }));
        toast(t('settingsSaved'));
      } catch (err) { toast(err.message, 'err'); }
    });
    test.addEventListener('click', async () => {
      try {
        const r = await busy(test, () => api('POST', 'api/settings/test-notification'));
        const bad = r.results.filter((x) => !x.ok);
        if (bad.length) toast(bad.map((x) => `${x.channel}: ${x.error}`).join('; '), 'err');
        else toast(t('testSent', { channels: r.results.map((x) => x.channel).join(', ') }));
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  // ----- network: proxy, domains, certificates, .local names -----

  async function tabNetwork(body) {
    const [s, px] = await Promise.all([api('GET', 'api/settings'), api('GET', 'api/proxy')]);
    body.innerHTML = '';
    const form = el('form');
    const st = section(form, t('proxyTitle'), t('proxyHelp'));
    st.append(el('p', { class: px.http ? 'good-text' : 'warn-text' }, px.http ? t('proxyOn', { http: px.http, https: px.https || '-' }) : t('proxyOff')));
    const on = field(st, t('proxyEnable'), el('input', { type: 'checkbox', checked: s.proxy.enabled }));
    const mdns = field(st, t('mdnsEnable'), el('input', { type: 'checkbox', checked: s.mdns.enabled }), t('mdnsHelp'));
    const dom = section(form, t('domainTitle'), t('domainHelp'));
    const domain = field(dom, t('baseDomain'), el('input', { value: s.proxy.domain, placeholder: 'pi.example.com', spellcheck: false }));
    const email = field(dom, t('acmeEmail'), el('input', { type: 'email', value: s.proxy.acmeEmail, placeholder: 'you@example.com' }), t('acmeHelp'));
    const staging = field(dom, t('acmeStaging'), el('input', { type: 'checkbox', checked: s.proxy.acmeStaging }));
    if (px.certificates.length) {
      const certs = section(form, t('certificates'));
      for (const c of px.certificates) {
        const line = c.validUntil ? t('certUntil', { date: fmtDate(c.validUntil) }) : c.issuing ? t('certIssuing') : c.error ? `${t('certFailed')}: ${c.error}` : t('certNone');
        const row = el('div', { class: 'bk-item' });
        const info = el('div');
        info.append(el('div', { class: 'bk-date' }, c.host), el('div', { class: `bk-size ${c.error ? 'warn-text' : ''}` }, line));
        row.append(info);
        certs.append(row);
      }
    }
    const save = el('button', { class: 'btn primary', type: 'submit' }, t('save'));
    form.append(save);
    body.append(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await busy(save, () => api('PUT', 'api/settings', {
          proxy: { enabled: on.checked, domain: domain.value.trim().toLowerCase(), acmeEmail: email.value.trim(), acmeStaging: staging.checked },
          mdns: { enabled: mdns.checked },
        }));
        toast(t('settingsSaved'));
        setTimeout(() => { showTab('network'); Pi.refresh(); }, 1500);
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  // ----- offsite backups -----

  async function tabBackup(body) {
    const s = await api('GET', 'api/settings');
    const b = s.backups;
    body.innerHTML = '';
    const form = el('form');
    const sec = section(form, t('offsiteTitle'), t('offsiteHelp'));
    const target = el('select', { class: 'sel' });
    for (const [v, k] of [['none', 'targetNone'], ['folder', 'targetFolder'], ['rclone', 'targetRclone']]) target.append(el('option', { value: v, selected: b.target === v }, t(k)));
    field(sec, t('target'), target);
    const folder = field(sec, t('targetFolderPath'), el('input', { value: b.folder, placeholder: '/mnt/nas/backups', spellcheck: false }), t('targetFolderHelp'));
    const rclone = field(sec, t('targetRcloneRemote'), el('input', { value: b.rclone, placeholder: 'b2:my-bucket/pi', spellcheck: false }), t('targetRcloneHelp'));
    const pass = field(sec, t('passphrase'), el('input', { type: 'password', value: b.passphrase, autocomplete: 'new-password' }), t('passphraseHelp'));
    const verify = field(sec, t('verifyAfter'), el('input', { type: 'checkbox', checked: b.verify }));
    const sync = () => {
      folder.closest('.fg').hidden = target.value !== 'folder';
      rclone.closest('.fg').hidden = target.value !== 'rclone';
    };
    target.addEventListener('change', sync);
    sync();
    const save = el('button', { class: 'btn primary', type: 'submit' }, t('save'));
    form.append(save);
    body.append(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await busy(save, () => api('PUT', 'api/settings', { backups: { target: target.value, folder: folder.value.trim(), rclone: rclone.value.trim(), passphrase: pass.value, verify: verify.checked } }));
        toast(t('settingsSaved'));
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  // ----- panel update -----

  let updatePoll = null;
  async function tabUpdate(body) {
    const st = await api('GET', 'api/panel/update');
    body.innerHTML = '';
    const sec = section(body, t('tabUpdate'));
    sec.append(el('p', {}, t('runningVersion', { v: st.current })));
    if (st.latest) sec.append(el('p', { class: st.available ? 'good-text' : 'dim' }, st.available ? t('updateAvailable', { v: st.latest.version }) : t('upToDate')));
    if (st.error) sec.append(el('p', { class: 'warn-text' }, st.error));
    if (st.checkedAt) sec.append(el('p', { class: 'dim small' }, t('checkedAgo', { when: ago(st.checkedAt) })));
    const row = el('div', { class: 'row gap' });
    const check = el('button', { class: 'btn', type: 'button' }, t('checkNow'));
    check.addEventListener('click', async () => { await busy(check, () => api('POST', 'api/panel/update/check')); showTab('update'); });
    row.append(check);
    if (st.available) {
      const go = el('button', { class: 'btn primary', type: 'button' }, t('installUpdate', { v: st.latest.version }));
      go.addEventListener('click', async () => {
        if (!confirm(t('installConfirm', { v: st.latest.version }))) return;
        try { await api('POST', 'api/panel/update'); pollUpdate(); } catch (err) { toast(err.message, 'err'); }
      });
      row.append(go);
    }
    sec.append(row);
    const auto = field(sec, t('autoCheck'), el('input', { type: 'checkbox', checked: (await api('GET', 'api/settings')).updates.check }));
    auto.addEventListener('change', () => api('PUT', 'api/settings', { updates: { check: auto.checked } }).then(() => toast(t('saved'))).catch((err) => toast(err.message, 'err')));
    sec.append(el('p', { class: 'help' }, t(st.mode === 'git' ? 'updateModeGit' : 'updateModeTarball')));
    if (st.latest && st.latest.notes) {
      const notes = section(body, t('releaseNotes', { v: st.latest.version }));
      notes.append(el('pre', { class: 'notes' }, st.latest.notes));
      if (st.latest.url) notes.append(el('a', { href: st.latest.url, target: '_blank', rel: 'noopener' }, t('openOnGithub')));
    }
    if (st.state === 'updating' || st.state === 'restarting' || st.state === 'failed') {
      sec.append(el('pre', { class: 'cmd', id: 'updOut' }, st.output));
      if (st.state !== 'failed') pollUpdate();
    }
  }

  function pollUpdate() {
    clearInterval(updatePoll);
    let seenDown = false;
    updatePoll = setInterval(async () => {
      try {
        const st = await api('GET', 'api/panel/update');
        if (seenDown || (st.state === 'idle' && !st.available)) {
          clearInterval(updatePoll);
          toast(t('updateDone', { v: st.current }));
          setTimeout(() => location.reload(), 1000);
          return;
        }
        if ($('psMod').classList.contains('on') && tab === 'update') {
          const out = $('updOut');
          if (out) out.textContent = st.output;
          else showTab('update');
        }
        if (st.state === 'failed') { clearInterval(updatePoll); showTab('update'); }
      } catch {
        seenDown = true; // the panel is restarting
      }
    }, 2000);
  }

  // ----- activity -----

  async function tabActivity(body) {
    const events = await api('GET', 'api/events?limit=100');
    body.innerHTML = '';
    const sec = section(body, t('tabActivity'), t('activityHelp'));
    if (!events.length) sec.append(el('p', { class: 'dim' }, t('noActivity')));
    for (const e of events) {
      const row = el('div', { class: `event lvl-${e.level}` });
      row.append(el('i', { class: 'led' }));
      const txt = el('div');
      txt.append(el('div', { class: 'bk-date' }, e.title), el('div', { class: 'bk-size' }, e.message));
      row.append(txt, el('time', { class: 'dim small', title: fmtDate(e.at) }, ago(e.at)));
      sec.append(row);
    }
  }

  // ---------- on panel start ----------

  Pi.onPanel = async () => {
    if (Pi.isAdmin()) {
      try {
        const st = await api('GET', 'api/panel/update');
        if (st.available) {
          $('updText').textContent = t('updateAvailable', { v: st.latest.version });
          $('updBanner').hidden = false;
        }
      } catch { /* not critical */ }
    }
    // Opened from a notification: show that app's log.
    const m = /#app=([a-z0-9-]+)/.exec(location.hash);
    if (m) {
      history.replaceState(null, '', location.pathname + location.search);
      setTimeout(() => {
        const a = Pi.state.apps.find((x) => x.id === m[1]);
        if (a) Pi.openLogs(a);
      }, 800);
    }
  };
  $('updBtn').addEventListener('click', () => Pi.openPanelSettings('update'));

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
