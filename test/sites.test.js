import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { config as baseConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { System, FakeSystem } from '../src/system.js';
import { createUser, createSession, verifyPassword, sessionCookie, authRequired } from '../src/auth.js';
import sitesRouter from '../src/routes/sites.js';

let server, base, cookie, system, db, cfg, siteId;

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlp-sites-'));
  const publicDir = path.join(dataDir, 'pub');
  fs.mkdirSync(publicDir, { recursive: true });
  system = new FakeSystem();
  cfg = { ...baseConfig, dataDir, publicDir };
  db = openDb(cfg.dataDir);
  // mirrors server.js createApp() auth/mount pattern; createApp also boots sibling
  // routers (databases/files) that other agents are editing concurrently.
  const app = express();
  app.locals.db = db; app.locals.system = system; app.locals.config = cfg;
  app.use(express.json());
  const api = express.Router();
  api.post('/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username ?? ''));
    if (!u || !verifyPassword(String(password ?? ''), u.password_hash)) return res.status(401).json({ error: 'invalid credentials' });
    const token = createSession(db, u.id, cfg.sessionTtlMs);
    res.setHeader('Set-Cookie', sessionCookie(token, Math.floor(cfg.sessionTtlMs / 1000)));
    res.json({ user: { id: u.id, username: u.username, role: u.role } });
  });
  const authed = express.Router();
  authed.use(authRequired(cfg));
  api.use(authed);
  api.use(sitesRouter({ db, system, config: cfg }));
  app.use('/api', api);
  for (const t of ['vhost-php.tpl', 'vhost-proxy.tpl', 'vhost-static.tpl', 'fpm-pool.tpl']) {
    const p = path.join(cfg.templatesDir, t);
    system.writeFile(p, fs.readFileSync(p, 'utf8'));
  }
  createUser(db, 'admin', 'sup3rsecret', 'admin');
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(r => server.close(r)));

async function api(p, opts = {}) {
  const res = await fetch(base + p, {
    ...opts,
    headers: { 'content-type': 'application/json', cookie: cookie || '', ...(opts.headers || {}) },
  });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function login() {
  cookie = '';
  const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'sup3rsecret' }) });
  assert.equal(r.status, 200);
}
const hasCall = (file, ...needles) => system.calls.some(c => c.file === file && needles.every(n => c.args.includes(n)));
const vhostPath = (domain) => path.join(cfg.vhostDir, `${domain}.conf`);
const linkPath = (domain) => path.join(cfg.vhostEnabledDir, `${domain}.conf`);

async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 5));
  }
}

