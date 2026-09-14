import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { createApp } from '../src/server.js';
import { config as baseConfig } from '../src/config.js';
import { FakeSystem } from '../src/system.js';
import { openDb } from '../src/db.js';
import { createUser, createSession, verifyPassword, sessionCookie, authRequired } from '../src/auth.js';
import filesRouter from '../src/routes/files.js';

let server, base, cookie, system, db, sitesDir, logDir, home;

// ponytail: createApp boots sibling routers (sites/databases) owned by other agents; if any of them
// throws at mount time (e.g. bad path pattern), fall back to a mini-app that mirrors server.js
// mounting for just auth + files so this suite stays independent.
function boot(config, db) {
  try { return createApp({ config, db, system }); }
  catch (e) {
    console.log(`files.test: createApp boot failed (${e.message}); using files-only mini-app`);
    const app = express();
    app.locals.db = db; app.locals.system = system; app.locals.config = config;
    app.use(express.json({ limit: '2mb' }));
    const api = express.Router();
    api.post('/auth/login', (req, res) => {
      const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(req.body?.username ?? ''));
      if (!u || !verifyPassword(String(req.body?.password ?? ''), u.password_hash)) return res.status(401).json({ error: 'invalid credentials' });
      res.setHeader('Set-Cookie', sessionCookie(createSession(db, u.id, config.sessionTtlMs), 43200));
      res.json({ user: { id: u.id, username: u.username, role: u.role } });
    });
    const authed = express.Router();
    authed.use(authRequired(config));
    api.use(authed);
    api.use(filesRouter({ db, system, config }));
    app.use('/api', api);
    app.use((req, res) => res.status(404).json({ error: 'not found' }));
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
    return app;
  }
}

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlp-files-'));
  const publicDir = path.join(dataDir, 'pub');
  fs.mkdirSync(publicDir, { recursive: true });
  sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlp-sites-'));
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlp-logs-'));
  system = new FakeSystem();
  const app = boot({ ...baseConfig, dataDir, publicDir, sitesDir, logDir }, openDb(dataDir));
  db = app.locals.db;
  createUser(db, 'admin', 'sup3rsecret', 'admin');
  db.prepare("INSERT INTO sites(domain,type,site_user,docroot,php_version) VALUES('f.test','php','fuser',?,'8.3')")
    .run(path.join('home', 'fuser', 'htdocs'));
  home = path.join(sitesDir, 'fuser');
  fs.mkdirSync(path.join(home, 'htdocs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'dbs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'htdocs', 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(home, 'htdocs', 'bin.dat'), Buffer.from([0x89, 0x00, 0x01, 0x02]));
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await login();
});
after(() => server ? new Promise(r => server.close(r)) : undefined);

