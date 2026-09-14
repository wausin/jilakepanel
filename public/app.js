'use strict';
/* JilakePanel SPA. No build, no deps, no imports (so `node --check` parses it as a script). */

const root = document.getElementById('root');
const S = { user: null, hostname: '', sites: null, timer: null, poll: null, prevStatus: {}, statsOk: null };

/* ---------------- helpers ---------------- */

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function h(tag, attrs) {
  const el = document.createElement(tag);
  attrs = attrs || {};
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // static markup only, never user data
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (let i = 2; i < arguments.length; i++) {
    const kids = arguments[i];
    if (kids == null || kids === false) continue;
    for (const kid of (Array.isArray(kids) ? kids.flat(Infinity) : [kids]))
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(url, opts) {
  opts = opts || {};
  const o = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
  if (opts.body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  if (opts.formData) o.body = opts.formData;
  let r;
  try { r = await fetch('/api' + url, o); }
  catch (e) { throw { status: 0, error: 'network error' }; }
  const ct = r.headers.get('content-type') || '';
  let data;
  if (ct.includes('json')) data = await r.json().catch(() => null);
  else if (!r.ok) data = { error: 'HTTP ' + r.status };
  else data = await r.text();
  if (r.status === 401 && !url.startsWith('/auth/login')) { S.user = null; location.hash = '#/login'; }
  if (!r.ok) throw { status: r.status, error: (data && data.error) || ('HTTP ' + r.status) };
  return data;
}

function toast(msg, isErr) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast' + (isErr ? ' err' : '') },
    h('span', { class: 't-ico', html: isErr
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>' }),
    h('span', { class: 't-msg' }, String(msg)));
  t.addEventListener('click', () => t.remove());
  box.append(t);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, 6000);
}

function modal(title, body, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    let done = false;
    const onKey = e => { if (e.key === 'Escape') close(false); };
    function close(v) { if (done) return; done = true; document.removeEventListener('keydown', onKey); backdrop.remove(); resolve(v); }
    const box = h('div', { class: 'modal' + (opts.wide ? ' wide' : '') },
      h('div', { class: 'mhead' }, h('h3', null, title), h('button', { class: 'x', 'aria-label': 'Close', onclick: () => close(false) }, '\u00d7')),
      h('div', { class: 'mbody' }, body),
      h('div', { class: 'mfoot' },
        h('button', { onclick: () => close(false), 'data-testid': 'modal-cancel' }, opts.cancelText || 'Cancel'),
        opts.okText === null ? null
          : h('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), onclick: () => close(true), 'data-testid': 'modal-ok' }, opts.okText || 'Save'))
    );
    const backdrop = h('div', { class: 'backdrop', onclick: e => { if (e.target === backdrop) close(false); } }, box);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
  });
}

function confirmDlg(msg, danger) {
  return modal('Confirm', h('p', { class: 'confmsg' }, msg), { okText: danger === false ? 'OK' : 'Delete', danger: danger !== false });
}

function genPassword() {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%&*+-=?';
  const b = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(b, x => A[x % A.length]).join('');
}

function fmtBytes(n) { n = Number(n) || 0; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (i ? n.toFixed(1) : Math.round(n)) + ' ' + u[i]; }
function fmtDate(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  const d = new Date(/^\d+$/.test(s) ? (s.length > 11 ? +s : +s * 1000) : (s.includes('T') ? s : s.replace(' ', 'T') + 'Z'));
  return isNaN(d) ? s : d.toLocaleString();
}
function fmtUptime(sec) {
  sec = Math.floor(Number(sec) || 0);
  return (Math.floor(sec / 86400) ? Math.floor(sec / 86400) + 'd ' : '') + Math.floor(sec % 86400 / 3600) + 'h ' + Math.floor(sec % 3600 / 60) + 'm';
}
const enc = p => String(p).split('/').map(encodeURIComponent).join('/');
const joinP = (dir, name) => (dir ? dir.replace(/\/$/, '') + '/' : '') + name;
const baseN = p => String(p).split('/').pop();
const arr = (r, ...keys) => Array.isArray(r) ? r : (r ? keys.map(k => r[k]).find(Array.isArray) || [] : []);
const obj = (r, k) => (r && typeof r === 'object' && !Array.isArray(r)) ? r : (r && r[k]) || {};
function dl(url) { const a = h('a', { href: url, style: 'display:none' }); document.body.append(a); a.click(); a.remove(); }
function filePicker(multi) {
  return new Promise(resolve => {
    const inp = h('input', { type: 'file', multiple: !!multi, style: 'display:none' });
    inp.addEventListener('change', () => { inp.remove(); resolve(Array.from(inp.files || [])); });
    document.body.append(inp); inp.click();
  });
}
const badge = (text, cls, attrs) => h('span', Object.assign({ class: 'badge ' + (cls || '') }, attrs || {}), text);
function btn(label, cls, fn, ...rest) {
  const attrs = { class: 'btn ' + (cls || ''), onclick: fn };
  for (let i = 0; i < rest.length; i += 2) if (rest[i] != null && rest[i + 1] != null) attrs[rest[i]] = rest[i + 1];
  return h('button', attrs, label);
}
function btnDis(b, dis, label) {
  b.disabled = dis;
  if (label != null) {
    b.innerHTML = '';
    if (dis) b.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
    b.append(document.createTextNode(label));
  }
}
function pageHead(title, ...actions) { return h('div', { class: 'pagehead' }, h('h2', null, title), h('div', { class: 'acts' }, ...actions)); }
function empty(msg) { return h('div', { class: 'card empty' }, msg); }
function emptyState(icon, title, sub, cta) {
  return h('div', { class: 'card empty-state' },
    h('div', { class: 'es-ico' }, ico(icon)),
    h('div', { class: 'es-title' }, title),
    sub ? h('div', { class: 'es-sub' }, sub) : null,
    cta ? h('div', { class: 'es-cta' }, cta) : null);
}
function loading(box) { box.innerHTML = ''; box.append(
  h('div', { class: 'skeleton' }, h('div', { class: 'sk sk-head' }), h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line w70' }), h('div', { class: 'sk sk-line w50' })));
}

/* inline SVG icons (stroke = currentColor) */
const ICONS = {
  dash: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  sites: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><line x1="7" y1="7.5" x2="7.01" y2="7.5"/><line x1="7" y1="16.5" x2="7.01" y2="16.5"/>',
  crons: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  mysql: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6"/><path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3"/>',
  backups: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8"/><path d="M10 12h4"/>',
  events: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="2" x2="9" y2="4"/><line x1="15" y1="2" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="22"/><line x1="15" y1="20" x2="15" y2="22"/><line x1="2" y1="9" x2="4" y2="9"/><line x1="2" y1="15" x2="4" y2="15"/><line x1="20" y1="9" x2="22" y2="9"/><line x1="20" y1="15" x2="22" y2="15"/>',
  mem: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M7 10h3M14 10h3M7 14h3M14 14h3"/>',
  uptime: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  node: '<path d="M12 2L2 8v8l10 6 10-6V8L12 2z"/><path d="M12 22V8"/><path d="M12 12l8-4.8"/>',
  server: '<rect x="2" y="3" width="20" height="7" rx="1.5"/><rect x="2" y="14" width="20" height="7" rx="1.5"/><line x1="6" y1="6.5" x2="6.01" y2="6.5"/><line x1="6" y1="17.5" x2="6.01" y2="17.5"/>',
  site: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>',
};
function ico(name, cls) {
  return h('span', { class: 'ico ' + (cls || ''), html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>' });
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', cur);
  try { localStorage.setItem('jlp_theme', cur); } catch (e) { /* private mode */ }
}

async function allSites(force) { if (force || !S.sites) { const r = await api('/sites'); S.sites = arr(r, 'sites'); } return S.sites; }

/* form builder: fields -> element with .get(k) .values() .show(k,on) */
function form(fields) {
  const inputs = {};
  const el = h('form', { class: 'form', onsubmit: e => e.preventDefault() });
  for (const f of fields) {
    let inp;
    if (f.type === 'select') {
      inp = h('select', {});
      for (const o of (f.options || [])) {
        const val = typeof o === 'object' ? o.value : o, lab = typeof o === 'object' ? o.label : o;
        inp.append(h('option', { value: val, selected: f.value != null && String(val) === String(f.value) }, String(lab)));
      }
      if (f.value == null && f.placeholder) inp.prepend(h('option', { value: '', disabled: true, selected: true }, f.placeholder));
    } else if (f.type === 'textarea') {
      inp = h('textarea', { rows: f.rows || 5, placeholder: f.placeholder || '', spellcheck: false }, f.value || '');
    } else if (f.type === 'checkbox') {
      inp = h('input', { type: 'checkbox', checked: !!f.value });
    } else {
      inp = h('input', { type: f.type || 'text', placeholder: f.placeholder || '', value: f.value != null ? f.value : '', autocomplete: 'off' });
    }
    if (f.required) inp.required = true;
    if (f.testid) inp.setAttribute('data-testid', f.testid);
    const ctl = f.type === 'checkbox'
      ? h('label', { class: 'chkrow' }, inp, h('span', null, f.label))
      : h('label', { class: f.inline ? 'field inline' : 'field' }, h('span', { class: 'flab' }, f.label),
        f.gen ? h('span', { class: 'pwrow' }, inp, h('button', { type: 'button', class: 'btn small', title: 'Generate password', onclick: () => { inp.value = genPassword(); } }, '\u21c3')) : inp,
        f.hint ? h('span', { class: 'hint' }, f.hint) : null);
    inputs[f.key] = inp;
    el.append(ctl);
  }
  el.get = k => inputs[k];
  el.show = (k, on) => { const n = inputs[k] && inputs[k].closest('.field,.chkrow'); if (n) n.style.display = on ? '' : 'none'; };
  el.values = () => {
    const v = {};
    for (const f of fields) {
      const inp = inputs[f.key];
      v[f.key] = f.type === 'checkbox' ? inp.checked : (f.type === 'number' ? (inp.value === '' ? null : Number(inp.value)) : inp.value);
    }
    return v;
  };
  return el;
}

/* SQL literal builders (client-side; server still gates writes behind confirm) */
const idq = s => '"' + String(s).replace(/"/g, '""') + '"';
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}
const matchCond = (cols, row) => cols.map(c => idq(c.name) + ' IS ' + lit(row[c.name])).join(' AND ');
/* Buffer-like JSON ({type:'Buffer',data:[...]} or Uint8Array-ish) — never editable, never in SQL */
const isBlob = v => v != null && typeof v === 'object' && (Array.isArray(v.data) || v.type === 'Buffer' || v instanceof Uint8Array);
const blobLen = v => (Array.isArray(v.data) ? v.data.length : (v.length != null ? v.length : (v.data ? String(v.data).length : 0)));

/* ---------------- chrome + router ---------------- */

function shell(active) {
  root.innerHTML = '';
  const items = [
    ['Dashboard', '#/', 'dash'], ['Sites', '#/sites', 'sites'], ['Cron Jobs', '#/crons', 'crons'],
    ['MySQL Databases', '#/mysql', 'mysql'], ['Backups', '#/backups', 'backups'],
    ['Events', '#/events', 'events', 1], ['Users', '#/users', 'users', 1], ['Settings', '#/settings', 'settings', 1],
  ];
  const nav = items.filter(it => !it[3] || S.user.role === 'admin')
    .map(it => h('a', { href: it[1], class: active === it[2] ? 'active' : '', 'data-testid': 'nav-' + it[2] }, ico(it[2]), h('span', { class: 'nl' }, it[0])));
  const main = h('main', { id: 'main' });
  root.append(h('div', { class: 'layout' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'logo' }, LOGO, h('span', { class: 'logo-txt' }, 'JilakePanel')),
      h('nav', null, nav),
      h('div', { class: 'host' }, S.hostname || '\u2014')),
    h('div', { class: 'col' },
      h('header', { class: 'topbar' },
        h('div', { class: 'tb-title' }, h('span', { id: 'sys-status', class: 'sys-dot', title: 'System status unknown' }, ''), S.hostname || 'JilakePanel'),
        h('div', { class: 'tb-user' },
          h('button', { class: 'iconbtn', 'data-testid': 'theme-toggle', 'aria-label': 'Toggle theme', onclick: toggleTheme }, ico('sun', 'theme-sun'), ico('moon', 'theme-moon')),
          h('span', { class: 'chip' }, h('span', { class: 'avatar' }, String(S.user.username[0] || '?').toUpperCase()), h('span', { class: 'uname' }, S.user.username), badge(S.user.role, S.user.role === 'admin' ? 'green' : '')),
          btn('Logout', 'ghost', logout, 'data-testid', 'logout'))),
      main)));
  return main;
}
const LOGO = h('span', { class: 'mark', html: '<svg viewBox="0 0 16 16" width="20" height="20"><rect x="1" y="1" width="14" height="14" rx="4" fill="var(--accent)"/><path d="M5 11l3-6 3 6" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' }).cloneNode(true);

async function logout() { try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* session gone anyway */ } S.user = null; location.hash = '#/login'; }
function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } if (S.poll) { clearInterval(S.poll); S.poll = null; } }

async function route() {
  stopTimer();
  const raw = location.hash.replace(/^#\/?/, '');
  if (!S.user) { if (raw !== 'login') { location.hash = '#/login'; return; } return renderLogin(); }
  if (raw === 'login') { location.hash = '#/'; return; }
  const p = raw.split('/');
  try {
    if (raw === '') return pageDashboard(shell('dash'));
    if (p[0] === 'sites') return pageSites(shell('sites'));
    if (p[0] === 'site' && p[1]) return pageSite(shell('sites'), Number(p[1]), p[2] || 'general');
    if (p[0] === 'crons') return pageCronsTop(shell('crons'));
    if (p[0] === 'mysql') return pageMysqlTop(shell('mysql'));
    if (p[0] === 'backups') return pageBackupsTop(shell('backups'));
    if (p[0] === 'events' && S.user.role === 'admin') return pageEvents(shell('events'));
    if (p[0] === 'users' && S.user.role === 'admin') return pageUsers(shell('users'));
    if (p[0] === 'settings' && S.user.role === 'admin') return pageSettings(shell('settings'));
    badPage();
  } catch (e) { toast(e.error || String(e), 1); }
}
function badPage() { const m = shell(''); m.append(empty('Page not found or access denied.')); }

/* ---------------- login ---------------- */

function renderLogin() {
  root.innerHTML = '';
  const u = h('input', { type: 'text', autocomplete: 'username', placeholder: 'Username', 'data-testid': 'login-username' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'data-testid': 'login-password' });
  const err = h('div', { class: 'lerr' });
  const go = h('button', { class: 'btn primary block', 'data-testid': 'login-submit' }, 'Sign in');
  const submit = async () => {
    err.textContent = '';
    btnDis(go, true, 'Signing in\u2026');
    try {
      const r = await api('/auth/login', { method: 'POST', body: { username: u.value, password: pw.value } });
      S.user = obj(r, 'user').user || obj(r, 'user');
      location.hash = '#/';
    } catch (e) { err.textContent = e.error || 'login failed'; btnDis(go, false, 'Sign in'); }
  };
  go.addEventListener('click', submit);
  [u, pw].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
  root.append(h('div', { class: 'login-wrap' },
    h('div', { class: 'card login' },
      h('div', { class: 'logo big' }, LOGO.cloneNode(true), 'JilakePanel'),
      h('p', { class: 'sub' }, 'Server control panel'),
      h('label', { class: 'field' }, h('span', { class: 'flab' }, 'Username'), u),
      h('label', { class: 'field' }, h('span', { class: 'flab' }, 'Password'), pw),
      err, go)));
}

/* ---------------- dashboard ---------------- */

async function pageDashboard(main) {
  const wrap = h('div'); main.append(wrap);
  const sc = (ic, l, v) => h('div', { class: 'card stat' }, h('div', { class: 'st-ico' }, ico(ic)), h('div', { class: 'cl' }, l), h('div', { class: 'cv' }, v));
  const dot = document.getElementById('sys-status');
  const draw = async () => {
    try {
      const st = obj(await api('/system/stats'));
      S.hostname = st.hostname || '';
      S.statsOk = true;
      if (dot) { dot.className = 'sys-dot ok'; dot.title = 'System reachable'; }
      let n = '\u2014';
      try { n = (await allSites(true)).length; } catch (e) { /* sites module may be down */ }
      const memTotal = st.memTotal || 0, memUsed = (st.memTotal || 0) - (st.memFree || 0);
      const memPct = memTotal ? Math.max(0, Math.min(100, Math.round(memUsed / memTotal * 100))) : 0;
      const updated = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      wrap.innerHTML = '';
      wrap.append(pageHead('Dashboard', h('span', { class: 'dim stat-updated' }, 'last updated ' + updated)),
        h('div', { class: 'cards' },
          sc('server', 'Hostname', h('span', { class: 'hostval' }, st.hostname), h('span', { class: 'stat-sub' }, st.platform)),
          sc('site', 'Sites', String(n), h('span', { class: 'stat-sub' }, 'configured')),
          sc('cpu', 'CPU', h('span', { class: 'stat-sub' }, st.cpus + ' cores'), h('span', { class: 'load' }, 'load ' + (Array.isArray(st.loadavg) ? st.loadavg.map(x => Number(x).toFixed(2)).join(' ') : st.loadavg))),
          sc('mem', 'Memory', h('div', { class: 'memwrap' },
            h('div', { class: 'memtxt' }, h('b', null, fmtBytes(memUsed)), ' / ', fmtBytes(memTotal)),
            h('div', { class: 'membar' }, h('div', { class: 'memfill', style: 'width:' + memPct + '%' }))),
            h('span', { class: 'stat-sub' }, memPct + '% used')),
          sc('uptime', 'Uptime', fmtUptime(st.uptime)),
          sc('node', 'Node.js', st.node)));
    } catch (e) { S.statsOk = false; if (dot) { dot.className = 'sys-dot'; dot.title = 'System unreachable'; } wrap.innerHTML = ''; wrap.append(pageHead('Dashboard'), empty('Stats unavailable: ' + (e.error || e))); }
  };
  await draw();
  S.timer = setInterval(draw, 10000);
}

/* ---------------- sites list ---------------- */

async function pageSites(main) {
  const box = h('div'); main.append(box);
  const refresh = async () => {
    loading(box);
    let sites;
    try { sites = await allSites(true); } catch (e) { box.innerHTML = ''; box.append(pageHead('Sites', btn('+ Add Site', 'primary', addSiteModal, 'data-testid', 'sites-add')), empty('Sites API unavailable: ' + (e.error || e))); return; }
    box.innerHTML = '';
    const sel = new Set();
    const delBtn = btn('Delete Selected', 'danger', async () => {
      if (!sel.size) return toast('Nothing selected', 1);
      const purge = h('input', { type: 'checkbox' });
      const ok = await modal('Delete ' + sel.size + ' site(s)',
        h('div', null, h('p', null, 'Delete the selected site(s)? Their vhosts and pools are removed.'),
          h('label', { class: 'chkrow' }, purge, h('span', null, 'Also delete system user and all files (purge)'))),
        { danger: true, okText: 'Delete' });
      if (!ok) return;
      for (const id of sel) { try { await api('/sites/' + id, { method: 'DELETE', body: { purge: purge.checked } }); } catch (e) { toast('Site ' + id + ': ' + e.error, 1); } }
      toast('Sites deleted'); refresh();
    });
    box.append(pageHead('Sites', btn('+ Add Site', 'primary', addSiteModal, 'data-testid', 'sites-add'), delBtn));
    if (!sites.length) return box.append(emptyState('sites', 'No sites yet', 'Add your first site to get started \u2014 PHP, Node.js, static or a reverse proxy.', btn('+ Add Site', 'primary', addSiteModal)));
    const statusCell = s => {
      if (s.status === 'creating') return h('td', { class: 'status-cell creating' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Creating\u2026');
      if (s.status === 'error') return h('td', { class: 'status-cell' },
        badge('Error', 'red', s.status_msg ? { title: s.status_msg } : null),
        s.status_msg ? h('span', { class: 'status-msg', title: s.status_msg }, s.status_msg) : null);
      return h('td', { class: 'status-cell' }, badge('ready', 'dim'));
    };
    const tbody = h('tbody');
    for (const s of sites) {
      const cb = h('input', { type: 'checkbox' });
      cb.addEventListener('change', () => { cb.checked ? sel.add(s.id) : sel.delete(s.id); });
      tbody.append(h('tr', { class: 'click' + (s.status === 'creating' ? ' creating' : ''), 'data-testid': 'site-row-' + s.domain, onclick: e => { if (!e.target.closest('input,button,a')) location.hash = '#/site/' + s.id; } },
        h('td', null, cb),
        h('td', { class: 'strong' }, s.domain),
        h('td', null, badge(s.type, 'type')),
        h('td', null, s.tls ? badge('TLS', 'green') : badge('no TLS', 'dim')),
        statusCell(s),
        h('td', null, s.enabled ? badge('enabled', 'green') : badge('disabled', 'red')),
        h('td', { class: 'dim' }, s.site_user),
        h('td', { class: 'right' }, btn('Open', 'small', () => { location.hash = '#/site/' + s.id; }))));
    }
    box.append(h('div', { class: 'card' }, h('table', { class: 'list' },
      h('thead', null, h('tr', null, h('th', { scope: 'col', style: 'width:32px' }, ''), h('th', { scope: 'col' }, 'Domain'), h('th', { scope: 'col' }, 'Type'), h('th', { scope: 'col' }, 'TLS'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'Enabled'), h('th', { scope: 'col' }, 'User'), h('th', { scope: 'col' }, ''))),
      tbody)));
    if (sites.some(s => s.status === 'creating')) startPoll(refresh);
  };

  const TYPE_DESC = {
    php: 'Classic LAMP: nginx + PHP-FPM pool, docroot under the system user.',
    node: 'Node.js back-end on an app port, reverse-proxied by nginx.',
    static: 'Plain static files served straight from the docroot.',
    proxy: 'Reverse proxy to an existing local service URL.',
  };
  async function addSiteModal() {
    const desc = h('p', { class: 'typedesc' });
    const f = form([
      { key: 'type', label: 'Type', type: 'select', value: 'php', testid: 'site-type', options: [{ value: 'php', label: 'PHP Site' }, { value: 'node', label: 'Node.js Back-end' }, { value: 'static', label: 'Static HTML Site' }, { value: 'proxy', label: 'Reverse Proxy' }] },
      { key: 'domain', label: 'Domain', placeholder: 'example.com', required: true, testid: 'site-domain' },
      { key: 'phpVersion', label: 'PHP version', type: 'select', value: '8.3', testid: 'site-php-version', options: ['8.1', '8.2', '8.3', '8.4', '8.5'] },
      { key: 'nodeVersion', label: 'Node.js version', type: 'select', value: '22', options: ['18', '20', '22', '24'] },
      { key: 'appPort', label: 'Application port', type: 'number', placeholder: '3000', testid: 'site-app-port' },
      { key: 'proxyTarget', label: 'Proxy target URL', placeholder: 'http://127.0.0.1:3000', testid: 'site-proxy-target' },
      { key: 'siteUser', label: 'System user', placeholder: 'example', required: true, testid: 'site-user', hint: 'A Linux user (/home/<user>, docroot htdocs) is created for every site type and the site runs as it.' },
      { key: 'password', label: 'System user password', required: true, gen: true, testid: 'site-password' },
    ]);
    const pwInput = f.get('password');
    const pwRow = pwInput.closest('.pwrow');
    if (pwRow) pwRow.append(h('button', { type: 'button', class: 'btn small', title: 'Copy password', 'aria-label': 'Copy password', onclick: async () => {
      try { await navigator.clipboard.writeText(pwInput.value); toast('Password copied'); }
      catch (e) { pwInput.select(); document.execCommand('copy'); toast('Password copied'); }
    } }, '\u2398'));
    desc.textContent = TYPE_DESC.php;
    const sync = () => {
      const t = f.get('type').value;
      f.show('phpVersion', t === 'php');
      f.show('nodeVersion', t === 'node');
      f.show('appPort', t === 'node');
      f.show('proxyTarget', t === 'proxy');
      desc.textContent = TYPE_DESC[t] || '';
    };
    f.get('type').addEventListener('change', sync); sync();
    f.get('domain').addEventListener('keydown', e => e.stopPropagation());
    if (!await modal('Add Site', h('div', null, desc, f), { okText: 'Create site' })) return;
    const v = f.values();
    const body = { domain: v.domain, type: v.type, siteUser: v.siteUser, password: v.password };
    if (v.type === 'php') body.phpVersion = v.phpVersion;
    if (v.type === 'node') { body.nodeVersion = v.nodeVersion; body.appPort = v.appPort; }
    if (v.type === 'proxy') body.proxyTarget = v.proxyTarget;
    try {
      await api('/sites', { method: 'POST', body });
      toast('Creating ' + v.domain + '\u2026');
      refresh();
      startPoll(refresh);
    }
    catch (e) { toast(e.error || 'create failed', 1); }
  }

  function startPoll(refresh) {
    if (S.poll) return;
    S.prevStatus = {};
    for (const s of S.sites || []) S.prevStatus[s.id] = s.status;
    S.poll = setInterval(async () => {
      let sites;
      try { sites = await allSites(true); } catch (e) { return; }
      const anyCreating = sites.some(s => s.status === 'creating');
      for (const s of sites) {
        const prev = S.prevStatus[s.id];
        if (prev === 'creating' && s.status === 'ready') toast('Site ' + s.domain + ' is ready');
        else if (prev === 'creating' && s.status === 'error') toast(s.status_msg || ('Site ' + s.domain + ' failed'), 1);
        S.prevStatus[s.id] = s.status;
      }
      if (!anyCreating) { if (S.poll) { clearInterval(S.poll); S.poll = null; } }
      else refresh();
    }, 1000);
  }

  await refresh();
}

/* ---------------- site detail ---------------- */

const TABS = [['general', 'General'], ['vhost', 'Vhost'], ['tls', 'SSL/TLS'], ['files', 'Files'], ['sqlite', 'SQLite'], ['mysql', 'MySQL'], ['crons', 'Cron Jobs'], ['logs', 'Logs'], ['backups', 'Backups']];

async function pageSite(main, id, tab) {
  loading(main);
  let site;
  try { const r = await api('/sites/' + id); site = r.site || r; }
  catch (e) { main.innerHTML = ''; main.append(empty('Site unavailable: ' + (e.error || e))); return; }
  main.innerHTML = '';
  const body = h('div', { class: 'tabbody' });
  main.append(
    h('div', { class: 'pagehead' },
      h('h2', null, site.domain, ' ', badge(site.type, 'type'), site.tls ? badge('TLS', 'green') : null, site.enabled ? null : badge('disabled', 'red')),
      h('div', { class: 'acts' }, btn('\u2190 Sites', '', () => { location.hash = '#/sites'; }))),
    h('div', { class: 'tabs' }, TABS.map(t => h('a', { href: '#/site/' + id + '/' + t[0], class: tab === t[0] ? 'active' : '', 'data-testid': 'tab-' + t[0] }, t[1]))),
    body);
  const fn = { general: tabGeneral, vhost: tabVhost, tls: tabTls, files: tabFiles, sqlite: tabSqlite, mysql: tabMysql, crons: tabCrons, logs: tabLogs, backups: tabBackups }[tab] || tabGeneral;
  fn(body, site);
}

function tabGeneral(body, site) {
  const ro = (l, v) => h('label', { class: 'field' }, h('span', { class: 'flab' }, l), h('input', { value: v == null ? '' : v, readOnly: true }));
  const f = form([
    { key: 'phpVersion', label: 'PHP version', type: 'select', value: site.php_version || '8.3', options: ['8.1', '8.2', '8.3', '8.4', '8.5'] },
    { key: 'appPort', label: 'Application port', type: 'number', value: site.app_port },
    { key: 'proxyTarget', label: 'Proxy target', value: site.proxy_target || '' },
    { key: 'enabled', label: 'Site enabled', type: 'checkbox', value: !!site.enabled },
  ]);
  const t = site.type;
  f.show('phpVersion', t === 'php');
  f.show('appPort', t === 'node');
  f.show('proxyTarget', t === 'proxy');
  const save = async () => {
    const v = f.values();
    const patch = { enabled: v.enabled ? 1 : 0 };
    if (t === 'php') patch.phpVersion = v.phpVersion;
    if (t === 'node') patch.appPort = v.appPort;
    if (t === 'proxy') patch.proxyTarget = v.proxyTarget;
    try {
      await api('/sites/' + site.id, { method: 'PATCH', body: patch });
      toast('Site updated');
      pageSite(body.parentNode, site.id, 'general'); // re-render detail with fresh state
    } catch (e) { toast(e.error || 'update failed', 1); }
  };
  body.append(h('div', { class: 'card panel' }, h('h3', null, 'Settings'), f, btn('Save', 'primary', save)),
    h('div', { class: 'card panel' }, h('h3', null, 'Details'),
      ro('System user', site.site_user), ro('Docroot', site.docroot), ro('Created', fmtDate(site.created_at))));
}

async function tabVhost(body, site) {
  loading(body);
  let raw = '';
  try {
    const r = await api('/sites/' + site.id + '/vhost');
    raw = typeof r === 'string' ? r : (r.content ?? r.text ?? r.conf ?? r.vhost ?? '');
  } catch (e) { body.innerHTML = ''; body.append(empty('Vhost unavailable: ' + (e.error || e))); return; }
  body.innerHTML = '';
  const ta = h('textarea', { class: 'code big', spellcheck: false, wrap: 'off' });
  ta.value = raw;
  const sb = btn('Save', 'primary', async () => {
    btnDis(sb, true, 'Validating\u2026');
    try { await api('/sites/' + site.id + '/vhost', { method: 'PUT', body: { content: ta.value, text: ta.value } }); toast('Vhost saved (nginx validated)'); }
    catch (e) { toast(e.error || 'save failed', 1); } // nginx validation error shown verbatim
    btnDis(sb, false, 'Save');
  });
  body.append(h('div', { class: 'card panel' }, h('h3', null, 'nginx vhost \u2014 ' + site.domain), ta,
    h('div', { class: 'row' }, sb, h('span', { class: 'hint inline' }, 'Config is validated with nginx -t before commit; on failure the panel rolls back and the error is shown as a toast.'))));
}

async function tabTls(body, site) {
  const status = h('div', { class: 'card panel' });
  const email = h('input', { type: 'text', placeholder: 'admin@example.com' });
  const load = async () => {
    status.innerHTML = '';
    status.append(h('h3', null, 'Certificate'), h('p', { class: 'dim' }, 'Checking\u2026'));
    let txt;
    try {
      const r = obj(await api('/sites/' + site.id + '/tls'));
      txt = (r.tls && r.expires)
        ? h('p', null, badge('issued', 'green'), ' Issued — expires ', h('b', null, fmtDate(r.expires)))
        : h('p', { class: 'dim' }, 'No certificate installed.');
    } catch (e) {
      txt = h('p', { class: 'dim' }, e.status === 404 ? 'No certificate installed.' : 'TLS status unavailable: ' + (e.error || e));
    }
    status.innerHTML = '';
    status.append(h('h3', null, 'Certificate'), txt);
  };
  const issue = btn('Issue Certificate', 'primary', async () => {
    if (!email.value) return toast('Enter an email address', 1);
    btnDis(issue, true, 'Requesting\u2026');
    try { await api('/sites/' + site.id + '/tls', { method: 'POST', body: { email: email.value } }); toast('Certificate issued'); load(); }
    catch (e) { toast(e.error || 'issue failed', 1); }
    btnDis(issue, false, 'Issue Certificate');
  });
  body.append(status, h('div', { class: 'card panel' }, h('h3', null, 'Let\u2019s Encrypt'),
    h('label', { class: 'field' }, h('span', { class: 'flab' }, 'Contact email'), email), issue,
    h('span', { class: 'hint' }, 'Runs certbot (HTTP-01 via the existing vhost). Domain DNS must point at this host.')));
  load();
}

/* ---------------- files ---------------- */

const isDirE = e => e.type === 'dir' || e.dir === true || e.isDir === true;

async function tabFiles(body, site) {
  let path = '';
  const wrap = h('div'); body.append(wrap);
  const backBtn = () => btn('\u2190 Site', 'small', () => { location.hash = '#/site/' + site.id; });
  const full = name => joinP(path, name);

  const crumb = () => {
    const out = [h('a', { href: '#', onclick: e => { e.preventDefault(); go(''); } }, site.site_user)];
    let acc = '';
    for (const p of (path ? path.split('/') : [])) {
      acc = acc ? acc + '/' + p : p;
      out.push(' / ', h('a', { href: '#', onclick: e => { e.preventDefault(); go(acc); } }, p));
    }
    return h('div', { class: 'crumb' }, out);
  };
  const go = p => { path = p; render(); };

  const render = async () => {
    loading(wrap);
    let items;
    try { const r = await api('/sites/' + site.id + '/files?path=' + encodeURIComponent(path)); items = arr(r, 'items', 'entries', 'files'); }
    catch (e) { wrap.innerHTML = ''; wrap.append(pageHead('Files', backBtn()), empty('Directory unavailable: ' + (e.error || e))); return; }
    items = items.map(e => typeof e === 'string' ? { name: e, type: 'file' } : e)
      .sort((a, b) => (isDirE(b) - isDirE(a)) || String(a.name).localeCompare(String(b.name)));
    wrap.innerHTML = '';
    const upBtn = btn('\u2191 Up', 'small', () => { const i = path.lastIndexOf('/'); go(i < 0 ? '' : path.slice(0, i)); });
    wrap.append(pageHead('Files', backBtn(), btn('\u2191 Upload', '', doUpload), btn('New folder', '', doMkdir), btn('New file', '', doNewFile)),
      h('div', { class: 'card' },
        h('div', { class: 'filebar' }, crumb(), path ? upBtn : null),
        items.length ? h('table', { class: 'list' },
          h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Size'), h('th', null, 'Modified'), h('th', { class: 'right' }, 'Actions'))),
          h('tbody', null, items.map(it => {
            const dir = isDirE(it);
            return h('tr', { class: dir ? 'click' : '', onclick: e => { if (dir && !e.target.closest('button')) go(full(it.name)); } },
              h('td', null, h('span', { class: 'fico' + (dir ? ' dir' : '') }, dir ? '\u25b8' : '\u00b7'), ' ', it.name),
              h('td', { class: 'dim size' }, dir ? '\u2014' : fmtBytes(it.size)),
              h('td', { class: 'dim' }, fmtDate(it.mtime ?? it.modified ?? it.date)),
              h('td', { class: 'right' },
                !dir && btn('Edit', 'small', () => editFile(full(it.name))),
                btn('Download', 'small', () => dl('/api/sites/' + site.id + '/download?path=' + encodeURIComponent(full(it.name)))),
                btn('Rename', 'small', () => renameIt(it.name)),
                btn('Delete', 'small danger', () => delIt(full(it.name)))));
          }))) : h('div', { class: 'empty inner' }, 'Empty directory.')));
  };

  const doUpload = async () => {
    const files = await filePicker(true);
    for (const fd of files) {
      const fo = new FormData(); fo.append('file', fd);
      try { await api('/sites/' + site.id + '/files/upload?path=' + encodeURIComponent(path), { method: 'POST', formData: fo }); toast('Uploaded ' + fd.name); }
      catch (e) { toast('Upload ' + fd.name + ': ' + e.error, 1); }
    }
    render();
  };
  const doMkdir = async () => {
    const f = form([{ key: 'name', label: 'Folder name', required: true }]);
    if (!await modal('New folder', f)) return;
    try { await api('/sites/' + site.id + '/files/mkdir', { method: 'POST', body: { path, name: f.values().name } }); toast('Folder created'); render(); }
    catch (e) { toast(e.error, 1); }
  };
  const doNewFile = async () => {
    const f = form([{ key: 'name', label: 'File name', required: true, placeholder: 'index.html' }]);
    if (!await modal('New file', f)) return;
    const p = full(f.values().name);
    try { await api('/sites/' + site.id + '/file?path=' + encodeURIComponent(p), { method: 'PUT', body: { content: '' } }); toast('File created'); editFile(p); }
    catch (e) { toast(e.error, 1); }
  };
  const renameIt = async (name) => {
    const f = form([{ key: 'to', label: 'New name', required: true, value: name }]);
    if (!await modal('Rename', f)) return;
    try { await api('/sites/' + site.id + '/files/rename', { method: 'POST', body: { path, from: name, to: f.values().to } }); toast('Renamed'); render(); }
    catch (e) { toast(e.error, 1); }
  };
  const delIt = async (p) => {
    if (!await confirmDlg('Delete ' + p + '? This cannot be undone.', true)) return;
    try { await api('/sites/' + site.id + '/file?path=' + encodeURIComponent(p), { method: 'DELETE' }); toast('Deleted'); render(); }
    catch (e) { toast(e.error, 1); }
  };
  const editFile = async (p) => {
    wrap.innerHTML = '';
    wrap.append(pageHead('Editor', backBtn(), btn('\u2190 Back to files', 'small', () => render())));
    const holder = h('div', { class: 'card panel' });
    holder.append(h('h3', { class: 'mono dim' }, p));
    wrap.append(holder);
    let content;
    try { const r = await api('/sites/' + site.id + '/file?path=' + encodeURIComponent(p)); content = typeof r === 'string' ? r : (r.content ?? r.text ?? ''); }
    catch (e) {
      holder.remove();
      if (e.status === 415) { toast('Binary file \u2014 editing not supported. Use Download.', 1); render(); }
      else wrap.append(empty(e.error || 'read failed'));
      return;
    }
    const ta = h('textarea', { class: 'code big', spellcheck: false, wrap: 'off' });
    ta.value = content;
    const sv = btn('Save', 'primary', async () => {
      btnDis(sv, true, 'Saving…');
      try { await api('/sites/' + site.id + '/file?path=' + encodeURIComponent(p), { method: 'PUT', body: { content: ta.value } }); toast('Saved ' + p); }
      catch (e) { toast(e.error, 1); }
      btnDis(sv, false, 'Save');
    });
    holder.append(ta, h('div', { class: 'row' }, sv));
  };

  render();
}

/* ---------------- SQLite (the star) ---------------- */

const SQ = { db: null, table: null, schema: null, page: 1, perPage: 25, col: '', q: '', sort: '', dir: 'asc', rows: [], cols: [], total: null };

async function tabSqlite(body, site) {
  SQ.db = SQ.table = SQ.schema = null; SQ.page = 1; SQ.col = ''; SQ.q = ''; SQ.sort = ''; SQ.dir = 'asc';
  const dbsBox = h('div', { class: 'side' });
  const tabsBox = h('div', { class: 'side' });
  const right = h('div', { class: 'maincol' });
  body.append(h('div', { class: 'sqlite' }, dbsBox, tabsBox, right));
  const dbPath = d => (typeof d === 'string' ? d : (d.path || d.name));
  const url = rest => '/sites/' + site.id + '/sqlite/' + enc(SQ.db) + rest;
  const pad = m => h('div', { class: 'dim pad' }, m);

  const loadDbs = async () => {
    let items = [];
    try { items = arr(await api('/sites/' + site.id + '/sqlite'), 'dbs', 'files'); }
    catch (e) { dbsBox.innerHTML = ''; dbsBox.append(h('div', { class: 'sidehead' }, 'Databases'), pad(e.error || 'SQLite API unavailable')); return; }
    const nameIn = h('input', { placeholder: 'new.db', class: 'small', 'data-testid': 'sqlite-new-db' });
    const ul = h('ul', { class: 'sidelist' });
    for (const it of items) {
      const p = dbPath(it);
      ul.append(h('li', { class: (SQ.db === p ? 'active' : '') + '', title: p, onclick: () => { SQ.db = p; SQ.table = null; SQ.schema = null; SQ.page = 1; loadDbs(); loadTables(); renderRight(); } },
        h('span', { class: 'dbico' }, '\u25c6'), ' ', baseN(p)));
    }
    dbsBox.innerHTML = '';
    dbsBox.append(h('div', { class: 'sidehead' }, 'Databases'),
      h('div', { class: 'row pad' }, nameIn, btn('+ New', 'small primary', async () => {
        const n = nameIn.value.trim(); if (!n) return;
        try { await api('/sites/' + site.id + '/sqlite', { method: 'POST', body: { name: n } }); toast('Created ' + n); nameIn.value = ''; loadDbs(); }
        catch (e) { toast(e.error, 1); }
      }, 'data-testid', 'sqlite-create-db')),
      ul.children.length ? ul : pad('No .db files under the site home (usually ~/dbs).'));
  };

  const loadTables = async () => {
    tabsBox.innerHTML = '';
    tabsBox.append(h('div', { class: 'sidehead' }, SQ.db ? baseN(SQ.db) : 'Tables'));
    if (!SQ.db) return tabsBox.append(pad('Select a database.'));
    let tables = [];
    try { tables = arr(await api(url('/tables')), 'tables'); }
    catch (e) { return tabsBox.append(pad(e.error || 'failed')); }
    const ul = h('ul', { class: 'sidelist' });
    for (const t of tables) {
      const name = typeof t === 'string' ? t : (t.name || t.table);
      const cnt = typeof t === 'object' ? (t.count ?? t.rows ?? t.rowCount) : null;
      ul.append(h('li', { class: SQ.table === name ? 'active' : '', onclick: () => { SQ.table = name; SQ.page = 1; SQ.sort = ''; SQ.dir = 'asc'; loadTables(); loadSchemaAndRows(); } },
        h('span', { class: 'tico' }, '\u229e'), ' ', name, cnt != null ? h('span', { class: 'cnt' }, String(cnt)) : null));
    }
    tabsBox.append(ul.children.length ? ul : pad('No tables.'));
  };

  const loadSchemaAndRows = async () => {
    if (!SQ.db || !SQ.table) return renderRight();
    try { SQ.schema = arr(await api(url('/table/' + encodeURIComponent(SQ.table) + '/schema')), 'columns', 'schema'); }
    catch (e) { SQ.schema = null; }
    loadRows();
  };

  const loadRows = async () => {
    if (!SQ.db || !SQ.table) return renderRight();
    const p = new URLSearchParams({ page: SQ.page, perPage: SQ.perPage });
    if (SQ.col && SQ.q !== '') { p.set('filterCol', SQ.col); p.set('filterQ', SQ.q); }
    if (SQ.sort) { p.set('sort', SQ.sort); p.set('dir', SQ.dir); }
    let res;
    try { res = obj(await api(url('/table/' + encodeURIComponent(SQ.table) + '/rows?' + p))); }
    catch (e) { return renderRight(e.error || 'rows failed'); }
    SQ.rows = Array.isArray(res) ? res : (res.rows || []);
    SQ.cols = res.columns || (SQ.rows[0] ? Object.keys(SQ.rows[0]) : (SQ.schema || []).map(c => c.name));
    SQ.total = res.total ?? res.count ?? (SQ.rows.length < SQ.perPage ? (SQ.page - 1) * SQ.perPage + SQ.rows.length : null);
    renderRight();
  };

  const renderRight = (msg) => {
    right.innerHTML = '';
    if (!SQ.db) {
      right.append(emptyState('db', 'No database selected', 'Select a SQLite database on the left, or create one. Browse tables, edit rows, run SQL, import/export \u2014 per site.', null));
      return;
    }
    right.append(h('div', { class: 'dbbar' },
      h('b', { class: 'mono' }, baseN(SQ.db)),
      btn('Export .sql', 'small', () => dl(url('/export'))),
      btn('Import', 'small', async () => {
        const files = await filePicker(false); if (!files.length) return;
        if (!await modal('Import', h('p', { class: 'confmsg' }, 'Importing a .sql file executes it against ', h('b', null, baseN(SQ.db)), ' and may overwrite existing data and tables. A .db file replaces the database. Continue?'), { okText: 'Import' })) return;
        const fo = new FormData(); fo.append('file', files[0]);
        try { await api(url('/import'), { method: 'POST', formData: fo }); toast('Import complete'); loadDbs(); loadTables(); loadSchemaAndRows(); }
        catch (e) { toast(e.error, 1); }
      }),
      btn('Delete DB', 'small danger', async () => {
        if (!await confirmDlg('Delete database file ' + baseN(SQ.db) + ' and all its data?', true)) return;
        try { await api('/sites/' + site.id + '/sqlite/' + enc(SQ.db), { method: 'DELETE' }); SQ.db = null; SQ.table = null; toast('Database deleted'); loadDbs(); loadTables(); renderRight(); }
        catch (e) { toast(e.error, 1); }
      })));
    if (SQ.table) renderGrid(msg);
    renderSqlPanel(msg);
  };

  const cellTxt = v => v === null || v === undefined
    ? h('i', { class: 'null' }, 'NULL')
    : isBlob(v) ? h('i', { class: 'dim' }, '<blob ' + blobLen(v) + ' bytes>')
    : (typeof v !== 'object' && String(v).length > 60 ? String(v).slice(0, 60) + '\u2026' : v);

  const run = async (sql, okMsg) => {
    try {
      await api(url('/query'), { method: 'POST', body: { sql, confirm: true } });
      if (okMsg) toast(okMsg);
      loadTables(); loadRows();
    } catch (e) { toast(e.error, 1); }
  };

  const renderGrid = (msg) => {
    const rows = SQ.rows, cols = SQ.cols;
    const whereCols = (SQ.schema && SQ.schema.length) ? SQ.schema : cols.map(c => ({ name: c }));
    const thead = h('tr', null,
      cols.map(c => h('th', { class: 'sortable', title: 'Sort by ' + c, onclick: () => { SQ.dir = SQ.sort === c && SQ.dir === 'asc' ? 'desc' : 'asc'; SQ.sort = c; SQ.page = 1; loadRows(); } },
        c + (SQ.sort === c ? (SQ.dir === 'asc' ? ' \u25b2' : ' \u25bc') : ''))),
      h('th', { style: 'width:40px' }, ''));
    const tbody = h('tbody');
    for (const row of rows) {
      tbody.append(h('tr', null,
        cols.map(c => h('td', { class: 'cell', title: 'Click to expand / edit' }, cellTxt(row[c]))),
        h('td', { class: 'right' }, btn('\u2715', 'small danger', async () => {
          if (whereCols.some(c => isBlob(row[c.name]))) return toast('blob columns are read-only — cannot identify this row for delete', 1);
          if (!await confirmDlg('Delete this row?\n' + JSON.stringify(row).slice(0, 200), true)) return;
          run('DELETE FROM ' + idq(SQ.table) + ' WHERE ' + matchCond(whereCols, row) + ';', 'Row deleted');
        }))));
    }
    const filterSel = h('select', { class: 'small' }, h('option', { value: '' }, 'all columns'), cols.map(c => h('option', { value: c, selected: SQ.col === c }, c)));
    const filterIn = h('input', { class: 'small', placeholder: 'contains\u2026', value: SQ.q });
    const addTr = h('tr', { class: 'addrow' });
    const showAdd = () => {
      if (addTr.parentNode) return;
      addTr.innerHTML = '';
      const sc_ = (SQ.schema && SQ.schema.length) ? SQ.schema : cols.map(c => ({ name: c, type: '' }));
      const inps = sc_.map(c => {
        const blobC = /BLOB/i.test(c.type || '');
        const i = h('input', { class: 'small', placeholder: (c.pk ? 'PK ' : '') + (blobC ? '<blob read-only>' : (c.type || 'value')), disabled: blobC });
        addTr.append(h('td', null, i)); return i;
      });
      addTr.append(h('td', { class: 'right' }, btn('+', 'small primary', async () => {
        const cn = [], vals = [];
        sc_.forEach((c, i) => {
          if (/BLOB/i.test(c.type || '')) return; // blob columns are read-only
          const v = inps[i].value.trim();
          if (v === '' && c.pk) return; // let autoincrement fill it
          cn.push(idq(c.name)); vals.push(v === '' ? (c.pk ? 'NULL' : "''") : lit(v));
        });
        if (!cn.length) return toast('Nothing to insert', 1);
        await run('INSERT INTO ' + idq(SQ.table) + ' (' + cn.join(',') + ') VALUES (' + vals.join(',') + ');', 'Row added');
      })));
      tbody.append(addTr);
    };
    // click-to-expand cell -> inline textarea -> UPDATE via query endpoint
    tbody.querySelectorAll('td.cell').forEach((td, i) => {
      td.addEventListener('click', async () => {
        if (td.dataset.exp) return;
        td.dataset.exp = '1';
        const row = rows[Math.floor(i / cols.length)], col = cols[i % cols.length], orig = row[col];
        if (isBlob(orig)) { td.dataset.exp = ''; return toast('blob columns are read-only', 1); }
        if (whereCols.some(c => isBlob(row[c.name]))) { td.dataset.exp = ''; return toast('blob columns are read-only — cannot identify this row for edit', 1); }
        const ta = h('textarea', { class: 'cellta', spellcheck: false });
        ta.value = orig == null ? '' : String(orig);
        const done = () => { td.dataset.exp = ''; td.innerHTML = ''; td.append(cellTxt(orig)); };
        const ok = btn('Save', 'small primary', async () => {
          const val = ta.value === '' ? null : ta.value;
          try {
            await api(url('/query'), { method: 'POST', body: { sql: 'UPDATE ' + idq(SQ.table) + ' SET ' + idq(col) + ' = ' + lit(val) + ' WHERE ' + matchCond(whereCols, row) + ';', confirm: true } });
            toast('Cell updated'); loadRows();
          } catch (e) { toast(e.error, 1); done(); }
        });
        td.innerHTML = '';
        td.append(ta, h('div', { class: 'row' }, ok, btn('Cancel', 'small', done)));
        ta.focus();
      });
    });
    right.append(h('div', { class: 'card gridcard' },
      h('div', { class: 'gridbar' },
        h('b', { class: 'mono' }, SQ.table),
        SQ.schema && SQ.schema.length ? h('span', { class: 'dim schemarow' }, SQ.schema.map(c => c.name + (c.type ? ':' + c.type : '') + (c.pk ? ' \u2018' : '')).join(' \u00b7 ')) : null,
        h('span', { class: 'grow' }), filterSel, filterIn,
        btn('Filter', 'small', () => { SQ.col = filterSel.value; SQ.q = filterIn.value; SQ.page = 1; loadRows(); }),
        btn('Clear', 'small', () => { SQ.col = ''; SQ.q = ''; SQ.page = 1; loadRows(); }),
        btn('+ Row', 'small primary', showAdd)),
      h('div', { class: 'gridwrap' }, h('table', { class: 'list grid' }, h('thead', null, thead), tbody)),
      h('div', { class: 'pager' },
        btn('\u2190 Prev', 'small', () => { if (SQ.page > 1) { SQ.page--; loadRows(); } }),
        h('span', { class: 'dim' }, 'page ' + SQ.page + (SQ.total != null ? ' \u00b7 ' + SQ.total + ' rows' : '')),
        btn('Next \u2192', 'small', () => { if (SQ.rows.length >= SQ.perPage) { SQ.page++; loadRows(); } }))),
      msg ? h('div', { class: 'qmsg err' }, msg) : null);
  };

  const renderSqlPanel = (msg) => {
    const ta = h('textarea', { class: 'code sql', rows: 4, spellcheck: false, 'data-testid': 'sqlite-sql', placeholder: 'SELECT * FROM sqlite_master;\n-- writes (INSERT/UPDATE/DELETE) ask for confirmation, then run with confirm:true' });
    const out = h('div', { class: 'sqlout' });
    const rbtn = btn('Run', 'primary', runSQL, 'data-testid', 'sqlite-run');
    async function runSQL() {
      const sql = ta.value.trim(); if (!sql) return;
      const first = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim().split(/[\s;(]+/)[0].toUpperCase();
      const write = !/^(SELECT|WITH|EXPLAIN)$/.test(first);
      if (write && !await confirmDlg('This looks like a write statement (' + (first || sql.slice(0, 12)) + '). Run it against ' + baseN(SQ.db) + '?', true)) return;
      btnDis(rbtn, true, 'Running\u2026');
      try { renderQueryResult(out, await api(url('/query'), { method: 'POST', body: { sql, confirm: write } })); loadTables(); }
      catch (e) { out.innerHTML = ''; out.append(h('div', { class: 'qmsg err' }, e.error || 'query failed')); }
      btnDis(rbtn, false, 'Run');
    }
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runSQL(); });
    right.append(h('div', { class: 'card panel sqlpanel' },
      h('h3', null, 'SQL \u2014 ' + baseN(SQ.db), ' ', h('span', { class: 'hint inline' }, 'Ctrl+Enter runs \u00b7 Single SELECT (or WITH/EXPLAIN) returns rows. Writes (INSERT/UPDATE/DELETE/CREATE…) run multi-statement — confirm required.')),
      ta, h('div', { class: 'row' }, rbtn, msg ? h('span', { class: 'qmsg err inline' }, msg) : null), out));
  };

  const renderQueryResult = (box, res) => {
    box.innerHTML = '';
    const sets = Array.isArray(res && res.results) ? res.results
      : (res && Array.isArray(res.rows)) ? [res]
      : Array.isArray(res) ? [{ rows: res }] : [];
    for (const s of sets) {
      const rows = s.rows || [], cols = s.columns || (rows[0] ? Object.keys(rows[0]) : []);
      if (!cols.length) continue;
      box.append(h('div', { class: 'gridwrap' }, h('table', { class: 'list grid' },
        h('thead', null, h('tr', null, cols.map(c => h('th', null, c)))),
        h('tbody', null, rows.slice(0, 1000).map(r => h('tr', null, cols.map(c => h('td', null, cellTxt(r[c])))))))));
      box.append(h('div', { class: 'dim' }, rows.length + ' row(s)' + (rows.length > 1000 ? ' \u2014 first 1000 shown' : '')));
    }
    if (res && (res.changes != null || res.lastInsertRowid != null))
      box.append(h('div', { class: 'qmsg' }, 'OK \u2014 rows changed: ' + (res.changes ?? 0) + (res.lastInsertRowid != null ? ', last id: ' + res.lastInsertRowid : '')));
    if (!box.children.length) box.append(h('div', { class: 'qmsg' }, 'Executed \u2014 no result set.'));
  };

  loadDbs(); loadTables(); renderRight();
}

/* ---------------- MySQL ---------------- */

async function mysqlPanel(box) {
  const tableBox = h('div');
  const refresh = async () => {
    loading(tableBox);
    let dbs;
    try { dbs = arr(await api('/mysql/dbs'), 'dbs'); }
    catch (e) { tableBox.innerHTML = ''; tableBox.append(empty('MySQL API unavailable: ' + (e.error || e))); return; }
    tableBox.innerHTML = '';
    if (!dbs.length) return tableBox.append(emptyState('mysql', 'No databases', 'Create a MySQL or MariaDB database with a dedicated user.', btn('+ Add Database', 'primary', add)));
    tableBox.append(h('table', { class: 'list' },
      h('thead', null, h('tr', null, h('th', null, 'Database'), h('th', null, 'User'), h('th', null, 'Site'), h('th', { class: 'right' }, 'Actions'))),
      h('tbody', null, dbs.map(d => {
        const sObj = obj(d, 'name');
        const name = typeof d === 'string' ? d : (sObj.name || sObj.db);
        let site = sObj.domain || '\u2014';
        if (sObj.site_id != null && !sObj.domain && S.sites) { const f = S.sites.find(x => x.id === sObj.site_id); if (f) site = f.domain; }
        return h('tr', null, h('td', { class: 'strong mono' }, name), h('td', null, sObj.db_user || sObj.user || '\u2014'), h('td', { class: 'dim' }, site),
          h('td', { class: 'right' },
            btn('Export', 'small', () => dl('/api/mysql/dbs/' + encodeURIComponent(name) + '/export')),
            btn('Import', 'small', async () => {
              const files = await filePicker(false); if (!files.length) return;
              if (!await modal('Import', h('p', { class: 'confmsg' }, 'The .sql script runs against ', h('b', null, name), '. Existing objects may be overwritten. Continue?'), { okText: 'Import' })) return;
              const fo = new FormData(); fo.append('file', files[0]);
              try { await api('/mysql/dbs/' + encodeURIComponent(name) + '/import', { method: 'POST', formData: fo }); toast('Import complete'); }
              catch (e) { toast(e.error, 1); }
            }),
            btn('Delete', 'small danger', async () => {
              if (!await confirmDlg('Drop database ' + name + ' (and its user)?', true)) return;
              try { await api('/mysql/dbs/' + encodeURIComponent(name), { method: 'DELETE' }); toast('Dropped'); refresh(); }
              catch (e) { toast(e.error, 1); }
            })));
      }))));
  };
  box.innerHTML = '';
  box.append(tableBox);
  const add = async () => {
    let sites = []; try { sites = await allSites(); } catch (e) { /* optional */ }
    const f = form([
      { key: 'name', label: 'Database name', required: true },
      { key: 'user', label: 'Database user', required: true },
      { key: 'password', label: 'Password', required: true, gen: true },
      { key: 'site', label: 'Linked site (optional)', type: 'select', options: [{ value: '', label: '\u2014 none \u2014' }].concat(sites.map(s => ({ value: s.id, label: s.domain }))) },
    ]);
    if (!await modal('Add Database', f, { okText: 'Create' })) return;
    const v = f.values();
    const body = { name: v.name, user: v.user, password: v.password };
    if (v.site) body.siteId = Number(v.site);
    try { await api('/mysql/dbs', { method: 'POST', body }); toast('Database created'); refresh(); }
    catch (e) { toast(e.error, 1); }
  };
  box.before(pageHead('MySQL Databases', btn('+ Add Database', 'primary', add)));
  await refresh();
}

function pageMysqlTop(main) { main.append(h('div')); mysqlPanel(main.lastChild); }
function tabMysql(body, site) { const box = h('div'); body.append(box); mysqlPanel(box); }

/* ---------------- cron ---------------- */

const CRON_F = [['minute', 'Minute', '0-59 or *'], ['hour', 'Hour', '0-23 or *'], ['mday', 'Day of month', '1-31 or *'], ['month', 'Month', '1-12 or *'], ['wday', 'Day of week', '0-6 or *']];
const cronRe = /^[\d*,\/\-]+$/;

async function cronPanel(box, siteId) {
  const tableBox = h('div');
  async function edit(cur) {
    let du = (cur && cur.user) || '';
    if (!du) { try { const s = (await allSites()).find(x => String(x.id) === String(siteId)); du = (s && s.site_user) || ''; } catch (e) { /* optional */ } }
    const f = form([
      ...CRON_F.map(([k, l, ph]) => ({ key: k, label: l, placeholder: ph, value: cur ? cur[k] : '*', hint: cur ? '' : ph })),
      { key: 'user', label: 'Run as user', value: du, required: true },
      { key: 'command', label: 'Command', required: true, value: cur && cur.command, placeholder: '/usr/bin/php /home/<user>/htdocs/cron.php' },
      { key: 'comment', label: 'Comment', value: cur && cur.comment },
    ]);
    if (!await modal(cur ? 'Edit Cron Job' : 'Add Cron Job', f, { okText: 'Save' })) return;
    const v = f.values();
    for (const [k] of CRON_F) if (!cronRe.test(String(v[k]).trim())) return toast('Invalid ' + k + ' field: "' + v[k] + '" (use numbers, *, */n, lists, ranges)', 1);
    if (!String(v.command).trim()) return toast('Command required', 1);
    try {
      if (cur) await api('/sites/' + siteId + '/crons/' + cur.id, { method: 'PATCH', body: v });
      else await api('/sites/' + siteId + '/crons', { method: 'POST', body: v });
      toast('Cron saved'); refresh();
    } catch (e) { toast(e.error, 1); }
  }
  const refresh = async () => {
    loading(tableBox);
    let rows;
    try { rows = arr(await api('/sites/' + siteId + '/crons'), 'crons', 'items'); }
    catch (e) { tableBox.innerHTML = ''; tableBox.append(empty('Cron API unavailable: ' + (e.error || e))); return; }
    tableBox.innerHTML = '';
    if (!rows.length) return tableBox.append(emptyState('crons', 'No cron jobs', 'Schedule recurring tasks to run under this site\u2019s system user.', btn('+ Add Cron Job', 'primary', () => edit(null))));
    const tbody = h('tbody');
    for (const c of rows) {
      const on = c.enabled !== 0;
      tbody.append(h('tr', { class: on ? '' : 'disabled-row' },
        h('td', { class: 'mono nowrap' }, [c.minute, c.hour, c.mday, c.month, c.wday].join(' ')),
        h('td', { class: 'dim' }, c.user || '\u2014'),
        h('td', { class: 'mono cmd' }, c.command),
        h('td', { class: 'dim' }, c.comment || ''),
        h('td', null, on ? badge('on', 'green') : badge('off', 'dim')),
        h('td', { class: 'right' },
          btn(on ? 'Disable' : 'Enable', 'small', async () => { try { await api('/sites/' + siteId + '/crons/' + c.id, { method: 'PATCH', body: { enabled: on ? 0 : 1 } }); refresh(); } catch (e) { toast(e.error, 1); } }),
          btn('Edit', 'small', () => edit(c)),
          btn('Delete', 'small danger', async () => {
            if (!await confirmDlg('Delete cron job "' + c.command + '"?', true)) return;
            try { await api('/sites/' + siteId + '/crons/' + c.id, { method: 'DELETE' }); toast('Deleted'); refresh(); } catch (e) { toast(e.error, 1); }
          }))));
    }
    tableBox.append(h('div', { class: 'card' }, h('table', { class: 'list' },
      h('thead', null, h('tr', null, h('th', null, 'Schedule'), h('th', null, 'User'), h('th', null, 'Command'), h('th', null, 'Comment'), h('th', null, 'Status'), h('th', { class: 'right' }, ''))), tbody)));
  };
  box.innerHTML = '';
  box.append(h('div', { class: 'row' }, btn('+ Add Cron Job', 'primary', () => edit(null))), tableBox);
  await refresh();
}

function tabCrons(body, site) { const box = h('div'); body.append(box); cronPanel(box, site.id); }

async function pageCronsTop(main) {
  main.append(pageHead('Cron Jobs'));
  const box = h('div'); main.append(box);
  siteSelect(box, (holder, id) => { holder.innerHTML = ''; const b = h('div'); holder.append(b); cronPanel(b, id); });
}

/* shared site picker for top-level pages */
async function siteSelect(box, renderFor) {
  loading(box);
  let sites;
  try { sites = await allSites(true); } catch (e) { box.innerHTML = ''; box.append(empty(e.error || 'Sites unavailable')); return; }
  box.innerHTML = '';
  if (!sites.length) return box.append(empty('No sites yet \u2014 create a site first.'));
  const sel = h('select', {}, sites.map(s => h('option', { value: s.id }, s.domain)));
  const holder = h('div');
  box.append(h('div', { class: 'card panel pick' }, h('label', { class: 'field inline' }, h('span', { class: 'flab' }, 'Site'), sel)), holder);
  const go = () => renderFor(holder, Number(sel.value));
  sel.addEventListener('change', go);
  go();
}

/* ---------------- logs ---------------- */

async function tabLogs(body, site) {
  const type = h('select', {}, [['access', 'access'], ['error', 'error'], ['fpm', 'fpm (PHP)']].map(o => h('option', { value: o[0] }, o[1])));
  const lines = h('select', {}, [100, 500, 2000].map(n => h('option', { value: n, selected: n === 500 }, String(n))));
  const pre = h('pre', { class: 'code log' }, 'Loading\u2026');
  const load = async () => {
    pre.textContent = 'Loading\u2026';
    try {
      const r = await api('/sites/' + site.id + '/logs?type=' + type.value + '&lines=' + lines.value);
      pre.textContent = typeof r === 'string' ? r : (r.text || (Array.isArray(r.lines) ? r.lines.join('\n') : Array.isArray(r) ? r.join('\n') : ''));
      pre.scrollTop = pre.scrollHeight;
    } catch (e) { pre.textContent = 'Log unavailable: ' + (e.error || e); }
  };
  type.addEventListener('change', load);
  lines.addEventListener('change', load);
  body.append(h('div', { class: 'card panel' }, h('div', { class: 'row' },
    h('label', { class: 'field inline' }, h('span', { class: 'flab' }, 'Log'), type),
    h('label', { class: 'field inline' }, h('span', { class: 'flab' }, 'Lines'), lines),
    btn('Refresh', 'primary small', load)), pre));
  load();
}

/* ---------------- backups ---------------- */

async function backupsPanel(box, site) {
  const tableBox = h('div');
  const refresh = async () => {
    loading(tableBox);
    let list;
    try { list = arr(await api('/sites/' + site.id + '/backups'), 'backups', 'items'); }
    catch (e) { tableBox.innerHTML = ''; tableBox.append(empty('Backups API unavailable: ' + (e.error || e))); return; }
    tableBox.innerHTML = '';
    const rows = list.map(b => typeof b === 'string' ? { file: b } : b);
    if (!rows.length) return tableBox.append(emptyState('backups', 'No backups yet', 'Create one \u2014 files + SQLite copies + MySQL dumps in a single tar.gz.', btn('Create Backup', 'primary', () => doBackup(mk))));
    tableBox.append(h('div', { class: 'card' }, h('table', { class: 'list' },
      h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Size'), h('th', null, 'Created'), h('th', { class: 'right' }, 'Actions'))),
      h('tbody', null, rows.map(r0 => {
        const name = r0.file || r0.name || r0.path;
        return h('tr', null, h('td', { class: 'mono' }, baseN(name)), h('td', { class: 'dim size' }, fmtBytes(r0.size)), h('td', { class: 'dim' }, fmtDate(r0.mtime ?? r0.created_at ?? r0.date)),
          h('td', { class: 'right' },
            btn('Download', 'small', () => dl('/api/sites/' + site.id + '/download?path=' + encodeURIComponent('backups/' + name))),
            btn('Restore', 'small primary', async () => {
              if (!await modal('Restore backup', h('p', { class: 'confmsg' }, 'Restoring ', h('b', null, baseN(name)), ' overwrites current files and databases. Continue?'), { okText: 'Restore' })) return;
              try { await api('/sites/' + site.id + '/restore', { method: 'POST', body: { file: name } }); toast('Restore complete'); } catch (e) { toast(e.error, 1); }
            }),
            btn('Delete', 'small danger', async () => {
              if (!await confirmDlg('Delete backup ' + baseN(name) + '?', true)) return;
              try { await api('/sites/' + site.id + '/backups/' + encodeURIComponent(baseN(name)), { method: 'DELETE' }); toast('Deleted'); refresh(); } catch (e) { toast(e.error, 1); }
            })));
      })))));
  };
  const doBackup = async (b) => {
    btnDis(b, true, 'Backing up\u2026');
    toast('Backup started');
    try { await api('/sites/' + site.id + '/backup', { method: 'POST' }); toast('Backup complete'); }
    catch (e) { toast(e.error, 1); }
    btnDis(b, false, 'Create Backup');
    refresh();
  };
  const mk = btn('Create Backup', 'primary', () => doBackup(mk));
  box.innerHTML = '';
  box.append(pageHead('Backups \u2014 ' + site.domain, mk), tableBox);
  await refresh();
}

function tabBackups(body, site) { const box = h('div'); body.append(box); backupsPanel(box, site); }
function pageBackupsTop(main) {
  main.append(pageHead('Backups'));
  const box = h('div'); main.append(box);
  siteSelect(box, (holder, id) => {
    holder.innerHTML = '';
    const b = h('div'); holder.append(b);
    const site = (S.sites || []).find(x => x.id === id) || { id, domain: 'site ' + id };
    backupsPanel(b, site);
  });
}

/* ---------------- users (admin) ---------------- */

async function pageUsers(main) {
  const box = h('div'); main.append(box);
  const refresh = async () => {
    loading(box);
    let rows;
    try { rows = arr(await api('/users'), 'users'); }
    catch (e) { box.innerHTML = ''; box.append(pageHead('Users'), empty('Users API unavailable: ' + (e.error || e))); return; }
    box.innerHTML = '';
    async function add() {
      const f = form([
        { key: 'username', label: 'Username', required: true },
        { key: 'role', label: 'Role', type: 'select', value: 'editor', options: ['editor', 'admin'] },
        { key: 'password', label: 'Password (min 8 chars)', required: true, gen: true },
      ]);
      if (!await modal('Add User', f, { okText: 'Create' })) return;
      try { await api('/users', { method: 'POST', body: f.values() }); toast('User created'); refresh(); }
      catch (e) { toast(e.error, 1); }
    }
    box.append(pageHead('Users', btn('+ Add User', 'primary', add)), h('div', { class: 'card' },
      h('table', { class: 'list' },
        h('thead', null, h('tr', null, h('th', null, 'ID'), h('th', null, 'Username'), h('th', null, 'Role'), h('th', null, 'Created'), h('th', { class: 'right' }, 'Actions'))),
        h('tbody', null, rows.map(u => h('tr', null,
          h('td', { class: 'dim' }, String(u.id)), h('td', { class: 'strong' }, u.username), h('td', null, badge(u.role, u.role === 'admin' ? 'green' : '')),
          h('td', { class: 'dim' }, fmtDate(u.created_at)),
          h('td', { class: 'right' },
            btn('Change password', 'small', async () => {
              const f2 = form([{ key: 'password', label: 'New password', required: true, gen: true, hint: 'At least 8 characters. All sessions of this user are invalidated.' }]);
              if (!await modal('Password \u2014 ' + u.username, f2, { okText: 'Set' })) return;
              try { await api('/users/' + u.id + '/password', { method: 'POST', body: f2.values() }); toast('Password changed'); } catch (e) { toast(e.error, 1); }
            }),
            btn('Delete', 'small danger', async () => {
              if (!await confirmDlg('Delete user ' + u.username + '?', true)) return;
              try { await api('/users/' + u.id, { method: 'DELETE' }); toast('User deleted'); refresh(); } catch (e) { toast(e.error, 1); }
            }))))))));
  };
  await refresh();
}

/* ---------------- events (admin) ---------------- */

async function pageEvents(main) {
  const filt = h('input', { class: 'small', placeholder: 'filter\u2026' });
  main.append(pageHead('Events', filt));
  const box = h('div', { class: 'card' }); main.append(box);
  loading(box);
  let rows;
  try { rows = arr(await api('/events'), 'events'); }
  catch (e) { box.innerHTML = ''; box.append(empty('Events API unavailable: ' + (e.error || e))); return; }
  let names = {};
  try { for (const u of arr(await api('/users'), 'users')) names[u.id] = u.username; } catch (e) { /* own events page, users may fail */ }
  const tbody = h('tbody');
  const paint = () => {
    tbody.innerHTML = '';
    const q = filt.value.toLowerCase();
    for (const e of rows) {
      if (q && ![e.id, names[e.user_id] ?? e.user_id, e.action, e.details].join(' ').toLowerCase().includes(q)) continue;
      tbody.append(h('tr', null, h('td', { class: 'dim' }, String(e.id)), h('td', { class: 'dim nowrap' }, fmtDate(e.created_at)),
        h('td', null, names[e.user_id] ?? '\u2014'), h('td', { class: 'strong mono' }, e.action),
        h('td', { class: 'dim mono' }, e.details ? String(e.details).slice(0, 160) : '')));
    }
    if (!tbody.children.length) tbody.append(h('tr', null, h('td', { colspan: 5, class: 'dim' }, 'No matching events.')));
  };
  box.innerHTML = '';
  box.append(h('table', { class: 'list' },
    h('thead', null, h('tr', null, h('th', null, 'ID'), h('th', null, 'When'), h('th', null, 'User'), h('th', null, 'Action'), h('th', null, 'Details'))), tbody));
  filt.addEventListener('input', paint);
  paint();
}

/* ---------------- settings (admin) ---------------- */

async function pageSettings(main) {
  main.append(pageHead('Settings'));
  const box = h('div', { class: 'card panel' }); main.append(box);
  loading(box);
  let s = {};
  try { s = obj(await api('/settings')); }
  catch (e) { box.innerHTML = ''; box.append(empty('Settings API unavailable: ' + (e.error || e))); return; }
  const f = form([
    { key: 'backupRetention', label: 'Backup retention (days)', type: 'number', value: s.backupRetention ?? '', placeholder: '14' },
  ]);
  box.innerHTML = '';
  box.append(h('h3', null, 'Panel settings'), f, btn('Save', 'primary', async () => {
    try { await api('/settings', { method: 'PUT', body: f.values() }); toast('Settings saved'); }
    catch (e) { toast(e.error, 1); }
  }));
}

/* ---------------- boot ---------------- */

window.addEventListener('hashchange', () => { stopTimer(); route(); });
(async function init() {
  try { const r = await api('/auth/me'); S.user = obj(r, 'user').user || obj(r, 'user'); }
  catch (e) { S.user = null; }
  if (!location.hash) location.hash = S.user ? '#/' : '#/login';
  route();
})();