test('create php site: returns creating then ready, db row, system calls, vhost + fpm files', async () => {
  await login();
  const r = await api('/api/sites', {
    method: 'POST',
    body: JSON.stringify({ domain: 'example.com', type: 'php', siteUser: 'example', password: 'sup3rsecret', phpVersion: '8.3' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'creating');
  assert.equal(r.body.domain, 'example.com');
  siteId = r.body.id;
  await waitFor(() => db.prepare('SELECT status FROM sites WHERE id=?').get(siteId)?.status === 'ready');
  const row = db.prepare('SELECT * FROM sites WHERE id=?').get(siteId);
  assert.equal(row.status, 'ready');
  assert.equal(row.status_msg, null);
  assert.equal(row.domain, 'example.com');
  assert.equal(row.type, 'php');
  assert.equal(row.php_version, '8.3');
  assert.equal(row.docroot, path.join(cfg.sitesDir, 'example', 'htdocs'));

  assert.ok(hasCall('chpasswd'), 'chpasswd');
  assert.ok(hasCall('usermod', '-aG', 'www-data', 'example'), 'usermod');
  assert.ok(hasCall('mkdir', '-p', row.docroot), 'mkdir docroot');
  assert.ok(hasCall('chown', '-R', 'example:www-data', path.join(cfg.sitesDir, 'example')), 'chown');
  assert.ok(hasCall('ln', '-s', vhostPath('example.com'), linkPath('example.com')), 'ln -s');
  assert.ok(hasCall('nginx', '-t'), 'nginx -t');
  assert.ok(hasCall('systemctl', 'reload', 'nginx'), 'reload nginx');
  assert.ok(hasCall('systemctl', 'reload', 'php8.3-fpm'), 'reload fpm');

  const vhost = system.files.get(vhostPath('example.com'));
  assert.ok(vhost, 'vhost conf written');
  assert.ok(vhost.includes(`root ${row.docroot};`), 'vhost has docroot');
  assert.ok(vhost.includes('fastcgi_pass unix:/run/php/php8.3-fpm-example.sock;'), 'vhost has fastcgi socket');
  assert.ok(vhost.includes('server_name www.example.com;'), 'www redirect block');

  const pool = system.files.get(path.join(cfg.fpmPoolDir, '8.3', 'fpm', 'pool.d', 'example.conf'));
  assert.ok(pool && pool.includes('user = example') && pool.includes('pm.max_children = 5'), 'fpm pool conf');
  assert.ok(pool.includes('listen = /run/php/php8.3-fpm-example.sock'), 'pool listen path without unix: prefix (Debian php-fpm rejects unix:)');

  const index = system.files.get(path.join(row.docroot, 'index.php'));
  assert.ok(index && index.includes('under construction') && index.includes('example.com'), 'default maintenance index written');
});

test('validation: bad domain 400, missing phpVersion 400, duplicate 409', async () => {
  const badDomain = await api('/api/sites', {
    method: 'POST', body: JSON.stringify({ domain: 'not a domain', type: 'static', siteUser: 'x1', password: 'sup3rsecret' }),
  });
  assert.equal(badDomain.status, 400);
  const noPhpVer = await api('/api/sites', {
    method: 'POST', body: JSON.stringify({ domain: 'a.example.com', type: 'php', siteUser: 'x2', password: 'sup3rsecret' }),
  });
  assert.equal(noPhpVer.status, 400);
  const dup = await api('/api/sites', {
    method: 'POST', body: JSON.stringify({ domain: 'example.com', type: 'static', siteUser: 'x3', password: 'sup3rsecret' }),
  });
  assert.equal(dup.status, 409);
  const dupUser = await api('/api/sites', {
    method: 'POST', body: JSON.stringify({ domain: 'b.example.com', type: 'static', siteUser: 'example', password: 'sup3rsecret' }),
  });
  assert.equal(dupUser.status, 409);
  for (const reserved of ['root', 'www-data', 'admin', 'backup']) {
    const r = await api('/api/sites', {
      method: 'POST', body: JSON.stringify({ domain: `${reserved}.example.com`, type: 'static', siteUser: reserved, password: 'sup3rsecret' }),
    });
    assert.equal(r.status, 400, `reserved user ${reserved} must be rejected`);
    assert.equal(r.body.error, 'reserved system username');
  }
  createUser(db, 'bob', 'sup3rsecret', 'editor');
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'bob', password: 'sup3rsecret' }) });
  const forbidden = await api('/api/sites', {
    method: 'POST', body: JSON.stringify({ domain: 'c.example.com', type: 'static', siteUser: 'x4', password: 'sup3rsecret' }),
  });
  assert.equal(forbidden.status, 403);
  await login();
});