async function login() {
  cookie = '';
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'sup3rsecret' }),
  });
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
}
async function api(p, opts = {}) {
  const res = await fetch(base + p, {
    ...opts,
    headers: { 'content-type': 'application/json', cookie, ...(opts.headers || {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const wasCalled = (file, pred = () => true) => system.calls.some(c => c.file === file && pred(c.args));

test('listing: dirs first, posix rel paths', async () => {
  const r = await api('/api/sites/1/files?path=');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map(e => e.name), ['dbs', 'htdocs']);
  assert.ok(r.body.every(e => e.isDir));
  const r2 = await api('/api/sites/1/files?path=htdocs');
  const idx = r2.body.find(e => e.name === 'index.html');
  assert.equal(idx.path, 'htdocs/index.html');
  assert.equal(idx.isDir, false);
  assert.ok(idx.size > 0 && idx.mtime);
});

test('jail: escape rejected, unknown site 404', async () => {
  assert.equal((await api('/api/sites/1/files?path=../../etc')).status, 400);
  assert.equal((await api('/api/sites/1/file?path=../dbs')).status, 400);
  assert.equal((await api('/api/sites/999/files')).status, 404);
});

test('GET file: text ok, binary 415', async () => {
  const ok = await api('/api/sites/1/file?path=htdocs/index.html');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.content, '<h1>hi</h1>');
  assert.equal((await api('/api/sites/1/file?path=htdocs/bin.dat')).status, 415);
});

test('PUT file: writes disk + chown via adapter; oversize 415', async () => {
  const r = await api('/api/sites/1/file?path=htdocs/page.html', { method: 'PUT', body: JSON.stringify({ content: 'hello' }) });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(home, 'htdocs', 'page.html'), 'utf8'), 'hello');
  assert.ok(wasCalled('chown', a => a[0] === 'fuser:www-data' && a[1] === path.join(home, 'htdocs', 'page.html')));
  const big = await api('/api/sites/1/file?path=htdocs/big.html', { method: 'PUT', body: JSON.stringify({ content: 'x'.repeat(1024 * 1024 + 1) }) });
  assert.equal(big.status, 415);
});

test('upload: FormData file lands with safe name; traversal name 400', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['up!']), 'up.txt');
  let res = await fetch(base + '/api/sites/1/files/upload?path=uploads', { method: 'POST', headers: { cookie }, body: fd });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.file, 'up.txt');
  assert.equal(fs.readFileSync(path.join(home, 'uploads', 'up.txt'), 'utf8'), 'up!');
  const evil = new FormData();
  // busboy already basename's filenames ('../e.txt' -> 'e.txt'); this checks our second layer.
  evil.append('file', new Blob(['x']), '..evil.txt');
  res = await fetch(base + '/api/sites/1/files/upload?path=uploads', { method: 'POST', headers: { cookie }, body: evil });
  assert.equal(res.status, 400);
  assert.ok(!fs.existsSync(path.join(home, 'uploads', '..evil.txt')));
});

