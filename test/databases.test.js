import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { FakeSystem } from '../src/system.js';
import { createUser } from '../src/auth.js';

let server, base, cookie, sitesDir, fake, panelDb;

function enc(rel) { return encodeURIComponent(rel); }

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlp-db-test-'));
  sitesDir = path.join(dataDir, 'home');
  const publicDir = path.join(dataDir, 'pub');
  fs.mkdirSync(publicDir, { recursive: true });
  fake = new FakeSystem();
  const app = createApp({ config: { dataDir, publicDir, sitesDir }, system: fake });
  panelDb = app.locals.db;
  createUser(panelDb, 'admin', 'sup3rsecret', 'admin');
  createUser(panelDb, 'bob', 'sup3rsecret', 'editor');

  const home = path.join(sitesDir, 'tuser');
  fs.mkdirSync(path.join(home, 'dbs'), { recursive: true });
  const sdb = new DatabaseSync(path.join(home, 'dbs', 'app.db'));
  sdb.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)');
  sdb.exec("INSERT INTO users(name) VALUES('alice'),('bob'),('carol')");
  sdb.close();

  panelDb.prepare("INSERT INTO sites(domain,type,site_user,docroot) VALUES('t.test','php','tuser',?)")
    .run(path.join(home, 'htdocs'));

  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'sup3rsecret' }) });
});
after(() => new Promise(r => server.close(r)));

async function api(p, opts = {}) {
  const res = await fetch(base + p, {
    ...opts,
    headers: { 'content-type': 'application/json', cookie: cookie || '', ...(opts.headers || {}) },
  });
  const setc = res.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null), text: null, res };
}
async function raw(p, opts = {}) {
  const res = await fetch(base + p, opts);
  return { status: res.status, text: await res.text(), cd: res.headers.get('content-disposition') };
}

const DB = enc('dbs/app.db');

test('sqlite discovery lists dbs/app.db', async () => {
  const r = await api('/api/sites/1/sqlite');
  assert.equal(r.status, 200);
  const e = r.body.find(x => x.name === 'dbs/app.db');
  assert.ok(e, JSON.stringify(r.body));
  assert.ok(e.size > 0 && typeof e.mtime === 'number');
});

test('unknown site 404', async () => {
  assert.equal((await api('/api/sites/999/sqlite')).status, 404);
});

test('tables', async () => {
  const r = await api(`/api/sites/1/sqlite/${DB}/tables`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [{ name: 'users', type: 'table', rows: '3' }]);
});

test('rows + pagination', async () => {
  const r = await api(`/api/sites/1/sqlite/${DB}/table/users/rows?page=1&perPage=50`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.columns, ['id', 'name']);
  assert.equal(r.body.total, 3);
  assert.equal(r.body.rows.length, 3);
  const p2 = await api(`/api/sites/1/sqlite/${DB}/table/users/rows?page=2&perPage=2`);
  assert.equal(p2.body.rows.length, 1);
  assert.equal(p2.body.rows[0].name, 'carol');
  const sorted = await api(`/api/sites/1/sqlite/${DB}/table/users/rows?sortBy=name&sortDir=desc`);
  assert.equal(sorted.body.rows[0].name, 'carol');
});

test('rows filter', async () => {
  const r = await api(`/api/sites/1/sqlite/${DB}/table/users/rows?filterCol=name&filterQ=${encodeURIComponent('ali%')}`);
  assert.equal(r.body.total, 1);
  assert.equal(r.body.rows[0].name, 'alice');
  const badCol = await api(`/api/sites/1/sqlite/${DB}/table/users/rows?filterCol=nope&filterQ=x`);
  assert.equal(badCol.status, 400);
});

test('schema + unknown table', async () => {
  const r = await api(`/api/sites/1/sqlite/${DB}/table/users/schema`);
  assert.equal(r.status, 200);
  assert.match(r.body.sql, /CREATE TABLE users/);
  assert.equal(r.body.columns.length, 2);
  assert.ok(Array.isArray(r.body.indexes));
  assert.equal((await api(`/api/sites/1/sqlite/${DB}/table/nope/schema`)).status, 404);
  assert.equal((await api(`/api/sites/1/sqlite/${DB}/table/nope/rows`)).status, 404);
});

