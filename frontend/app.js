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
    logStream: null,
    me: null,
    runtimes: {},
    templates: [],
    src: 'upload',
  };
  const isAdmin = () => state.me && state.me.role === 'admin';
  const canOperate = () => state.me && state.me.role !== 'viewer';

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
    el.textContent = msg;
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
    if (id === 'lMod') stopLogStream();
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
    $('logoutBtn').hidden = !st.authRequired;
    state.me = st.user;
    document.body.dataset.role = st.user ? st.user.role : '';
    if (st.authenticated) showPanel(); else showLogin();
  }

  function showLogin() {
    clearTimeout(state.timer);
    document.querySelectorAll('.ov.on').forEach((o) => o.classList.remove('on'));
    $('panel').hidden = true;
    $('login').hidden = false;
    $('loginPw').value = '';
    $('loginCode').value = '';
    $('loginCodeWrap').hidden = true;
    $('loginPw').focus();
  }

  function showPanel() {
    $('login').hidden = true;
    $('panel').hidden = false;
    refresh();
    api('GET', 'api/runtimes').then((r) => { state.runtimes = r; }).catch(() => {});
    if (window.Pi.onPanel) window.Pi.onPanel();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try {
      const res = await fetch('api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-PiPaaS': '1' },
        body: JSON.stringify({ username: $('loginUser').value.trim().toLowerCase(), password: $('loginPw').value, code: $('loginCode').value.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.needCode) {
          $('loginCodeWrap').hidden = false;
          $('loginCode').focus();
        }
        $('loginErr').textContent = data.error || `HTTP ${res.status}`;
        return;
      }
      boot();
    } catch (err) { $('loginErr').textContent = err.message; }
  });

  $('logoutBtn').addEventListener('click', async () => {
    try { await api('POST', 'api/auth/logout'); } catch { /* ignore */ }
    showLogin();
  });

  const openPw = () => { $('pForm').reset(); openM('pMod'); };
  $('setBtn').addEventListener('click', () => window.Pi.openPanelSettings());
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
      // Probing ports for other processes binds every port in the range: keep it rare.
      if (!state.portsAt || Date.now() - state.portsAt > 60000) {
        state.portsAt = Date.now();
        api('GET', 'api/ports').then((p) => { state.ports = p; renderPins(); }).catch(() => {});
      }
      renderApps();
      renderStats();
      renderPins();
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
    const item = (label, value, title, cls = '') => `<div class="stat ${cls}" title="${esc(title)}"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    const parts = [];
    if (s.temperature != null) {
      const cls = s.temperature >= 75 ? 'burn' : s.temperature >= 65 ? 'hot' : '';
      parts.push(item(t('sTemp'), `${s.temperature.toFixed(0)}&nbsp;°C`, t('cpuTemp'), cls));
    }
    parts.push(item(t('sLoad'), `${s.load[0].toFixed(2)}<small>/${s.cpus}</small>`, t('load')));
    parts.push(item(t('sMem'), `${fmtSize(s.memory.total - s.memory.free)}<small>/${fmtSize(s.memory.total)}</small>`, t('memory')));
    if (s.disk) parts.push(item(t('sDisk'), fmtSize(s.disk.free), t('diskFree')));
    $('stats').innerHTML = parts.join('');
    $('stats').title = [s.model, s.hostname, s.platform, `Node ${s.node}`].filter(Boolean).join(', ');
  }

  const TYPE_LABEL = { static: 'HTML', node: 'Node.js', python: 'Python', react: 'React/Vue', php: 'PHP', deno: 'Deno', bun: 'Bun', binary: 'Binary', docker: 'Docker' };
  const BUSY = ['deploying', 'updating', 'restoring', 'restarting', 'stopping'];
  const STATUS_KEY = {
    running: 'statusRunning', stopped: 'statusStopped', crashed: 'statusCrashed', deploying: 'statusDeploying', updating: 'statusUpdating',
    restoring: 'statusRestoring', restarting: 'statusRestarting', stopping: 'statusStopping',
  };
  const pinClass = (status) => (BUSY.includes(status) ? 's-busy' : `s-${status in STATUS_KEY ? status : 'stopped'}`);

  /** The port range drawn as a pin header: one pin per port, lit by the app on it. */
  function renderPins() {
    const el = $('pins');
    if (!el) return;
    const [lo, hi] = state.system ? state.system.portRange : [3001, 3200];
    const byPort = new Map(state.apps.map((a) => [a.port, a]));
    const other = new Set((state.ports || []).filter((p) => p.usedBy === 'system').map((p) => p.port));
    const cols = Math.min(50, Math.ceil((hi - lo + 1) / 4));
    el.style.setProperty('--cols', cols);
    let html = '';
    for (let p = lo; p <= hi; p++) {
      const a = byPort.get(p);
      if (a) {
        html += `<button type="button" role="listitem" class="pin ${pinClass(a.status)}" data-goto="${esc(a.id)}" title="${p}: ${esc(a.name)} (${esc(t(STATUS_KEY[a.status] || 'statusStopped'))})" aria-label="${p}: ${esc(a.name)}"></button>`;
      } else if (other.has(p)) {
        html += `<i role="listitem" class="pin s-system" title="${p}: ${esc(t('portOther'))}"></i>`;
      } else {
        html += `<i role="listitem" class="pin" title="${p}"></i>`;
      }
    }
    el.innerHTML = html;
    const used = state.apps.length + other.size;
    $('pinsSum').textContent = t('portsInUse', { used, total: hi - lo + 1, lo, hi });
  }

  $('pins').addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (!b) return;
    const row = document.querySelector(`.app[data-id="${CSS.escape(b.dataset.goto)}"]`);
    if (!row) return;
    $('filter').value = '';
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1200);
  });

  function renderApps() {
    const list = $('list');
    if (!list) return;
    const q = $('filter').value.trim().toLowerCase();
    const apps = state.apps.filter((a) => !q || a.name.toLowerCase().includes(q) || a.type.includes(q) || String(a.port).includes(q));
    $('cnt').textContent = state.apps.length ? String(state.apps.length) : '';
    if (!state.apps.length) {
      list.innerHTML = `<div class="empty"><h3>${esc(t('noApps'))}</h3><p>${esc(t('noAppsDesc'))}</p>${canOperate() ? `<button class="btn primary" type="button" data-act="deploy-empty">${esc(t('deployApp'))}</button>` : ''}</div>`;
      return;
    }
    list.innerHTML = apps.map((a) => {
      const working = !!a.task;
      const on = a.status === 'running' || a.status === 'restarting';
      const dis = working ? ' disabled' : '';
      const id = esc(a.id);
      const m = a.metrics || {};
      const unhealthy = on && m.health && m.health.ok === false;
      const db = a.dbType !== 'none' && a.dbInfo ? `<span>${a.dbType === 'sqlite' ? 'SQLite' : 'PostgreSQL'}</span>` : '';
      const src = a.source && a.source.type === 'git' ? `<span title="${esc(a.source.url || '')}">git ${esc(a.source.branch || '')}${a.source.commit ? ` ${esc(a.source.commit.slice(0, 7))}` : ''}</span>` : '';
      const extras = [
        src,
        db,
        a.envKeys.length ? `<span>${esc(t('envCount', { n: a.envKeys.length }))}</span>` : '',
        a.jobs ? `<span>${esc(t('jobCount', { n: a.jobs }))}</span>` : '',
        a.backupSchedule !== 'off' ? `<span>${esc(t(a.backupSchedule === 'daily' ? 'schedDaily' : 'schedWeekly'))}</span>` : '',
      ].join('');
      const err = a.lastError ? `<p class="app-err"><strong>${esc(t('lastError'))}</strong> ${esc(a.lastError.message)}</p>` : '';
      const usage = on && (m.cpu != null || m.mem != null)
        ? `<button type="button" class="usage" data-act="metrics" data-id="${id}" title="${esc(t('metricsTitle'))}">${m.cpu != null ? `<span>${esc(m.cpu.toFixed(m.cpu < 10 ? 1 : 0))}% CPU</span>` : ''}${m.mem != null ? `<span>${esc(fmtSize(m.mem))}</span>` : ''}</button>`
        : '';
      const link = (a.links && a.links[0]) || a.url;
      const linkText = link.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const item = (act, label, cls = '') => `<button type="button" role="menuitem" class="${cls}" data-act="${act}" data-id="${id}"${working && !['logs', 'metrics', 'releases', 'jobs'].includes(act) ? ' disabled' : ''}>${esc(label)}</button>`;
      const op = canOperate();
      const menu = [
        op && on ? item('restart', t('restart')) : '',
        op ? item('update', t('update')) : '',
        op && a.source && a.source.type === 'git' ? item('pull', t('pullNow')) : '',
        op ? item('releases', t('releasesTitle')) : '',
        item('metrics', t('metricsTitle')),
        op ? item('files', t('files')) : '',
        op ? item('settings', t('settings')) : '',
        op ? item('jobs', t('jobsTitle')) : '',
        op ? item('backups', t('backups')) : '',
        op && a.dbInfo ? item('db', t('database')) : '',
        isAdmin() ? `<hr>${item('delete', t('delete'), 'danger')}` : '',
      ].join('');
      return `<article class="app ${pinClass(a.status)}${unhealthy ? ' unhealthy' : ''}" role="listitem" data-id="${id}">
        <div class="app-state"><i class="led"></i><span>${esc(unhealthy ? t('notResponding') : t(STATUS_KEY[a.status] || 'statusStopped'))}</span>${usage}</div>
        <div class="app-main">
          <h3 class="app-name">${esc(a.name)}</h3>
          <p class="app-meta"><span>${esc(TYPE_LABEL[a.type] || a.type)}</span><span>v${esc(a.version || 1)}</span>${extras}</p>
          ${err}
        </div>
        <div class="app-port"><span class="port-num">${esc(a.port)}</span><a href="${esc(link)}" target="_blank" rel="noopener" title="${esc(link)}">${esc(linkText.length > 28 ? t('open') : linkText)}</a></div>
        <div class="app-actions">
          ${op ? (on ? `<button class="btn" type="button" data-act="stop" data-id="${id}"${dis}>${esc(t('stop'))}</button>` : `<button class="btn primary" type="button" data-act="start" data-id="${id}"${dis}>${esc(t('start'))}</button>`) : ''}
          <button class="btn" type="button" data-act="logs" data-id="${id}">${esc(t('logs'))}</button>
          <div class="menu">
            <button class="btn" type="button" data-menu aria-haspopup="menu" aria-expanded="false">${esc(t('more'))}</button>
            <div class="menu-list" role="menu" hidden>${menu}</div>
          </div>
        </div>
      </article>`;
    }).join('') || `<div class="empty"><p>${esc(t('noMatch'))}</p></div>`;
  }

  $('filter').addEventListener('input', renderApps);

  function closeMenus(except) {
    document.querySelectorAll('.menu-list:not([hidden])').forEach((m) => {
      if (m === except) return;
      m.hidden = true;
      m.previousElementSibling.setAttribute('aria-expanded', 'false');
    });
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });

  $('list').addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-menu]');
    if (toggle) {
      const m = toggle.nextElementSibling;
      closeMenus(m);
      m.hidden = !m.hidden;
      toggle.setAttribute('aria-expanded', String(!m.hidden));
      if (!m.hidden) m.querySelector('button:not([disabled])')?.focus();
      return;
    }
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'deploy-empty') return $('deployBtn').click();
    closeMenus();
    const a = state.apps.find((x) => x.id === b.dataset.id);
    if (!a) return;
    const act = b.dataset.act;
    if (['start', 'stop', 'restart'].includes(act)) return power(a, act, b);
    if (act === 'pull') return pull(a, b);
    const fn = { update: openUpdate, files: openFiles, backups: openBackups, db: openDb, settings: openSettings, logs: openLogs, delete: openDelete, ...window.Pi.actions }[act];
    if (fn) fn(a);
  });

  $('list').addEventListener('keydown', (e) => {
    const m = e.target.closest('.menu-list');
    if (!m) return;
    const items = [...m.querySelectorAll('button:not([disabled])')];
    const i = items.indexOf(e.target);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); closeMenus(); m.previousElementSibling.focus(); }
  });

  // Drop a .zip or .html anywhere on the panel to start a deploy with it.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if ($('panel').hidden || document.querySelector('.ov.on') || !hasFiles(e)) return;
    dragDepth += 1;
    $('dropzone').hidden = false;
  });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropzone').hidden = true; });
  window.addEventListener('dragover', (e) => { if (!$('dropzone').hidden) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if ($('dropzone').hidden) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').hidden = true;
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.(zip|html?)$/i.test(f.name)) return toast(t('selectFileErr'), 'err');
    $('deployBtn').click();
    const dt = new DataTransfer();
    dt.items.add(f);
    $('dFile').files = dt.files;
    $('dFn').textContent = f.name;
    $('dName').value = f.name.replace(/\.(zip|html?)$/i, '').replace(/[-_.]+/g, ' ').trim();
    if (/\.html?$/i.test(f.name)) $('dType').value = 'static';
    $('dTypeHelp').innerHTML = t(`help_${$('dType').value}`);
  });

  async function pull(a, b) {
    try {
      await busy(b, () => api('POST', `api/apps/${a.id}/pull`));
      toast(t('pullStarted'));
      refresh();
      openLogs(a);
    } catch (err) { toast(err.message, 'err'); }
  }

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

  function setSource(src) {
    state.src = src;
    document.querySelectorAll('#dSrc [data-src]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.src === src)));
    $('dUpload').hidden = src !== 'upload';
    $('dGit').hidden = src !== 'git';
    $('dTemplates').hidden = src !== 'template';
    // A template brings its own type; name stays editable.
    $('dType').closest('.fg').hidden = src === 'template';
    if (src === 'template') renderTemplates();
  }
  document.querySelectorAll('#dSrc [data-src]').forEach((b) => b.addEventListener('click', () => setSource(b.dataset.src)));

  async function renderTemplates() {
    const el = $('dTemplates');
    if (!state.templates.length) {
      try { state.templates = await api('GET', 'api/templates'); } catch (err) { el.textContent = err.message; return; }
    }
    el.innerHTML = state.templates.map((tp) => {
      const ok = state.runtimes[tp.type] !== false;
      return `<label class="tpl${ok ? '' : ' off'}"><input type="radio" name="tpl" value="${esc(tp.id)}"${ok ? '' : ' disabled'}>
        <strong>${esc(tp.name)}</strong><span class="tpl-type">${esc(TYPE_LABEL[tp.type] || tp.type)}${tp.db ? ' + SQLite' : ''}</span>
        <span class="tpl-desc">${esc(ok ? tp.description : t('runtimeMissing', { type: TYPE_LABEL[tp.type] || tp.type }))}</span></label>`;
    }).join('');
  }
  $('dTemplates').addEventListener('change', (e) => {
    const tp = state.templates.find((x) => x.id === e.target.value);
    if (tp && !$('dName').value.trim()) $('dName').value = tp.name;
  });

  function markRuntimes() {
    for (const o of $('dType').options) {
      const ok = state.runtimes[o.value] !== false;
      o.disabled = !ok;
      o.textContent = t(`type_${o.value}`) + (ok ? '' : ` (${t('notInstalled')})`);
    }
  }

  $('deployBtn').addEventListener('click', () => {
    $('dForm').reset();
    $('dFn').textContent = '';
    $('dPortInfo').textContent = '';
    $('dDbNameWrap').hidden = true;
    markRuntimes();
    setSource('upload');
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
    const tpl = document.querySelector('#dTemplates input:checked');
    if (!name && state.src !== 'template') return toast(t('enterName'), 'err');
    if (state.src === 'upload' && !f) return toast(t('selectFileErr'), 'err');
    if (state.src === 'git' && !$('dGitUrl').value.trim()) return toast(t('gitUrlMissing'), 'err');
    if (state.src === 'template' && !tpl) return toast(t('chooseTemplate'), 'err');
    const fd = new FormData();
    if (name) fd.append('name', name);
    if (state.src !== 'template') fd.append('type', $('dType').value);
    if ($('dDb').value !== 'none' || state.src !== 'template') fd.append('dbType', $('dDb').value);
    if ($('dPort').value) fd.append('port', $('dPort').value);
    if ($('dDbName').value.trim()) fd.append('dbName', $('dDbName').value.trim());
    if (state.src === 'upload') fd.append('zipfile', f);
    if (state.src === 'git') {
      fd.append('gitUrl', $('dGitUrl').value.trim());
      fd.append('gitBranch', $('dGitBranch').value.trim() || 'main');
      if ($('dGitSubdir').value.trim()) fd.append('gitSubdir', $('dGitSubdir').value.trim());
      if ($('dGitToken').value) fd.append('gitToken', $('dGitToken').value);
    }
    if (state.src === 'template') fd.append('template', tpl.value);
    try {
      const r = await busy($('dBtn'), () => api('POST', 'api/apps', fd, true));
      toast(t('deployStarted', { name: r.name }));
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

  const MAX_LOG_CHARS = 400000;

  function stopLogStream() {
    if (state.logStream) state.logStream.close();
    state.logStream = null;
    $('lLive').classList.remove('on');
  }

  function openLogs(a) {
    state.cur.logs = a.id;
    $('lName').textContent = a.name;
    $('lC').textContent = t('loading');
    $('lSearch').value = '';
    openM('lMod');
    startLogStream();
  }

  /** Live log through Server-Sent Events; the browser reconnects by itself. */
  function startLogStream() {
    stopLogStream();
    const el = $('lC');
    el.textContent = '';
    const es = new EventSource(`api/apps/${encodeURIComponent(state.cur.logs)}/logs/stream`);
    state.logStream = es;
    es.addEventListener('open', () => $('lLive').classList.add('on'));
    es.addEventListener('error', () => $('lLive').classList.remove('on'));
    es.addEventListener('reset', () => { el.textContent = ''; });
    es.addEventListener('log', (ev) => {
      if ($('lSearch').value.trim()) return; // showing search results
      const { text } = JSON.parse(ev.data);
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      el.textContent = (el.textContent + text).slice(-MAX_LOG_CHARS);
      if (!el.textContent) el.textContent = '';
      if ($('lAuto').checked && atBottom) el.scrollTop = el.scrollHeight;
    });
  }

  async function loadLogs() {
    if ($('lSearch').value.trim()) return searchLogs();
    startLogStream();
  }

  let searchTimer = null;
  async function searchLogs() {
    const q = $('lSearch').value.trim();
    const el = $('lC');
    if (!q) return startLogStream();
    try {
      const r = await api('GET', `api/apps/${state.cur.logs}/logs/search?q=${encodeURIComponent(q)}`);
      el.textContent = r.matches.length
        ? `${t('searchResults', { n: r.total })}${r.truncated ? ` ${t('searchTruncated', { n: r.matches.length })}` : ''}\n\n${r.matches.map((m) => `${m.file === 'previous' ? '↶ ' : ''}${m.line}: ${m.text}`).join('\n')}`
        : t('noMatches');
      el.scrollTop = el.scrollHeight;
    } catch (err) { el.textContent = err.message; }
  }
  $('lSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchLogs, 300); });

  $('lRefresh').addEventListener('click', () => loadLogs(true));
  $('lClear').addEventListener('click', async () => {
    if (!confirm(t('clearLogsConfirm'))) return;
    try { await api('DELETE', `api/apps/${state.cur.logs}/logs`); $('lC').textContent = ''; } catch (err) { toast(err.message, 'err'); }
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
      el.innerHTML = r.backups.map((b) => {
        const v = b.verified;
        const o = b.offsite;
        const marks = [
          v ? `<span class="tagline ${v.ok ? 'good' : 'bad'}" title="${esc(v.error || '')}">${esc(v.ok ? t('verified') : t('verifyFailed'))}</span>` : '',
          o ? `<span class="tagline ${o.ok ? 'good' : 'bad'}" title="${esc(o.error || '')}">${esc(o.ok ? t(o.encrypted ? 'offsiteEncrypted' : 'offsiteOk') : t('offsiteFailed'))}</span>` : '',
        ].join('');
        return `<div class="bk-item">
        <div><div class="bk-date">${esc(fmtDate(b.date))}</div><div class="bk-size">${fmtSize(b.size)} ${marks}</div></div>
        <div class="bk-acts">
          <button class="btn btn-s" type="button" data-bk="verify" data-fn="${esc(b.filename)}">${esc(t('verify'))}</button>
          <a class="btn btn-s" href="api/apps/${encodeURIComponent(state.cur.backups)}/backups/${encodeURIComponent(b.filename)}/download" >${esc(t('download'))}</a>
          <button class="btn btn-s" type="button" data-bk="restore" data-fn="${esc(b.filename)}" >${esc(t('restore'))}</button>
          <button class="btn btn-s btn-d" type="button" data-bk="delete" data-fn="${esc(b.filename)}" >${esc(t('delete'))}</button>
        </div></div>`;
      }).join('');
    } catch (err) { el.innerHTML = `<div class="placeholder">${esc(err.message)}</div>`; }
    loadRemoteBackups();
  }

  async function loadRemoteBackups() {
    const el = $('bRemote');
    try {
      const list = await api('GET', `api/apps/${state.cur.backups}/backups-remote`);
      $('bRemoteWrap').hidden = !list.length;
      el.innerHTML = list.map((b) => `<div class="bk-item">
        <div><div class="bk-date">${esc(fmtDate(b.date))}</div><div class="bk-size">${fmtSize(b.size)}${b.encrypted ? ` <span class="tagline">${esc(t('encrypted'))}</span>` : ''}</div></div>
        <div class="bk-acts"><button class="btn btn-s" type="button" data-remote="${esc(b.name)}">${esc(t('restore'))}</button></div></div>`).join('');
    } catch { $('bRemoteWrap').hidden = true; }
  }

  $('bRemote').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remote]');
    if (!b || !confirm(t('restoreConfirm'))) return;
    const id = state.cur.backups;
    try {
      await busy(b, () => api('POST', `api/apps/${id}/backups-remote/${encodeURIComponent(b.dataset.remote)}/restore`));
      toast(t('restoreStarted'));
      closeM('bMod');
      refresh();
      const a = state.apps.find((x) => x.id === id);
      if (a) openLogs(a);
    } catch (err) { toast(err.message, 'err'); }
  });

  $('bList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-bk]');
    if (!b) return;
    const id = state.cur.backups;
    const fn = b.dataset.fn;
    try {
      if (b.dataset.bk === 'verify') {
        const v = await busy(b, () => api('POST', `api/apps/${id}/backups/${fn}/verify`));
        toast(v.ok ? t('verified') : `${t('verifyFailed')}: ${v.error}`, v.ok ? 'ok' : 'err');
        return loadBackups();
      }
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
      // Verification and the offsite copy finish shortly after.
      setTimeout(() => { if ($('bMod').classList.contains('on')) loadBackups(); }, 4000);
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
    $('sqlOut').innerHTML = '';
    $('sqlInfo').textContent = '';
    $('sqlWrite').checked = false;
    $('sqlWriteWrap').hidden = !isAdmin();
    loadSqlTables(a);
  }

  async function loadSqlTables(a) {
    try {
      const tables = await api('GET', `api/apps/${a.id}/sql/tables`);
      $('sqlTables').innerHTML = tables.length
        ? tables.map((x) => `<button type="button" class="chip" data-table="${esc(x.name)}">${esc(x.name)}</button>`).join('')
        : `<span class="dim small">${esc(t('noTables'))}</span>`;
    } catch (err) { $('sqlTables').innerHTML = `<span class="dim small">${esc(err.message)}</span>`; }
  }

  $('sqlTables').addEventListener('click', (e) => {
    const b = e.target.closest('[data-table]');
    if (!b) return;
    const q = /^[A-Za-z_][A-Za-z0-9_]*$/.test(b.dataset.table) ? b.dataset.table : `"${b.dataset.table.replace(/"/g, '""')}"`;
    $('sqlText').value = `SELECT * FROM ${q} LIMIT 100`;
    runSql();
  });

  async function runSql() {
    const sql = $('sqlText').value.trim();
    if (!sql) return;
    const out = $('sqlOut');
    try {
      const r = await busy($('sqlRun'), () => api('POST', `api/apps/${state.cur.db}/sql`, { sql, write: $('sqlWrite').checked }));
      $('sqlInfo').textContent = `${t('rowsCount', { n: r.rows.length })}${r.truncated ? ` (${t('truncated')})` : ''} · ${r.ms} ms`;
      if ($('sqlWrite').checked) {
        const a = state.apps.find((x) => x.id === state.cur.db);
        if (a) loadSqlTables(a);
      }
      if (!r.columns.length) { out.innerHTML = `<p class="dim small">${esc(t('noRows'))}</p>`; return; }
      out.innerHTML = `<table><thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${
        r.rows.map((row) => `<tr>${row.map((v) => `<td${v === null ? ' class="null"' : ''}>${esc(v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : v)}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`;
    } catch (err) {
      $('sqlInfo').textContent = '';
      out.innerHTML = `<p class="sql-err">${esc(err.message)}</p>`;
    }
  }
  $('sqlRun').addEventListener('click', runSql);
  $('sqlText').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); } });

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

  const SETTING_FIELDS = ['sEnv', 'sCmd', 'sMem', 'sCpu', 'sNice', 'sHealthOn', 'sHealthPath', 'sHealthRestart', 'sDomains', 'sGitBranch', 'sGitToken'];

  async function openSettings(a) {
    state.cur.settings = a.id;
    $('sName').textContent = a.name;
    $('sForm').reset();
    // Keep the form read-only until the current values have arrived.
    const lock = (on) => { SETTING_FIELDS.forEach((f) => { $(f).disabled = on; }); $('sBtn').disabled = on; };
    lock(true);
    $('sGit').hidden = !(a.source && a.source.type === 'git');
    $('sLinks').innerHTML = (a.links || []).map((l) => `<a href="${esc(l)}" target="_blank" rel="noopener">${esc(l)}</a>`).join('') || `<span class="dim small">${esc(t('noLinks'))}</span>`;
    openM('sMod');
    try {
      const s = await api('GET', `api/apps/${a.id}/settings`);
      $('sEnv').value = Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n');
      $('sCmd').value = s.startCommand || '';
      $('sMem').value = s.limits.memoryMb || '';
      $('sCpu').value = s.limits.cpuPercent || '';
      $('sNice').value = s.limits.nice || '';
      $('sHealthOn').checked = s.health.enabled !== false;
      $('sHealthPath').value = s.health.path || '/';
      $('sHealthRestart').checked = !!s.health.restart;
      $('sDomains').value = (s.domains || []).join('\n');
      if (!$('sGit').hidden) {
        const src = await api('GET', `api/apps/${a.id}/source`);
        $('sGitBranch').value = src.branch || 'main';
        $('sGitToken').value = '';
        $('sHookUrl').textContent = src.webhookUrl;
        $('sHookSecret').textContent = src.webhookSecret;
      }
      lock(false);
    } catch (err) { toast(err.message, 'err'); }
  }

  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($(b.dataset.copy).textContent);
      toast(t('copied'));
    } catch { toast(t('copyFailed'), 'err'); }
  }));

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
      const id = state.cur.settings;
      const body = {
        env,
        startCommand: $('sCmd').value,
        limits: { memoryMb: $('sMem').value, cpuPercent: $('sCpu').value, nice: $('sNice').value },
        health: { enabled: $('sHealthOn').checked, path: $('sHealthPath').value.trim() || '/', restart: $('sHealthRestart').checked },
        domains: $('sDomains').value.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean),
      };
      await busy($('sBtn'), async () => {
        await api('PUT', `api/apps/${id}/settings`, body);
        if (!$('sGit').hidden) {
          const g = { gitBranch: $('sGitBranch').value.trim() };
          if ($('sGitToken').value) g.gitToken = $('sGitToken').value;
          await api('PUT', `api/apps/${id}/source`, g);
        }
      });
      toast(t('settingsSaved'));
      closeM('sMod');
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  });

  // ---------- file manager ----------

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
        return `<button type="button" class="ft-d" style="padding-left:${pad}px" data-dir="${esc(i.path)}"><span class="ar">▾</span>${esc(i.name)}</button><div class="ft-ch">${renderTree(i.children || [], depth + 1)}</div>`;
      }
      const act = state.file && state.file.path === i.path ? ' act' : '';
      return `<button type="button" class="ft-i${act}" style="padding-left:${pad}px" data-file="${esc(i.path)}" title="${esc(i.path)} · ${fmtSize(i.size)}">${esc(i.name)}</button>`;
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

  window.Pi = Object.assign(window.Pi || {}, {
    api, t, esc, toast, busy, openM, closeM, fmtSize, fmtDate, refresh, state, $,
    isAdmin, canOperate, openLogs, TYPE_LABEL, actions: window.Pi && window.Pi.actions ? window.Pi.actions : {},
  });

  initTheme();
  initLangs();
  applyI18n();
  boot();
})();
