import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { FakeSystem } from '../src/system.js';
import { createUser } from '../src/auth.js';

let server, base, cookie, appDb;

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlp-test-'));
  const publicDir = path.join(dataDir, 'pub');
  fs.mkdirSync(publicDir, { recursive: true });
  const app = createApp({ config: { dataDir, publicDir }, system: new FakeSystem() });
  appDb = app.locals.db;
  createUser(app.locals.db, 'admin', 'sup3rsecret', 'admin');
  createUser(app.locals.db, 'bob', 'sup3rsecret', 'editor');
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

test('unauthorized without session', async () => {
  cookie = '';
  assert.equal((await api('/api/auth/me')).status, 401);
});

test('login + me + bad password', async () => {
  cookie = '';
  const ok = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'sup3rsecret' }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'admin');
  const me = await api('/api/auth/me');
  assert.equal(me.body.user.username, 'admin');
  const bad = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'wrong1234' }) });
  assert.equal(bad.status, 401);
});

test('admin-only routes enforce role', async () => {
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'bob', password: 'sup3rsecret' }) });
  assert.equal((await api('/api/users')).status, 403);
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'sup3rsecret' }) });
  const users = await api('/api/users');
  assert.equal(users.status, 200);
  assert.equal(users.body.length, 2);
});

test('create user + change password invalidates session', async () => {
  const c = await api('/api/users', { method: 'POST', body: JSON.stringify({ username: 'carol', password: 'sup3rsecret', role: 'editor' }) });
  assert.equal(c.status, 200);
  const carolCookie = cookie; cookie = '';
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'carol', password: 'sup3rsecret' }) });
  const newCookie = cookie;
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'sup3rsecret' }) });
  await api(`/api/users/${c.body.id}/password`, { method: 'POST', body: JSON.stringify({ password: 'changed12345' }) });
  cookie = newCookie;
  assert.equal((await api('/api/auth/me')).status, 401, 'old session must die');
  cookie = '';
  const re = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'carol', password: 'changed12345' }) });
  assert.equal(re.status, 200);
});

test('rate limit: 11th failed login is 429', async (t) => {
  // dedicated app instance so the shared loopback bucket in `before` isn't poisoned
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlp-rl-'));
  const publicDir = path.join(dataDir, 'pub');
  fs.mkdirSync(publicDir, { recursive: true });
  const app2 = createApp({ config: { dataDir, publicDir }, system: new FakeSystem() });
  createUser(app2.locals.db, 'ratelimited', 'sup3rsecret', 'editor');
  const srv = app2.listen(0, '127.0.0.1');
  await new Promise(r => srv.on('listening', r));
  t.after(() => new Promise(r => srv.close(r)));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const call = () => fetch(b + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ratelimited', password: 'wrong1234' }),
  });
  for (let i = 0; i < 10; i++) assert.equal((await call()).status, 401, `attempt ${i}`);
  assert.equal((await call()).status, 429);
});

test('settings + stats', async () => {
  cookie = '';
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'sup3rsecret' }) });
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ backupRetention: '7' }) });
  const s = await api('/api/settings');
  assert.equal(s.body.backupRetention, '7');
  const st = await api('/api/system/stats');
  assert.ok(st.body.hostname);
});

test('migrations are idempotent across reopen', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jlp-mig-'));
  try {
    const db1 = openDb(d);
    const cols = () => db1.prepare('PRAGMA table_info(crons)').all().map(c => c.name);
    assert.ok(cols().includes('enabled'), 'crons.enabled exists after first open');
    assert.ok(db1.prepare('PRAGMA table_info(sites)').all().some(c => c.name === 'status'), 'sites.status exists after first open');
    assert.deepEqual(db1.prepare('SELECT v FROM _migrations ORDER BY v').all().map(r => r.v), [1, 2, 3]);
    db1.close();
    const db2 = openDb(d); // must NOT throw "duplicate column"
    assert.ok(db2.prepare('PRAGMA table_info(crons)').all().some(c => c.name === 'enabled'));
    assert.ok(db2.prepare('PRAGMA table_info(sites)').all().some(c => c.name === 'status'));
    db2.close();
  } finally {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
