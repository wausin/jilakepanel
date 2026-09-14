import { Router } from 'express';
import path from 'node:path';
import { adminRequired } from '../auth.js';
import { bad, logEvent, DOMAIN_RE, USER_RE, PHP_RE } from '../lib/util.js';

const TYPES = ['php', 'node', 'static', 'proxy'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TARGET_RE = /^https?:\/\/[^\s]+$/;

export default function sitesRouter({ db, system, config }) {
  const router = Router();

  const get = (id) => db.prepare('SELECT * FROM sites WHERE id=?').get(Number(id));
  const confPath = (domain) => path.join(config.vhostDir, `${domain}.conf`);
  const linkPath = (domain) => path.join(config.vhostEnabledDir, `${domain}.conf`);
  const poolPath = (s) => path.join(config.fpmPoolDir, s.php_version, 'fpm', 'pool.d', `${s.site_user}.conf`);
  const socket = (s) => `/run/php/php${s.php_version}-fpm-${s.site_user}.sock`;
  const wwwOf = (d) => (d.startsWith('www.') ? d.slice(4) : `www.${d}`);

  function fill(tpl, vars) {
    let out = tpl;
    for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(String(v ?? ''));
    return out;
  }

  function renderPool(s) {
    return fill(system.readFile(path.join(config.templatesDir, 'fpm-pool.tpl')),
      { siteUser: s.site_user, socket: socket(s), phpVersion: s.php_version });
  }

  function renderVhost(s) {
    const name = s.type === 'php' ? 'vhost-php.tpl' : s.type === 'static' ? 'vhost-static.tpl' : 'vhost-proxy.tpl';
    const tls = !!s.tls;
    const vars = {
      domain: s.domain,
      wwwDomain: wwwOf(s.domain),
      siteUser: s.site_user,
      docroot: s.docroot,
      phpVersion: s.php_version ?? '',
      socket: s.type === 'php' ? socket(s) : '',
      appPort: s.app_port ?? '',
      proxyTarget: s.proxy_target ?? '',
      appUrl: s.type === 'proxy' ? s.proxy_target : `http://127.0.0.1:${s.app_port ?? ''}`,
      accessLog: path.join(config.logDir, `${s.domain}-access.log`),
      errorLog: path.join(config.logDir, `${s.domain}-error.log`),
      listen: tls ? '443 ssl http2' : '80',
      tlsLines: tls
        ? `    ssl_certificate /etc/letsencrypt/live/${s.domain}/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/${s.domain}/privkey.pem;`
        : '',
    };
    const main = fill(system.readFile(path.join(config.templatesDir, name)), vars);
    const redirect = tls
      ? `server {\n    listen 80;\n    server_name ${s.domain} ${wwwOf(s.domain)};\n    return 301 https://${s.domain}$request_uri;\n}\n`
      : `server {\n    listen 80;\n    server_name ${wwwOf(s.domain)};\n    return 301 $scheme://${s.domain}$request_uri;\n}\n`;
    return main + '\n' + redirect;
  }

  // ponytail: raw vhost edits still get clobbered when a re-render happens (now only when
  // phpVersion/appPort/proxyTarget changed, or on TLS); upgrade path = marker-block includes like CloudPanel.
  async function writeSiteFiles(s, { link = true } = {}) {
    if (s.type === 'php' && s.php_version) system.writeFile(poolPath(s), renderPool(s));
    system.writeFile(confPath(s.domain), renderVhost(s));
    if (link) await system.exec('ln', ['-s', confPath(s.domain), linkPath(s.domain)]);
  }

  // Default index so a brand-new site isn't a 404 on first hit: an interactive
  // "site under construction" page instead of an empty docroot.
  function defaultIndex(s) {
    const isPhp = s.type === 'php';
    const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${s.domain} — under construction</title>
<style>
  :root { color-scheme: dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b1220; color: #e5e7eb; overflow: hidden;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    position: relative;
  }
  .bg { position: fixed; inset: -50%; z-index: 0; opacity: .5;
    background:
      radial-gradient(40% 40% at 30% 30%, #16a34a33 0%, transparent 70%),
      radial-gradient(35% 35% at 70% 65%, #0ea5e933 0%, transparent 70%);
    animation: drift 16s ease-in-out infinite alternate; }
  @keyframes drift { from { transform: translate(-3%, -2%) scale(1); } to { transform: translate(3%, 2%) scale(1.08); } }
  .grid-bg { position: fixed; inset: 0; z-index: 0; opacity: .25;
    background-image: linear-gradient(#ffffff08 1px, transparent 1px), linear-gradient(90deg, #ffffff08 1px, transparent 1px);
    background-size: 44px 44px; mask-image: radial-gradient(60% 60% at 50% 45%, #000 30%, transparent 100%); }
  .card {
    position: relative; z-index: 1; text-align: center; padding: 52px 40px; max-width: 520px; margin: 20px;
    background: #111827cc; border: 1px solid #ffffff14; border-radius: 18px;
    box-shadow: 0 24px 70px #0009; backdrop-filter: blur(14px);
    animation: rise .7s cubic-bezier(.2,.7,.2,1) both;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(18px) scale(.97); } to { opacity: 1; transform: none; } }
  .mark { width: 52px; height: 52px; margin: 0 auto 22px; border-radius: 14px;
    background: linear-gradient(135deg, #22c55e, #15803d); display: flex; align-items: center; justify-content: center;
    box-shadow: 0 10px 28px #16a34a55; animation: pulse 2.4s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { box-shadow: 0 10px 28px #16a34a40; } 50% { box-shadow: 0 10px 40px #16a34a80; } }
  .mark svg { display: block; }
  h1 { font-size: 26px; letter-spacing: -.02em; color: #f9fafb; margin-bottom: 8px; }
  .dom { color: #4ade80; font-family: ui-monospace, Consolas, monospace; font-size: 13px; word-break: break-all; }
  p { color: #9ca3af; margin-top: 14px; }
  .status { display: inline-flex; align-items: center; gap: 8px; margin-top: 20px; padding: 7px 16px;
    background: #16a34a14; border: 1px solid #16a34a3d; border-radius: 999px; color: #4ade80; font-size: 13px; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; animation: blink 1.4s ease-in-out infinite; }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
  .meter { height: 6px; border-radius: 999px; background: #ffffff0f; margin-top: 26px; overflow: hidden; }
  .meter > i { display: block; height: 100%; width: 40%; border-radius: inherit;
    background: linear-gradient(90deg, #15803d, #22c55e); animation: slide 1.6s ease-in-out infinite; }
  @keyframes slide { 0% { transform: translateX(-110%); } 100% { transform: translateX(280%); } }
  .tip { margin-top: 26px; padding-top: 18px; border-top: 1px solid #ffffff12; color: #6b7280; font-size: 12.5px; }
  .tip b { color: #9ca3af; font-weight: 600; }
  .foot { margin-top: 18px; color: #475569; font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; }
  @media (max-width: 480px) { .card { padding: 38px 24px; } h1 { font-size: 21px; } }
</style>
</head>
<body>
<div class="bg"></div><div class="grid-bg"></div>
<div class="card">
  <div class="mark"><svg width="26" height="26" viewBox="0 0 16 16" fill="none"><path d="M3 12.5 8 2.5l5 10" stroke="#062812" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.4 9.2h5.2" stroke="#062812" stroke-width="2" stroke-linecap="round"/></svg></div>
  <div class="dom">${s.domain}</div>
  <h1>We&rsquo;re getting things ready</h1>
  <p>This site was just created and hasn&rsquo;t published any content yet. Once the owner uploads their files, this page will be replaced automatically.</p>
  <div class="status"><span class="dot"></span> Server is up &middot; ${isPhp ? 'PHP ' + s.php_version + ' ready' : 'static hosting ready'}</div>
  <div class="meter"><i></i></div>
  <div class="tip">Upload your app via <b>SFTP</b> or the panel&rsquo;s file manager &mdash; docroot is <b>~/htdocs</b>. Delete <b>index.${isPhp ? 'php' : 'html'}</b> to take this page down.</div>
  <div class="foot">Powered by JilakePanel</div>
</div>
</body>
</html>`;
    return isPhp ? { file: 'index.php', content: page } : { file: 'index.html', content: page };
  }

  // Fire-and-forget creation job. Runs after res.json so the HTTP response is
  // never blocked on useradd/nginx. node:sqlite is synchronous, so the DB writes
  // here don't race the request handler.
  async function createSiteJob(site, password) {
    let madeUser = false;
    try {
      madeUser = await system.ensureUser(site.site_user, password);
      await system.exec('mkdir', ['-p', site.docroot]);
      const idx = defaultIndex(site);
      system.writeFile(path.join(site.docroot, idx.file), idx.content);
      await system.exec('chown', ['-R', `${site.site_user}:${site.site_user}`, path.join(config.sitesDir, site.site_user)]);
      await writeSiteFiles(site);
      await system.reloadNginx();
      if (site.type === 'php') await system.reloadFpm(site.php_version);
      db.prepare("UPDATE sites SET status='ready', status_msg=NULL WHERE id=?").run(site.id);
    } catch (e) {
      try {
        if (madeUser) await system.removeUser(site.site_user);
        if (site.type === 'php') await system.exec('rm', ['-f', poolPath(site)]);
        await system.exec('rm', ['-f', confPath(site.domain)]);
        await system.exec('rm', ['-f', linkPath(site.domain)]);
      } catch { /* best-effort rollback; ignore secondary errors */ }
      try {
        db.prepare("UPDATE sites SET status='error', status_msg=? WHERE id=?").run(String(e.message || 'unknown error').slice(0, 500), site.id);
      } catch (e2) { console.error('site-create status update failed', e2); }
    }
  }

  router.get('/sites', (req, res) => {
    res.json(db.prepare('SELECT * FROM sites ORDER BY id').all());
  });

  router.get('/sites/:id', (req, res) => {
    const s = get(req.params.id);
    if (!s) return bad(res, 404, 'not found');
    res.json(s);
  });

  router.post('/sites', adminRequired, async (req, res) => {
    const { domain, type, siteUser, password, phpVersion, nodeVersion, appPort, proxyTarget } = req.body || {};
    if (typeof domain !== 'string' || !DOMAIN_RE.test(domain)) return bad(res, 400, 'invalid domain');
    if (!TYPES.includes(type)) return bad(res, 400, 'invalid type');
    if (typeof siteUser !== 'string' || !USER_RE.test(siteUser)) return bad(res, 400, 'invalid siteUser');
    if (typeof password !== 'string' || password.length < 8) return bad(res, 400, 'password too short');
    if (type === 'php' && !PHP_RE.test(String(phpVersion ?? ''))) return bad(res, 400, 'invalid phpVersion');
    const port = appPort == null ? null : Number(appPort);
    if (type === 'node' && (!Number.isInteger(port) || port < 1 || port > 65535)) return bad(res, 400, 'invalid appPort');
    if (type === 'proxy' && !TARGET_RE.test(String(proxyTarget ?? ''))) return bad(res, 400, 'invalid proxyTarget');
    if (db.prepare('SELECT 1 FROM sites WHERE domain=?').get(domain)) return bad(res, 409, 'domain exists');
    if (db.prepare('SELECT 1 FROM sites WHERE site_user=?').get(siteUser)) return bad(res, 409, 'site user exists');

    const homeDir = path.join(config.sitesDir, siteUser);
    const site = {
      domain, type, site_user: siteUser, docroot: path.join(homeDir, 'htdocs'),
      php_version: type === 'php' ? String(phpVersion) : null,
      node_version: type === 'node' ? (nodeVersion ?? null) : null,
      app_port: type === 'node' ? port : null,
      proxy_target: type === 'proxy' ? String(proxyTarget) : null,
      tls: 0, enabled: 1, status: 'creating',
    };
    // ponytail: PATCH/DELETE are allowed while status is 'creating'|'error'; retry-on-error
    // is a manual delete + recreate for now.
    const info = db.prepare(
      'INSERT INTO sites(domain,type,site_user,docroot,php_version,node_version,app_port,proxy_target,status) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(site.domain, site.type, site.site_user, site.docroot, site.php_version, site.node_version, site.app_port, site.proxy_target, site.status);
    site.id = Number(info.lastInsertRowid);
    logEvent(db, req.user.id, 'site.create', { domain, type, siteUser });
    res.json({ id: site.id, domain, status: 'creating' });
    createSiteJob(site, password).catch((err) => console.error('site-create job failed', err));
  });

  router.patch('/sites/:id', adminRequired, async (req, res) => {
    const old = get(req.params.id);
    if (!old) return bad(res, 404, 'not found');
    const b = req.body || {};
    const sets = [], args = [];
    if (b.phpVersion !== undefined) {
      if (!PHP_RE.test(String(b.phpVersion))) return bad(res, 400, 'invalid phpVersion');
      sets.push('php_version=?'); args.push(String(b.phpVersion));
    }
    if (b.appPort !== undefined) {
      const p = Number(b.appPort);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return bad(res, 400, 'invalid appPort');
      sets.push('app_port=?'); args.push(p);
    }
    if (b.proxyTarget !== undefined) {
      if (!TARGET_RE.test(String(b.proxyTarget))) return bad(res, 400, 'invalid proxyTarget');
      sets.push('proxy_target=?'); args.push(String(b.proxyTarget));
    }
    if (b.enabled !== undefined) { sets.push('enabled=?'); args.push(b.enabled ? 1 : 0); }
    if (!sets.length) return bad(res, 400, 'nothing to update');
    // files + reload first, DB commit last: a file-op failure leaves DB untouched
    const next = { ...old };
    for (let i = 0; i < sets.length; i++) next[sets[i].slice(0, -2)] = args[i];
    const confChanged = old.php_version !== next.php_version || old.app_port !== next.app_port || old.proxy_target !== next.proxy_target;
    try {
      if (confChanged) {
        if (old.php_version && old.php_version !== next.php_version) await system.exec('rm', ['-f', poolPath(old)]);
        await writeSiteFiles(next, { link: false });
      }
      if (b.enabled !== undefined) {
        if (!next.enabled) await system.exec('rm', ['-f', linkPath(next.domain)]);
        else if (!old.enabled) await system.exec('ln', ['-s', confPath(next.domain), linkPath(next.domain)]);
      }
      await system.reloadNginx();
      if (next.type === 'php' && old.php_version !== next.php_version) await system.reloadFpm(next.php_version);
      db.prepare(`UPDATE sites SET ${sets.join(',')} WHERE id=?`).run(...args, old.id);
      const site = get(old.id);
      logEvent(db, req.user.id, 'site.patch', { domain: site.domain, ...b });
      res.json(site);
    } catch (e) { return bad(res, 500, e.message); }
  });

  router.delete('/sites/:id', adminRequired, async (req, res) => {
    const site = get(req.params.id);
    if (!site) return bad(res, 404, 'not found');
    const purge = !!(req.body && req.body.purge);
    try {
      await system.exec('rm', ['-f', linkPath(site.domain)]);
      await system.exec('rm', ['-f', confPath(site.domain)]);
      if (site.type === 'php' && site.php_version) await system.exec('rm', ['-f', poolPath(site)]);
      await system.reloadNginx();
      if (purge) await system.removeUser(site.site_user);
    } catch (e) { return bad(res, 500, e.message); }
    db.prepare('DELETE FROM sites WHERE id=?').run(site.id);
    logEvent(db, req.user.id, 'site.delete', { domain: site.domain, purge });
    res.json({ ok: true });
  });

  router.get('/sites/:id/vhost', (req, res) => {
    const site = get(req.params.id);
    if (!site) return bad(res, 404, 'not found');
    try { res.json({ content: system.readFile(confPath(site.domain)) }); }
    catch (e) { return bad(res, 500, e.message); }
  });

  router.put('/sites/:id/vhost', adminRequired, async (req, res) => {
    const site = get(req.params.id);
    if (!site) return bad(res, 404, 'not found');
    const content = String((req.body || {}).content ?? '');
    if (!content.trim()) return bad(res, 400, 'empty content');
    const p = confPath(site.domain);
    let old;
    try { old = system.readFile(p); } catch (e) { return bad(res, 500, e.message); }
    try {
      system.writeFile(p, content);
      await system.reloadNginx();
    } catch (e) {
      system.writeFile(p, old);
      try { await system.reloadNginx(); } catch { /* nginx still broken; file rollback committed */ }
      return bad(res, 400, e.message);
    }
    logEvent(db, req.user.id, 'site.vhost', { domain: site.domain });
    res.json({ ok: true });
  });

  router.post('/sites/:id/tls', adminRequired, async (req, res) => {
    const site = get(req.params.id);
    if (!site) return bad(res, 404, 'not found');
    const email = String((req.body || {}).email ?? '');
    if (!EMAIL_RE.test(email)) return bad(res, 400, 'invalid email');
    try {
      await system.certIssue(site.domain, email);
      db.prepare('UPDATE sites SET tls=1 WHERE id=?').run(site.id);
      const fresh = get(site.id);
      system.writeFile(confPath(fresh.domain), renderVhost(fresh));
      await system.reloadNginx();
      logEvent(db, req.user.id, 'site.tls', { domain: site.domain, email });
      res.json({ ok: true });
    } catch (e) { return bad(res, 500, e.message); }
  });

  router.get('/sites/:id/tls', async (req, res) => {
    const site = get(req.params.id);
    if (!site) return bad(res, 404, 'not found');
    const cert = path.join('/etc/letsencrypt/live', site.domain, 'cert.pem');
    const r = await system.exec('openssl', ['x509', '-enddate', '-noout', '-in', cert]);
    if (r.code !== 0) return res.json({ tls: false });
    const m = /notAfter=(.+)/.exec(r.stdout);
    res.json({ tls: true, expires: m ? m[1].trim() : null });
  });

  return router;
}