test('query select / confirm rules / rejects', async () => {
  const sel = await api(`/api/sites/1/sqlite/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql: 'SELECT * FROM users;' }) });
  assert.equal(sel.status, 200);
  assert.equal(sel.body.results[0].rows.length, 3);
  const updNo = await api(`/api/sites/1/sqlite/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql: "UPDATE users SET name='zed' WHERE name='alice'" }) });
  assert.equal(updNo.status, 400);
  const upd = await api(`/api/sites/1/sqlite/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql: "UPDATE users SET name='zed' WHERE name='alice'", confirm: true }) });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.changes, 1);
  await api(`/api/sites/1/sqlite/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql: "UPDATE users SET name='alice' WHERE name='zed'", confirm: true }) });
  for (const sql of ['PRAGMA table_info(users)', "ATTACH ':memory:' AS x", "VACUUM INTO 'x.db'", 'SELECT 1; PRAGMA user_version']) {
    const r = await api(`/api/sites/1/sqlite/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql, confirm: true }) });
    assert.equal(r.status, 400, sql);
  }
  const err = await api(`/api/sites/1/sqlite/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql: 'SELECT * FROM nope', confirm: true }) });
  assert.equal(err.status, 400);
});

test('query multi-statement read: node:sqlite prepares first stmt only', async () => {
  // ponytail: node:sqlite prepare() compiles only the first statement; trailing `; SELECT 2`
  // is ignored, so a multi-stmt SELECT returns a single result set (200, not 400).
  const r = await api(`/api/sites/1/sqlite/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1 AS a; SELECT 2 AS b' }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 1);
});

test('export', async () => {
  const r = await raw(`/api/sites/1/sqlite/${DB}/export`, { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.match(r.cd, /filename="app\.sql"/);
  assert.match(r.text, /CREATE TABLE users/);
  assert.match(r.text, /INSERT INTO "users"/);
  assert.match(r.text, /'alice'/);
});

test('import .sql round-trip', async () => {
  const ex = await raw(`/api/sites/1/sqlite/${DB}/export`, { headers: { cookie } });
  await api(`/api/sites/1/sqlite/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql: 'DROP TABLE users', confirm: true }) });
  assert.equal((await api(`/api/sites/1/sqlite/${DB}/table/nope/rows`)).status, 404);
  const fd = new FormData();
  fd.append('file', new Blob([ex.text], { type: 'text/plain' }), 'app.sql');
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'sup3rsecret' }) });
  const up = await fetch(`${base}/api/sites/1/sqlite/${DB}/import`, { method: 'POST', body: fd, headers: { cookie } });
  assert.equal(up.status, 200, await up.text());
  const r = await api(`/api/sites/1/sqlite/${DB}/table/users/rows`);
  assert.equal(r.body.total, 3);
});

test('import .db file + backup rename', async () => {
  const src = path.join(os.tmpdir(), `jlp-src-${Date.now()}.db`);
  const s = new DatabaseSync(src);
  s.exec('CREATE TABLE marker(x)');
  s.close();
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(src)]), 'swap.db');
  const up = await fetch(`${base}/api/sites/1/sqlite/${enc('dbs/app.db')}/import`, { method: 'POST', body: fd, headers: { cookie } });
  assert.equal(up.status, 200, await up.text());
  const t = await api(`/api/sites/1/sqlite/${DB}/tables`);
  assert.deepEqual(t.body.map(x => x.name), ['marker']);
  const bak = await raw(`/api/sites/1/sqlite/${DB}/import`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'content-length': '0' } });
  assert.equal(bak.status, 400);
  fs.copyFileSync(path.join(sitesDir, 'tuser', 'dbs', 'app.db.bak'), path.join(sitesDir, 'tuser', 'dbs', 'app.db'));
  fs.rmSync(path.join(sitesDir, 'tuser', 'dbs', 'app.db.bak'));
  const r = await api(`/api/sites/1/sqlite/${DB}/table/users/rows`);
  assert.equal(r.body.total, 3);
});