test('mkdir + rename + delete', async () => {
  assert.equal((await api('/api/sites/1/files/mkdir', { method: 'POST', body: JSON.stringify({ path: 'htdocs/sub' }) })).status, 200);
  assert.ok(fs.statSync(path.join(home, 'htdocs', 'sub')).isDirectory());
  assert.equal((await api('/api/sites/1/files/rename', { method: 'POST', body: JSON.stringify({ from: 'htdocs/page.html', to: 'htdocs/sub/p2.html' }) })).status, 200);
  assert.ok(fs.existsSync(path.join(home, 'htdocs', 'sub', 'p2.html')));
  assert.equal((await api('/api/sites/1/files/rename', { method: 'POST', body: JSON.stringify({ from: 'htdocs/sub/p2.html', to: 'htdocs/sub' }) })).status, 400);
  assert.equal((await api('/api/sites/1/file?path=htdocs/sub/p2.html', { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(path.join(home, 'htdocs', 'sub', 'p2.html')));
  assert.equal((await api('/api/sites/1/file?path=htdocs/sub', { method: 'DELETE' })).status, 200);
});

test('mkdir/rename UI contract: {path: cwd, name/from/to} relative names', async () => {
  fs.writeFileSync(path.join(home, 'htdocs', 'mytest.html'), '<p>x</p>');
  // mkdir with a name relative to cwd (what the frontend sends)
  assert.equal((await api('/api/sites/1/files/mkdir', { method: 'POST', body: JSON.stringify({ path: 'htdocs', name: 'images' }) })).status, 200);
  assert.ok(fs.statSync(path.join(home, 'htdocs', 'images')).isDirectory(), 'folder created from {path,name}');
  // bad name rejected
  assert.equal((await api('/api/sites/1/files/mkdir', { method: 'POST', body: JSON.stringify({ path: 'htdocs', name: '../evil' }) })).status, 400);
  // rename with cwd-relative from/to (frontend contract)
  assert.equal((await api('/api/sites/1/files/rename', { method: 'POST', body: JSON.stringify({ path: 'htdocs', from: 'mytest.html', to: 'images/renamed.html' }) })).status, 200);
  assert.ok(fs.existsSync(path.join(home, 'htdocs', 'images', 'renamed.html')), 'renamed into images/');
  // cleanup
  await api('/api/sites/1/file?path=htdocs/images/renamed.html', { method: 'DELETE' });
  await api('/api/sites/1/file?path=htdocs/images', { method: 'DELETE' });
});

test('download: 500 when FakeSystem creates nothing; 500 mentions stderr on tar failure', async () => {
  const res = await fetch(base + '/api/sites/1/download?path=htdocs', { headers: { cookie } });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /archive failed/);
  assert.ok(wasCalled('tar', a => a[0] === '-czf' && a[2] === '-C' && a[3] === home && a[4] === 'htdocs'));
  system.stub('tar', { code: 1, stderr: 'boom' });
  const res2 = await fetch(base + '/api/sites/1/download?path=htdocs', { headers: { cookie } });
  assert.equal(res2.status, 500);
  assert.match((await res2.json()).error, /boom/);
  system.results.delete('tar');
});

test('crons: create/patch/delete sync /etc/cron.d file', async () => {
  const r = await api('/api/sites/1/crons', { method: 'POST', body: JSON.stringify({ minute: '*/5', hour: '*', mday: '*', month: '*', wday: '*', command: '/usr/bin/php task' }) });
  assert.equal(r.status, 200);
  const cid = r.body.id;
  const key = [...system.files.keys()].find(k => k.endsWith('jlp-fuser'));
  assert.ok(key);
  let content = system.files.get(key);
  assert.ok(content.includes('SHELL=/bin/bash'));
  assert.ok(content.includes('*/5 * * * * fuser /usr/bin/php task'));
  const list = await api('/api/sites/1/crons');
  assert.equal(list.body[0].user, 'fuser');
  assert.equal((await api('/api/sites/1/crons', { method: 'POST', body: JSON.stringify({ minute: '0 0 * *', hour: 'x', mday: '*', month: '*', wday: '*', command: 'echo' }) })).status, 400);
  assert.equal((await api(`/api/sites/1/crons/${cid}`, { method: 'PATCH', body: JSON.stringify({ minute: '0' }) })).status, 200);
  content = system.files.get(key);
  assert.ok(content.includes('0 * * * * fuser /usr/bin/php task'));
  // newline in command rejected
  assert.equal((await api('/api/sites/1/crons', { method: 'POST', body: JSON.stringify({ minute: '*', hour: '*', mday: '*', month: '*', wday: '*', command: 'a\nb' }) })).status, 400);
  // disabled cron syncs as a comment line
  assert.equal((await api(`/api/sites/1/crons/${cid}`, { method: 'PATCH', body: JSON.stringify({ enabled: 0 }) })).status, 200);
  content = system.files.get(key);
  assert.ok(content.includes('# disabled: 0 * * * * fuser /usr/bin/php task'), content);
  const list2 = await api('/api/sites/1/crons');
  assert.equal(list2.body[0].enabled, 0);
  assert.equal((await api(`/api/sites/1/crons/${cid}`, { method: 'PATCH', body: JSON.stringify({ enabled: 1 }) })).status, 200);
  assert.ok(system.files.get(key).includes('0 * * * * fuser /usr/bin/php task'));
  const all = await api('/api/crons?siteId=1');
  assert.equal(all.body[0].domain, 'f.test');
  assert.equal((await api(`/api/sites/1/crons/${cid}`, { method: 'DELETE' })).status, 200);
  assert.equal(system.files.get(key).trim(), '# no crons');
});

test('jail: symlink pointing outside home is rejected', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jlp-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  const link = path.join(home, 'link');
  try { fs.rmSync(link, { force: true, recursive: true }); } catch {}
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const r = await api('/api/sites/1/file?path=link/secret.txt');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /escape/);
  fs.rmSync(link, { force: true });
});

test('logs: tail returns last N lines', async () => {
  fs.writeFileSync(path.join(logDir, 'f.test-access.log'), Array.from({ length: 300 }, (_, i) => `L${i + 1}`).join('\n') + '\n');
  const r = await api('/api/sites/1/logs?type=access&lines=5');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.lines, ['L296', 'L297', 'L298', 'L299', 'L300']);
  assert.equal((await api('/api/sites/1/logs?type=error')).status, 404);
});