test('list + get + 404', async () => {
  const list = await api('/api/sites');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].status, 'ready');
  assert.ok('status_msg' in list.body[0], 'status_msg present in list');
  const got = await api(`/api/sites/${siteId}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.status, 'ready');
  assert.equal((await api('/api/sites/9999')).status, 404);
});

test('PATCH disable removes symlink; enable recreates', async () => {
  const off = await api(`/api/sites/${siteId}`, { method: 'PATCH', body: JSON.stringify({ enabled: 0 }) });
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, 0);
  assert.ok(hasCall('rm', '-f', linkPath('example.com')), 'rm -f symlink');
  const before = system.calls.length;
  const on = await api(`/api/sites/${siteId}`, { method: 'PATCH', body: JSON.stringify({ enabled: 1 }) });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, 1);
  assert.ok(system.calls.slice(before).some(c => c.file === 'ln' && c.args.includes(linkPath('example.com'))), 're-link');
});

test('PATCH phpVersion re-renders pool+vhost and reloads new fpm', async () => {
  const pool83 = path.join(cfg.fpmPoolDir, '8.3', 'fpm', 'pool.d', 'example.conf');
  const pool82 = path.join(cfg.fpmPoolDir, '8.2', 'fpm', 'pool.d', 'example.conf');
  const filesBefore = system.files.size;
  const callsBefore = system.calls.length;
  const r = await api(`/api/sites/${siteId}`, { method: 'PATCH', body: JSON.stringify({ phpVersion: '8.2' }) });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT php_version FROM sites WHERE id=?').get(siteId).php_version, '8.2');
  assert.ok(system.files.get(pool82)?.includes('php8.2-fpm-example.sock') || system.files.get(pool82), 'new pool written');
  assert.ok(system.calls.slice(callsBefore).some(c => c.file === 'systemctl' && c.args.join(' ') === 'reload php8.2-fpm'), 'reloadFpm 8.2');
  assert.ok(system.calls.slice(callsBefore).some(c => c.file === 'rm' && c.args[1] === pool83), 'old pool removed');
  assert.ok(system.files.size > filesBefore, 'vhost/pool re-written');
});

test('PATCH enabled toggle alone does not re-render vhost/pool files', async () => {
  const filesBefore = system.files.size;
  const r = await api(`/api/sites/${siteId}`, { method: 'PATCH', body: JSON.stringify({ enabled: 0 }) });
  assert.equal(r.status, 200);
  assert.equal(system.files.size, filesBefore, 'no writeFile during enabled-only toggle');
  await api(`/api/sites/${siteId}`, { method: 'PATCH', body: JSON.stringify({ enabled: 1 }) });
});

test('GET vhost read returns current conf', async () => {
  const r = await api(`/api/sites/${siteId}/vhost`);
  assert.equal(r.status, 200);
  assert.ok(r.body.content.includes('server_name example.com'), 'vhost content');
});

test('editor RBAC: PATCH and DELETE /sites/:id are 403', async () => {
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'bob', password: 'sup3rsecret' }) });
  assert.equal((await api(`/api/sites/${siteId}`, { method: 'PATCH', body: JSON.stringify({ enabled: 0 }) })).status, 403);
  assert.equal((await api(`/api/sites/${siteId}`, { method: 'DELETE', body: JSON.stringify({}) })).status, 403);
  await login();
});

test('PUT vhost rollback on nginx -t failure', async () => {
  const p = vhostPath('example.com');
  const original = system.files.get(p);
  system.stub('nginx', { code: 1, stderr: 'syntax error' });
  const r = await api(`/api/sites/${siteId}/vhost`, { method: 'PUT', body: JSON.stringify({ content: 'server { bogus' }) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /syntax error/);
  assert.equal(system.files.get(p), original, 'vhost rolled back to original');
  system.results.delete('nginx');
});

test('tls: issue cert, vhost gets 443 block, GET tls parses expiry', async () => {
  const badEmail = await api(`/api/sites/${siteId}/tls`, { method: 'POST', body: JSON.stringify({ email: 'nope' }) });
  assert.equal(badEmail.status, 400);
  const r = await api(`/api/sites/${siteId}/tls`, { method: 'POST', body: JSON.stringify({ email: 'admin@example.com' }) });
  assert.equal(r.status, 200);
  // FakeSystem publicIp -> null (dryrun): apex-only, www skipped
  assert.ok(hasCall('certbot', '--nginx', '-d', 'example.com'), 'certbot apex');
  assert.ok(!system.calls.some(c => c.file === 'certbot' && c.args.includes('www.example.com')), 'www skipped without public ip');
  assert.deepEqual(r.body.skipped, ['www.example.com']);
  assert.equal(db.prepare('SELECT tls FROM sites WHERE id=?').get(siteId).tls, 1);
  const vhost = system.files.get(vhostPath('example.com'));
  assert.ok(vhost.includes('ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;'), 'tls vhost');
  system.stub('openssl', { code: 1 });
  assert.equal((await api(`/api/sites/${siteId}/tls`)).body.tls, false);
  system.stub('openssl', { code: 0, stdout: 'notAfter=Jan  1 00:00:00 2027 GMT\n' });
  const s = await api(`/api/sites/${siteId}/tls`);
  assert.equal(s.body.tls, true);
  assert.equal(s.body.expires, 'Jan  1 00:00:00 2027 GMT');
});

test('writeFile creates missing parent dirs on disk', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jlp-wf-'));
  const real = new System();
  const p = path.join(tmp, 'a', 'b', 'c.conf');
  real.writeFile(p, 'x');
  assert.ok(fs.existsSync(p), 'file written');
  assert.equal(fs.readFileSync(p, 'utf8'), 'x', 'content matches');
});

test('site-create failure path: status error, rollback cleans user + files', async () => {
  await login();
  system.createUsers = true;
  system.stub('nginx', { code: 1, stderr: 'boom' });
  const r = await api('/api/sites', {
    method: 'POST',
    body: JSON.stringify({ domain: 'rollback.example.com', type: 'php', siteUser: 'rollback', password: 'sup3rsecret', phpVersion: '8.3' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'creating');
  await waitFor(() => db.prepare("SELECT status FROM sites WHERE domain='rollback.example.com'")?.get()?.status === 'error');
  const row = db.prepare('SELECT * FROM sites WHERE domain=?').get('rollback.example.com');
  assert.equal(row.status, 'error');
  assert.match(row.status_msg, /boom/);
  assert.ok(hasCall('userdel', '-r', '-f', 'rollback'), 'userdel ran');
  assert.ok(hasCall('rm', '-f', path.join(cfg.fpmPoolDir, '8.3', 'fpm', 'pool.d', 'rollback.conf')), 'pool rm -f ran');
  assert.ok(hasCall('rm', '-f', vhostPath('rollback.example.com')), 'vhost rm -f ran');
  assert.ok(hasCall('rm', '-f', linkPath('rollback.example.com')), 'symlink rm -f ran');
  assert.equal(db.prepare("SELECT 1 FROM sites WHERE domain=? AND status='ready'").get('rollback.example.com'), undefined, 'no ready row');
  system.results.delete('nginx');
  system.createUsers = false;
});

test('duplicate domain still 409 synchronously, no row added', async () => {
  const countBefore = db.prepare('SELECT COUNT(*) c FROM sites WHERE domain=?').get('rollback.example.com').c;
  const r = await api('/api/sites', {
    method: 'POST',
    body: JSON.stringify({ domain: 'rollback.example.com', type: 'static', siteUser: 'rollback2', password: 'sup3rsecret' }),
  });
  assert.equal(r.status, 409);
  const countAfter = db.prepare('SELECT COUNT(*) c FROM sites WHERE domain=?').get('rollback.example.com').c;
  assert.equal(countAfter, countBefore, 'no row added');
});

test('ensureUser returns created/existing correctly', async () => {
  const sys = new FakeSystem();
  sys.createUsers = false;
  assert.equal(await sys.ensureUser('u1', 'pw'), false, 'existing user -> false');
  sys.createUsers = true;
  assert.equal(await sys.ensureUser('u2', 'pw'), true, 'created user -> true');
});

test('DELETE purge: userdel + row gone', async () => {
  const r = await api(`/api/sites/${siteId}`, { method: 'DELETE', body: JSON.stringify({ purge: true }) });
  assert.equal(r.status, 200);
  assert.ok(hasCall('userdel', '-r', '-f', 'example'), 'userdel');
  assert.equal(db.prepare('SELECT 1 FROM sites WHERE id=?').get(siteId), undefined);
  assert.equal((await api(`/api/sites/${siteId}`)).status, 404);
});