test('create db file', async () => {
  const r = await api('/api/sites/1/sqlite', { method: 'POST', body: JSON.stringify({ name: 'newdb' }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'dbs/newdb.db');
  assert.ok(fs.existsSync(path.join(sitesDir, 'tuser', 'dbs', 'newdb.db')));
  assert.ok(fake.calls.some(c => c.file === 'chown' && c.args.includes('tuser:tuser')));
  const bad = await api('/api/sites/1/sqlite', { method: 'POST', body: JSON.stringify({ name: 'a/../b' }) });
  assert.equal(bad.status, 400);
});

test('delete db file (admin)', async () => {
  const r = await api(`/api/sites/1/sqlite/${enc('dbs/newdb.db')}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(path.join(sitesDir, 'tuser', 'dbs', 'newdb.db')));
  assert.equal((await api(`/api/sites/1/sqlite/${enc('dbs/newdb.db')}`, { method: 'DELETE' })).status, 404);
});

test('editor cannot import/delete db but can edit rows', async () => {
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'bob', password: 'sup3rsecret' }) });
  assert.equal((await api(`/api/sites/1/sqlite/${DB}`, { method: 'DELETE' })).status, 403);
  const fd = new FormData();
  fd.append('file', new Blob(['SELECT 1;']), 'x.sql');
  assert.equal((await fetch(`${base}/api/sites/1/sqlite/${DB}/import`, { method: 'POST', body: fd, headers: { cookie } })).status, 403);
  const q = await api(`/api/sites/1/sqlite/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql: "UPDATE users SET name='alice' WHERE name='alice'", confirm: true }) });
  assert.equal(q.status, 200);
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'sup3rsecret' }) });
});

test('jail escape rejected', async () => {
  const r = await api(`/api/sites/1/sqlite/${enc('../app.db')}/tables`);
  assert.ok(r.status === 400 || r.status === 404, String(r.status));
  const r2 = await api(`/api/sites/1/sqlite/${DB}/query`, { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) });
  assert.equal(r2.status, 200);
  const r3 = await api(`/api/sites/1/sqlite/${encodeURIComponent('../../etc/passwd')}`, { method: 'DELETE' });
  assert.ok(r3.status === 400 || r3.status === 404, String(r3.status));
  const wrongMethod = await api(`/api/sites/1/sqlite/${DB}/tables`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
});

test('mysql create + list via FakeSystem', async () => {
  fake.stub('mysql', { code: 0, stdout: 'appdb\nmysql\ninformation_schema\n' });
  const r = await api('/api/mysql/dbs');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map(x => x.name), ['appdb']);
  const c = await api('/api/mysql/dbs', { method: 'POST', body: JSON.stringify({ name: 'appdb', user: 'appu', password: 'sup3rsecret', siteId: 1 }) });
  assert.equal(c.status, 200);
  const call = fake.calls.filter(x => x.file === 'mysql').find(x => x.args.some(a => String(a).includes('CREATE DATABASE')));
  assert.ok(call, 'mysql CREATE DATABASE exec');
  assert.match(String(call.args), /GRANT ALL/);
  const row = panelDb.prepare("SELECT * FROM mysql_dbs WHERE name='appdb'").get();
  assert.equal(row.db_user, 'appu');
  assert.equal(row.site_id, 1);
  const badName = await api('/api/mysql/dbs', { method: 'POST', body: JSON.stringify({ name: 'bad;name', user: 'u1', password: 'sup3rsecret' }) });
  assert.equal(badName.status, 400);
  const badPw = await api('/api/mysql/dbs', { method: 'POST', body: JSON.stringify({ name: 'ok_db', user: 'u1', password: "su'p3r secret" }) });
  assert.equal(badPw.status, 400);
});

test('mysql delete + export + import', async () => {
  const ex = await raw('/api/mysql/dbs/appdb/export', { headers: { cookie } });
  assert.equal(ex.status, 200);
  assert.match(ex.cd, /filename="appdb\.sql"/);
  const dump = fake.calls.find(c => c.file === 'mysqldump');
  assert.ok(dump && dump.args.includes('appdb') && dump.args.includes('--no-tablespaces'));
  const im = await raw('/api/mysql/dbs/appdb/import', { method: 'POST', headers: { cookie, 'content-type': 'text/sql' }, body: 'SELECT 1;' });
  assert.equal(im.status, 200);
  const mysqlIm = fake.calls.filter(c => c.file === 'mysql').find(c => c.args[0] === 'appdb' && c.opts?.input === 'SELECT 1;');
  assert.ok(mysqlIm, 'import via input option');
  const d = await api('/api/mysql/dbs/appdb', { method: 'DELETE' });
  assert.equal(d.status, 200);
  assert.ok(fake.calls.some(c => c.file === 'mysql' && String(c.args).includes('DROP DATABASE')));
  assert.equal(panelDb.prepare("SELECT * FROM mysql_dbs WHERE name='appdb'").get(), undefined);
  assert.equal((await api('/api/mysql/dbs/bad;name', { method: 'DELETE' })).status, 400);
});
