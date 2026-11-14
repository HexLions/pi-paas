/* Pi-PaaS panel. Plain JS, no build step. All URLs are relative so the panel
   also works behind a reverse proxy under a sub-path such as /pi-paas/. */
(() => {
  'use strict';
  const { t, setLang, getLang, LANGS } = window.PiI18n;
  const $ = (id) => document.getElementById(id);

  const state = {
    apps: [],
    system: null,
    timer: null,
    cur: { update: null, logs: null, del: null, files: null, backups: null, db: null, settings: null },
    file: null, // { path, mtime, orig }
    dirty: false,
    cm: null,
    logTimer: null,
  };

  // ---------- helpers ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtSize(b) {
    if (b == null) return '?';
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
    return `${(b / 1073741824).toFixed(1)} GB`;
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString(getLang()); } catch { return iso; }
  }

  function encPath(p) {
    return p.split('/').map(encodeURIComponent).join('/');
  }

  async function api(method, url, body, isForm = false) {
    const opts = { method, headers: { 'X-PiPaaS': '1' }, credentials: 'same-origin' };
    if (body !== undefined) {
      if (isForm) opts.body = body;
      else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { data = {}; }
    if (res.status === 401 && !url.startsWith('api/auth/')) {
      showLogin();
      throw new Error(t('sessionExpired'));
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'err' ? 'alert' : 'status');
    el.textContent = `${type === 'ok' ? '✓' : '✕'} ${msg}`;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'err' ? 7000 : 4000);
  }

  async function busy(btn, fn) {
    const html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>';
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
  }

  function openM(id) {
    $(id).classList.add('on');
    const first = $(id).querySelector('input:not([type=hidden]):not([type=file]), select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
  }

  function closeM(id) {
    if (id === 'eMod' && state.dirty && !confirm(t('unsavedClose'))) return;
    $(id).classList.remove('on');
    if (id === 'eMod') { destroyCM(); state.cur.files = null; state.file = null; state.dirty = false; }
    if (id === 'lMod') { clearInterval(state.logTimer); state.logTimer = null; }
  }

  // ---------- i18n ----------

  function applyI18n() {
    document.documentElement.lang = getLang();
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', t(el.dataset.i18nTitle)); });
    $('eShortcuts').innerHTML = [
      ['Ctrl', 'S', 'shortcutSave'], ['Ctrl', 'F', 'shortcutFind'], ['Ctrl', 'H', 'shortcutReplace'],
      ['Ctrl', 'Z', 'shortcutUndo'], ['Ctrl', '/', 'shortcutComment'], ['Ctrl', 'Space', 'shortcutComplete'],
    ].map(([a, b, k]) => `<kbd>${a}</kbd>+<kbd>${b}</kbd> ${esc(t(k))}`).join(' · ');
    $('loginHint').innerHTML = t('initialPwHint');
    $('dTypeHelp').innerHTML = t(`help_${$('dType').value}`);
    renderApps();
    renderStats();
  }

  function initLangs() {
    const sel = $('langSel');
    sel.innerHTML = Object.entries(LANGS).map(([code, l]) => `<option value="${code}">${l.flag} ${esc(l.name)}</option>`).join('');
    sel.value = getLang();
    sel.addEventListener('change', () => { setLang(sel.value); applyI18n(); });
  }

  // ---------- theme ----------

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('pipaas-theme'); } catch { /* private mode */ }
    if (saved) document.documentElement.dataset.theme = saved;
    $('themeBtn').addEventListener('click', () => {
      const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
      const next = dark ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('pipaas-theme', next); } catch { /* ignore */ }
    });
  }

  // ---------- auth ----------

  async function boot() {
    let st;
    try { st = await api('GET', 'api/auth/status'); } catch (e) { toast(e.message, 'err'); return; }
    $('ver').textContent = `v${st.version}`;
    $('loginHint').hidden = !st.initialPassword;
    $('pwBanner').hidden = !st.initialPassword;
    $('pwBtn').hidden = !st.authRequired;
    $('logoutBtn').hidden = !st.authRequired;
    if (st.authenticated) showPanel(); else showLogin();
  }

  function showLogin() {
    clearTimeout(state.timer);
    document.querySelectorAll('.ov.on').forEach((o) => o.classList.remove('on'));
    $('panel').hidden = true;
    $('login').hidden = false;
    $('loginPw').value = '';
    $('loginPw').focus();
  }

  function showPanel() {
    $('login').hidden = true;
    $('panel').hidden = false;
    refresh();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try {
      await api('POST', 'api/auth/login', { password: $('loginPw').value });
      boot();
    } catch (err) { $('loginErr').textContent = err.message; }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('POST', 'api/auth/logout'); } catch { /* ignore */ }
    showLogin();
  });

  const openPw = () => { $('pForm').reset(); openM('pMod'); };
  $('pwBtn').addEventListener('click', openPw);
  $('pwBannerBtn').addEventListener('click', openPw);
  $('pForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('pNew').value !== $('pNew2').value) return toast(t('pwMismatch'), 'err');
    try {
      await api('PUT', 'api/auth/password', { current: $('pCur').value, next: $('pNew').value });
      toast(t('pwChanged'));
      $('pwBanner').hidden = true;
      $('loginHint').hidden = true;
      closeM('pMod');
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- data ----------

  async function refresh() {
    clearTimeout(state.timer);
    try {
      const [apps, system] = await Promise.all([api('GET', 'api/apps'), api('GET', 'api/system').catch(() => null)]);
      state.apps = apps;
      state.system = system;
      renderApps();
      renderStats();
    } catch (e) {
      if ($('panel').hidden) return;
      console.error(e);
    }
    if ($('panel').hidden) return;
    const anyBusy = state.apps.some((a) => a.task || a.status === 'restarting');
    state.timer = setTimeout(refresh, anyBusy ? 2000 : 10000);
  }

  function renderStats() {
    const s = state.system;
    if (!s) { $('stats').innerHTML = ''; return; }
    const parts = [];
    if (s.temperature != null) {
      const cls = s.temperature >= 75 ? 'burn' : s.temperature >= 65 ? 'hot' : '';
      parts.push(`<span class="${cls}" title="${esc(t('cpuTemp'))}">🌡 <b>${s.temperature.toFixed(1)}°C</b></span>`);
    }
    parts.push(`<span title="${esc(t('load'))}">⚙ <b>${s.load[0].toFixed(2)}</b>/${s.cpus}</span>`);
    const usedMem = s.memory.total - s.memory.free;
    parts.push(`<span title="${esc(t('memory'))}">▦ <b>${fmtSize(usedMem)}</b>/${fmtSize(s.memory.total)}</span>`);
    if (s.disk) parts.push(`<span title="${esc(t('diskFree'))}">⛁ <b>${fmtSize(s.disk.free)}</b> ${esc(t('free'))}</span>`);
    $('stats').innerHTML = parts.join('');
    $('stats').title = [s.model, s.hostname, s.platform, `Node ${s.node}`].filter(Boolean).join(' · ');
  }

  const TYPE_LABEL = { static: 'HTML', node: 'Node.js', python: 'Python', react: 'React/Vue' };

  function statusBadge(a) {
    const map = {
      running: ['on', 'statusRunning'], stopped: ['off', 'statusStopped'], crashed: ['bad', 'statusCrashed'],
      deploying: ['busy', 'statusDeploying'], updating: ['busy', 'statusUpdating'], restoring: ['busy', 'statusRestoring'],
      restarting: ['busy', 'statusRestarting'], stopping: ['busy', 'statusStopping'],
    };
    const [cls, key] = map[a.status] || ['off', 'statusStopped'];
    return `<span class="badge ${cls}"><span class="dot"></span>${esc(t(key))}</span>`;
  }

  function renderApps() {
    const list = $('list');
    if (!list) return;
    const q = $('filter').value.trim().toLowerCase();
    const apps = state.apps.filter((a) => !q || a.name.toLowerCase().includes(q) || a.type.includes(q) || String(a.port).includes(q));
    $('cnt').textContent = `(${state.apps.length})`;
    if (!state.apps.length) {
      list.innerHTML = `<div class="empty"><div class="empty-i">📦</div><h3>${esc(t('noApps'))}</h3><p>${esc(t('noAppsDesc'))}</p></div>`;
      return;
    }
    list.innerHTML = apps.map((a) => {
      const on = a.status === 'running';
      const working = !!a.task;
      const db = a.dbType !== 'none' && a.dbInfo ? `<span class="tag">${a.dbType === 'sqlite' ? 'SQLite' : 'PostgreSQL'}: ${esc(a.dbInfo.name)}</span>` : '';
      const err = a.lastError ? `<div class="card-err">${esc(t('lastError'))} (${esc(a.lastError.task)}): ${esc(a.lastError.message)}</div>` : '';
      const btn = (act, label, extra = '') => `<button class="btn btn-s ${extra}" type="button" data-act="${act}" data-id="${esc(a.id)}"${working && act !== 'logs' ? ' disabled' : ''}>${label}</button>`;
      const power = on || a.status === 'restarting'
        ? btn('stop', `⏹ ${esc(t('stop'))}`) + btn('restart', '🔄', '')
        : btn('start', `▶ ${esc(t('start'))}`);
      return `<article class="card st-${esc(a.status)}${a.lastError ? ' has-error' : ''}">
        <div class="card-h"><div><div class="card-name">${esc(a.name)}</div><div class="card-ver">v${esc(a.version || 1)} · ${esc(t('port'))} ${esc(a.port)}</div></div>${statusBadge(a)}</div>
        <div class="meta"><span class="tag ${esc(a.type)}">${esc(TYPE_LABEL[a.type] || a.type)}</span>${db}${a.envKeys.length ? `<span class="tag">env: ${a.envKeys.length}</span>` : ''}${a.backupSchedule !== 'off' ? `<span class="tag">💾 ${esc(t(a.backupSchedule === 'daily' ? 'schedDaily' : 'schedWeekly'))}</span>` : ''}</div>
        <a class="card-url" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a>
        ${err}
        <div class="acts">${power}${btn('update', `📦 ${esc(t('update'))}`)}${btn('files', `📂 ${esc(t('files'))}`)}${btn('backups', `💾 ${esc(t('backups'))}`)}${a.dbInfo ? btn('db', '🗃️ DB') : ''}${btn('settings', `⚙ ${esc(t('settings'))}`)}${btn('logs', `📋 ${esc(t('logs'))}`)}${btn('delete', '🗑', 'btn-d')}</div>
      </article>`;
    }).join('') || `<div class="empty"><p>${esc(t('noMatch'))}</p></div>`;
  }

  $('filter').addEventListener('input', renderApps);

  $('list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const a = state.apps.find((x) => x.id === b.dataset.id);
    if (!a) return;
    const act = b.dataset.act;
    if (['start', 'stop', 'restart'].includes(act)) return power(a, act, b);
    ({ update: openUpdate, files: openFiles, backups: openBackups, db: openDb, settings: openSettings, logs: openLogs, delete: openDelete })[act](a);
  });

  async function power(a, act, b) {
    try {
      await busy(b, () => api('POST', `api/apps/${a.id}/${act}`));
      toast(t({ start: 'appStarted', stop: 'appStopped', restart: 'appRestarted' }[act]));
    } catch (err) { toast(err.message, 'err'); }
    refresh();
  }

  // ---------- ports ----------

  async function checkPort(inputId) {
    const info = $(`${inputId}Info`);
    const p = Number.parseInt($(inputId).value, 10);
    const [lo, hi] = state.system ? state.system.portRange : [3001, 3200];
    if (!p || p < lo || p > hi) { info.className = 'port-info no'; info.textContent = t('portRange', { lo, hi }); return; }
    info.className = 'port-info loading';
    info.textContent = t('checking');
    try {
      const ports = await api('GET', 'api/ports');
      const f = ports.find((x) => x.port === p);
      if (!f || f.available) { info.className = 'port-info ok'; info.textContent = t('portFree', { port: p }); } else if (f.usedBy === 'app') { info.className = 'port-info no'; info.textContent = t('portUsedApp', { port: p, name: f.appName }); } else { info.className = 'port-info no'; info.textContent = t('portUsedSys', { port: p }); }
    } catch (err) { info.className = 'port-info no'; info.textContent = err.message; }
  }
  document.querySelectorAll('[data-check-port]').forEach((b) => b.addEventListener('click', () => checkPort(b.dataset.checkPort)));

  // ---------- deploy ----------

  function wireDrop(zoneId, inputId, nameId) {
    const zone = $(zoneId);
    const input = $(inputId);
    input.addEventListener('change', () => { $(nameId).textContent = input.files[0] ? input.files[0].name : ''; });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('drag')));
  }
  wireDrop('dZone', 'dFile', 'dFn');
  wireDrop('uZone', 'uFile', 'uFn');

  $('deployBtn').addEventListener('click', () => {
    $('dForm').reset();
    $('dFn').textContent = '';
    $('dPortInfo').textContent = '';
    $('dDbNameWrap').hidden = true;
    $('dTypeHelp').innerHTML = t(`help_${$('dType').value}`);
    const [lo, hi] = state.system ? state.system.portRange : [3001, 3200];
    $('dPort').min = lo; $('dPort').max = hi;
    openM('dMod');
  });
  $('dDb').addEventListener('change', () => { $('dDbNameWrap').hidden = $('dDb').value === 'none'; });
  $('dType').addEventListener('change', () => { $('dTypeHelp').innerHTML = t(`help_${$('dType').value}`); });
  $('dPort').addEventListener('focus', async function onFocus() {
    if (this.value) return;
    try {
      const ports = await api('GET', 'api/ports');
      const free = ports.find((p) => p.available);
      if (free && !this.value) { this.value = free.port; $('dPortInfo').className = 'port-info ok'; $('dPortInfo').textContent = t('portSuggested', { port: free.port }); }
    } catch { /* ignore */ }
  });

  $('dForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('dName').value.trim();
    const f = $('dFile').files[0];
    if (!name) return toast(t('enterName'), 'err');
    if (!f) return toast(t('selectFileErr'), 'err');
    const fd = new FormData();
    fd.append('name', name);
    fd.append('type', $('dType').value);
    fd.append('dbType', $('dDb').value);
    if ($('dPort').value) fd.append('port', $('dPort').value);
    if ($('dDbName').value.trim()) fd.append('dbName', $('dDbName').value.trim());
    fd.append('zipfile', f);
    try {
      const r = await busy($('dBtn'), () => api('POST', 'api/apps', fd, true));
      toast(t('deployStarted', { name }));
      closeM('dMod');
      refresh();
      openLogs(r);
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- update ----------

  function openUpdate(a) {
    state.cur.update = a.id;
    $('uForm').reset();
    $('uName').textContent = a.name;
    $('uFn').textContent = '';
    $('uPort').placeholder = t('currentPort', { port: a.port });
    $('uPortInfo').textContent = '';
    openM('uMod');
  }

  $('uForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = $('uFile').files[0];
    const p = $('uPort').value;
    if (!f && !p) return toast(t('nothingToUpdate'), 'err');
    const fd = new FormData();
    if (p) fd.append('port', p);
    if (f) fd.append('zipfile', f);
    const id = state.cur.update;
    try {
      const r = await busy($('uBtn'), () => api('PUT', `api/apps/${id}`, fd, true));
      toast(f ? t('updateStarted') : t('appUpdated'));
      closeM('uMod');
      refresh();
      if (f) openLogs(r);
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- delete ----------

  function openDelete(a) {
    state.cur.del = a;
    $('xDesc').innerHTML = t('deleteDesc', { name: `<strong>${esc(a.name)}</strong>` });
    $('xConfirmLabel').textContent = t('typeToConfirm', { name: a.id });
    $('xConfirm').value = '';
    $('xBtn').disabled = true;
    openM('xMod');
  }
  $('xConfirm').addEventListener('input', () => { $('xBtn').disabled = $('xConfirm').value.trim() !== (state.cur.del && state.cur.del.id); });
  $('xForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = state.cur.del;
    try {
      await busy($('xBtn'), () => api('DELETE', `api/apps/${a.id}`));
      toast(t('appDeleted'));
      closeM('xMod');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- logs ----------

  function openLogs(a) {
    state.cur.logs = a.id;
    $('lName').textContent = a.name;
    $('lC').textContent = t('loading');
    openM('lMod');
    loadLogs(true);
    clearInterval(state.logTimer);
    state.logTimer = setInterval(() => { if ($('lAuto').checked) loadLogs(false); }, 2500);
  }

  async function loadLogs(scroll) {
    const el = $('lC');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    try {
      const r = await api('GET', `api/apps/${state.cur.logs}/logs`);
      el.textContent = r.logs || t('noLogs');
      if (scroll || atBottom) el.scrollTop = el.scrollHeight;
    } catch (err) { el.textContent = err.message; }
  }
  $('lRefresh').addEventListener('click', () => loadLogs(true));
  $('lClear').addEventListener('click', async () => {
    if (!confirm(t('clearLogsConfirm'))) return;
    try { await api('DELETE', `api/apps/${state.cur.logs}/logs`); loadLogs(true); } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- backups ----------

  function openBackups(a) {
    state.cur.backups = a.id;
    $('bName').textContent = a.name;
    openM('bMod');
    loadBackups();
  }

  async function loadBackups() {
    const el = $('bList');
    el.innerHTML = `<div class="placeholder">${esc(t('loading'))}</div>`;
    try {
      const r = await api('GET', `api/apps/${state.cur.backups}/backups`);
      $('bSched').value = r.schedule || 'off';
      if (!r.backups.length) { el.innerHTML = `<div class="placeholder">${esc(t('noBackups'))}</div>`; return; }
      el.innerHTML = r.backups.map((b) => `<div class="bk-item">
        <div><div class="bk-date">${esc(fmtDate(b.date))}</div><div class="bk-size">${fmtSize(b.size)}</div></div>
        <div class="bk-acts">
          <a class="btn btn-s" href="api/apps/${encodeURIComponent(state.cur.backups)}/backups/${encodeURIComponent(b.filename)}/download" title="${esc(t('download'))}" aria-label="${esc(t('download'))}">⬇</a>
          <button class="btn btn-s" type="button" data-bk="restore" data-fn="${esc(b.filename)}" title="${esc(t('restore'))}" aria-label="${esc(t('restore'))}">♻️</button>
          <button class="btn btn-s btn-d" type="button" data-bk="delete" data-fn="${esc(b.filename)}" title="${esc(t('delete'))}" aria-label="${esc(t('delete'))}">🗑</button>
        </div></div>`).join('');
    } catch (err) { el.innerHTML = `<div class="placeholder">${esc(err.message)}</div>`; }
  }

  $('bList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-bk]');
    if (!b) return;
    const id = state.cur.backups;
    const fn = b.dataset.fn;
    try {
      if (b.dataset.bk === 'restore') {
        if (!confirm(t('restoreConfirm'))) return;
        await api('POST', `api/apps/${id}/backups/${fn}/restore`);
        toast(t('restoreStarted'));
        closeM('bMod');
        refresh();
        const a = state.apps.find((x) => x.id === id);
        if (a) openLogs(a);
      } else {
        if (!confirm(t('deleteBackupConfirm'))) return;
        await api('DELETE', `api/apps/${id}/backups/${fn}`);
        toast(t('backupDeleted'));
        loadBackups();
      }
    } catch (err) { toast(err.message, 'err'); }
  });

  $('bkBtn').addEventListener('click', async () => {
    try {
      await busy($('bkBtn'), () => api('POST', `api/apps/${state.cur.backups}/backups`));
      toast(t('backupCreated'));
      loadBackups();
    } catch (err) { toast(err.message, 'err'); }
  });

  $('bSchedBtn').addEventListener('click', async () => {
    try {
      await api('PUT', `api/apps/${state.cur.backups}/backups/schedule`, { schedule: $('bSched').value });
      toast(t('scheduleSet'));
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- database ----------

  async function openDb(a) {
    state.cur.db = a.id;
    $('dbApp').textContent = a.name;
    $('dbNew').value = '';
    $('dbInfo').innerHTML = `<dt>${esc(t('loading'))}</dt><dd></dd>`;
    openM('dbMod');
    try {
      const d = await api('GET', `api/apps/${a.id}/db`);
      const rows = [[t('type'), d.type], [t('nameLabel'), d.name]];
      if (d.type === 'sqlite') rows.push([t('path'), d.path]);
      if (d.user) rows.push([t('user'), d.user]);
      rows.push(['DATABASE_URL', d.url]);
      $('dbInfo').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd><code>${esc(v)}</code></dd>`).join('');
    } catch (err) { $('dbInfo').innerHTML = `<dt>${esc(err.message)}</dt><dd></dd>`; }
  }

  $('dbForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = $('dbNew').value.trim();
    if (!n) return toast(t('enterName'), 'err');
    try {
      await busy($('dbBtn'), () => api('PUT', `api/apps/${state.cur.db}/db`, { newName: n }));
      toast(t('dbRenamed'));
      const a = state.apps.find((x) => x.id === state.cur.db);
      if (a) openDb(a);
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- settings (env vars, start command) ----------

  async function openSettings(a) {
    state.cur.settings = a.id;
    $('sName').textContent = a.name;
    $('sEnv').value = '';
    $('sCmd').value = '';
    // Keep the form read-only until the current values have arrived.
    const lock = (on) => { $('sEnv').readOnly = on; $('sCmd').readOnly = on; $('sBtn').disabled = on; };
    lock(true);
    openM('sMod');
    try {
      const s = await api('GET', `api/apps/${a.id}/settings`);
      $('sEnv').value = Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n');
      $('sCmd').value = s.startCommand || '';
      lock(false);
    } catch (err) { toast(err.message, 'err'); }
  }

  function parseEnv(text) {
    const env = {};
    text.split('\n').forEach((line, i) => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return;
      const eq = l.indexOf('=');
      if (eq < 1) throw new Error(t('envLineError', { line: i + 1 }));
      let v = l.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[l.slice(0, eq).trim()] = v;
    });
    return env;
  }

  $('sForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const env = parseEnv($('sEnv').value);
      await busy($('sBtn'), () => api('PUT', `api/apps/${state.cur.settings}/settings`, { env, startCommand: $('sCmd').value }));
      toast(t('settingsSaved'));
      closeM('sMod');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- file manager ----------

  const ICONS = { html: '🌐', htm: '🌐', css: '🎨', js: '⚡', mjs: '⚡', cjs: '⚡', jsx: '⚛️', tsx: '⚛️', ts: '📘', json: '📋', md: '📝', txt: '📄', py: '🐍', xml: '📰', svg: '🖼️', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', ico: '🖼️', yml: '⚙️', yaml: '⚙️', toml: '⚙️', sh: '🔧', sql: '🗃️', db: '🗃️', csv: '📊', env: '🔐' };
  const MODES = { html: 'htmlmixed', htm: 'htmlmixed', css: 'css', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'text/typescript', tsx: 'text/typescript', json: { name: 'javascript', json: true }, py: 'python', md: 'markdown', xml: 'xml', svg: 'xml', sql: 'sql', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', dockerfile: 'dockerfile' };

  function extOf(p) {
    const base = p.split('/').pop().toLowerCase();
    if (base === 'dockerfile') return 'dockerfile';
    return base.includes('.') ? base.split('.').pop() : '';
  }

  function openFiles(a) {
    state.cur.files = a.id;
    state.file = null;
    state.dirty = false;
    $('eApp').textContent = a.name;
    $('eTb').hidden = true;
    $('ec').hidden = true;
    $('eE').hidden = false;
    $('eSt').hidden = true;
    $('nfP').value = '';
    openM('eMod');
    loadTree();
  }

  async function loadTree() {
    const el = $('fTree');
    el.innerHTML = `<div class="placeholder">${esc(t('loading'))}</div>`;
    try {
      const r = await api('GET', `api/apps/${state.cur.files}/files`);
      el.innerHTML = r.files.length ? renderTree(r.files, 0) : `<div class="placeholder">${esc(t('noFiles'))}</div>`;
    } catch (err) { el.innerHTML = `<div class="placeholder">${esc(err.message)}</div>`; }
  }

  function renderTree(items, depth) {
    const pad = 10 + depth * 12;
    return items.map((i) => {
      if (i.type === 'dir') {
        return `<button type="button" class="ft-d" style="padding-left:${pad}px" data-dir="${esc(i.path)}"><span class="ar">▾</span>📁 ${esc(i.name)}</button><div class="ft-ch">${renderTree(i.children || [], depth + 1)}</div>`;
      }
      const act = state.file && state.file.path === i.path ? ' act' : '';
      return `<button type="button" class="ft-i${act}" style="padding-left:${pad}px" data-file="${esc(i.path)}" title="${esc(i.path)} · ${fmtSize(i.size)}"><span>${ICONS[i.ext] || '📄'}</span>${esc(i.name)}</button>`;
    }).join('');
  }

  $('fTree').addEventListener('click', (e) => {
    const d = e.target.closest('[data-dir]');
    if (d) { d.classList.toggle('cl'); $('nfP').value = `${d.dataset.dir}/`; return; }
    const f = e.target.closest('[data-file]');
    if (f) openFile(f.dataset.file);
  });

  async function openFile(fp) {
    if (state.dirty && (!state.file || state.file.path !== fp) && !confirm(t('unsavedWarn'))) return;
    const ext = extOf(fp);
    state.dirty = false;
    $('eTb').hidden = false;
    $('ec').hidden = false;
    $('eE').hidden = true;
    $('eSt').hidden = false;
    $('eFn').textContent = fp;
    $('eUn').innerHTML = '';
    $('eLn').textContent = ext || 'txt';
    $('eS').disabled = true;
    $('eSs').textContent = '';
    $('eDl').href = `api/apps/${encodeURIComponent(state.cur.files)}/files/${encPath(fp)}?download=1`;
    document.querySelectorAll('#fTree .ft-i').forEach((b) => b.classList.toggle('act', b.dataset.file === fp));
    try {
      const r = await api('GET', `api/apps/${state.cur.files}/files/${encPath(fp)}`);
      if (r.content == null) {
        destroyCM();
        state.file = { path: fp, mtime: null, orig: null };
        $('ec').innerHTML = `<div class="msg">${esc(r.tooLarge ? t('fileTooLarge') : t('binaryFile'))} · ${fmtSize(r.size)}</div>`;
        $('eFi').textContent = fmtSize(r.size);
        return;
      }
      state.file = { path: fp, mtime: r.mtime, orig: r.content };
      $('eFi').textContent = `${(ext || 'txt').toUpperCase()} · ${fmtSize(r.size)}`;
      setupCM(r.content, ext);
    } catch (err) {
      $('ec').innerHTML = `<div class="msg">${esc(err.message)}</div>`;
    }
  }

  function setupCM(content, ext) {
    const c = $('ec');
    destroyCM();
    c.innerHTML = '';
    if (!window.CodeMirror) {
      c.innerHTML = `<div class="msg">${esc(t('editorMissing'))}</div>`;
      return;
    }
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    state.cm = window.CodeMirror(c, {
      value: content,
      mode: MODES[ext] || 'text/plain',
      theme: dark ? 'material-darker' : 'default',
      lineNumbers: true,
      lineWrapping: true,
      matchBrackets: true,
      matchTags: { bothTags: true },
      autoCloseBrackets: true,
      autoCloseTags: true,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      styleActiveLine: true,
      indentUnit: ext === 'py' ? 4 : 2,
      tabSize: ext === 'py' ? 4 : 2,
      indentWithTabs: false,
      extraKeys: {
        'Ctrl-S': () => saveFile(), 'Cmd-S': () => saveFile(),
        'Ctrl-/': 'toggleComment', 'Cmd-/': 'toggleComment',
        'Ctrl-Space': 'autocomplete', 'Ctrl-J': 'toMatchingTag',
        Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection(' '.repeat(cm.getOption('indentUnit')), 'end')),
        'Shift-Tab': (cm) => cm.indentSelection('subtract'),
      },
    });
    state.cm.on('change', () => {
      state.dirty = state.cm.getValue() !== state.file.orig;
      $('eS').disabled = !state.dirty;
      $('eSs').textContent = state.dirty ? t('unsaved') : '';
      $('eUn').innerHTML = state.dirty ? '<span class="ud"></span>' : '';
    });
    state.cm.on('cursorActivity', () => {
      const p = state.cm.getCursor();
      $('eCu').textContent = `Ln ${p.line + 1}, Col ${p.ch + 1}`;
    });
    setTimeout(() => { state.cm.refresh(); state.cm.focus(); }, 30);
  }

  function destroyCM() {
    state.cm = null;
    $('ec').innerHTML = '';
  }

  async function saveFile() {
    if (!state.file || !state.cm || !state.dirty || state.saving) return;
    const content = state.cm.getValue();
    state.saving = true;
    try {
      const r = await busy($('eS'), () => api('PUT', `api/apps/${state.cur.files}/files/${encPath(state.file.path)}`, { content, mtime: state.file.mtime }));
      state.file.orig = content;
      state.file.mtime = r.mtime;
      state.dirty = false;
      $('eS').disabled = true;
      $('eSs').textContent = t('saved');
      $('eUn').innerHTML = '';
      toast(t('fileSaved'));
    } catch (err) { toast(err.message, 'err'); } finally { state.saving = false; }
  }
  $('eS').addEventListener('click', saveFile);

  $('eDel').addEventListener('click', async () => {
    if (!state.file || !confirm(t('deleteFile', { path: state.file.path }))) return;
    try {
      await api('DELETE', `api/apps/${state.cur.files}/files/${encPath(state.file.path)}`);
      toast(t('fileDeleted'));
      state.file = null;
      state.dirty = false;
      destroyCM();
      $('eTb').hidden = true; $('ec').hidden = true; $('eE').hidden = false; $('eSt').hidden = true;
      loadTree();
    } catch (err) { toast(err.message, 'err'); }
  });

  async function newFile() {
    const fp = $('nfP').value.trim();
    if (!fp) return toast(t('enterFileName'), 'err');
    try {
      await api('POST', `api/apps/${state.cur.files}/files`, { filePath: fp, content: '' });
      toast(t('fileCreated'));
      $('nfP').value = '';
      await loadTree();
      if (!fp.endsWith('/')) openFile(fp);
    } catch (err) { toast(err.message, 'err'); }
  }
  $('nfBtn').addEventListener('click', newFile);
  $('nfP').addEventListener('keydown', (e) => { if (e.key === 'Enter') newFile(); });

  $('upFile').addEventListener('change', async () => {
    const f = $('upFile').files[0];
    if (!f) return;
    const dir = $('nfP').value.trim().replace(/\/+$/, '');
    const fd = new FormData();
    if (dir) fd.append('dir', dir);
    fd.append('file', f);
    try {
      const r = await api('POST', `api/apps/${state.cur.files}/upload`, fd, true);
      toast(t('fileUploaded', { path: r.path }));
      loadTree();
    } catch (err) { toast(err.message, 'err'); }
    $('upFile').value = '';
  });

  // ---------- global wiring ----------

  document.querySelectorAll('.ov').forEach((o) => {
    o.addEventListener('mousedown', (e) => { if (e.target === o) closeM(o.id); });
    o.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeM(o.id)));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = [...document.querySelectorAll('.ov.on')].pop();
      if (open) closeM(open.id);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's' && $('eMod').classList.contains('on') && !e.defaultPrevented) {
      e.preventDefault();
      saveFile();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('panel').hidden) refresh(); });

  initTheme();
  initLangs();
  applyI18n();
  boot();
})();