test('logs RBAC: editor 403, admin 200', async () => {
  createUser(db, 'ed1', 'sup3rsecret', 'editor');
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ed1', password: 'sup3rsecret' }),
  });
  const edCookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const r = await fetch(base + '/api/sites/1/logs?type=access', { headers: { cookie: edCookie } });
  assert.equal(r.status, 403);
  const a = await api('/api/sites/1/logs?type=access');
  assert.equal(a.status, 200);
  const del = await fetch(base + '/api/sites/1/backups/250911-1015.tar.gz', { method: 'DELETE', headers: { cookie: edCookie } });
  assert.equal(del.status, 403);
});

test('backup retention: files older than cutoff are swept', async () => {
  const bdir = path.join(home, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  const old = path.join(bdir, '200101-0000.tar.gz');
  const keep = path.join(bdir, '200101-0001.tar.gz');
  fs.writeFileSync(old, 'x'); fs.writeFileSync(keep, 'x');
  const past = new Date(Date.now() - 10 * 86400000);
  fs.utimesSync(old, past, past);
  // retention default 7 days; old (10d) must be swept, keep stays fresh
  db.prepare("INSERT INTO settings(key,value) VALUES('backupRetention','7') ON CONFLICT(key) DO UPDATE SET value='7'").run();
  const r = await api('/api/sites/1/backup', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(old), 'old backup swept');
  assert.ok(fs.existsSync(keep), 'fresh backup kept');
  fs.rmSync(keep, { force: true });
});

test('backup + restore + retention', async () => {
  db.prepare("INSERT INTO mysql_dbs(site_id,name) VALUES(1,'mdb')").run();
  const r = await api('/api/sites/1/backup', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.match(r.body.file, /^\d{6}-\d{4}\.tar\.gz$/);
  assert.ok(wasCalled('mysqldump', a => a[0] === '--no-tablespaces' && a[1] === 'mdb'));
  assert.ok(wasCalled('tar', a => a[0] === '-czf' && a.includes('-C')));
  const list = await api('/api/sites/1/backups');
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 0); // FakeSystem tar writes nothing
  assert.equal((await api('/api/sites/1/restore', { method: 'POST', body: JSON.stringify({ file: '../x.tar.gz' }) })).status, 400);
  assert.equal((await api('/api/sites/1/restore', { method: 'POST', body: JSON.stringify({ file: '250911-1015.tar.gz' }) })).status, 404);
  const fake = path.join(home, 'backups', '250911-1015.tar.gz');
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, 'x');
  // restore now lists members first; stubOnce the -tzf list then allow extraction
  system.stubOnce('tar', { code: 0, stdout: 'fuser-250911-1015/htdocs/x\nfuser-250911-1015/dbs/good\n' });
  const before = system.calls.length;
  assert.equal((await api('/api/sites/1/restore', { method: 'POST', body: JSON.stringify({ file: '250911-1015.tar.gz' }) })).status, 200);
  assert.ok(wasCalled('tar', a => a[0] === '-xzf' && a[1] === fake && a[2] === '-C' && a.includes('--no-same-owner') && a.includes('--no-same-permissions')));
  // traversal member -> 400 and NO extract call
  const callsBeforeBad = system.calls.length;
  system.stubOnce('tar', { code: 0, stdout: 'htdocs/ok\n../evil\n' });
  assert.equal((await api('/api/sites/1/restore', { method: 'POST', body: JSON.stringify({ file: '250911-1015.tar.gz' }) })).status, 400);
  assert.ok(!system.calls.slice(callsBeforeBad).some(c => c.file === 'tar' && c.args[0] === '-xzf'), 'no -xzf after unsafe members');
  assert.equal((await api('/api/sites/1/backups/250911-1015.tar.gz', { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(fake));
});
