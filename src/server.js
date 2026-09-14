import express from 'express';
import os from 'node:os';
import fs from 'node:fs';
import { config as baseConfig } from './config.js';
import { openDb } from './db.js';
import { System, FakeSystem } from './system.js';
import { createUser, createSession, destroySession, getSessionUser, verifyPassword, hashPassword, authRequired, adminRequired, sessionCookie } from './auth.js';
import { bad, logEvent } from './lib/util.js';
import sitesRouter from './routes/sites.js';
import databasesRouter from './routes/databases.js';
import filesRouter from './routes/files.js';

export function createApp(overrides = {}) {
  const config = { ...baseConfig, ...overrides.config };
  const db = overrides.db ?? openDb(config.dataDir);
  const system = overrides.system ?? (process.env.JLP_DRYRUN === '1' ? new FakeSystem() : new System());
  // periodic session sweep (once a minute, not per request)
  const t = setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now()), 60000);
  t.unref();

  const app = express();
  app.disable('x-powered-by');
  app.locals.db = db; app.locals.system = system; app.locals.config = config;
  app.use(express.json({ limit: '2mb' }));

  // simple login rate limit (per ip, in-memory)
  const hits = new Map();
  function rateLimit(req, res, next) {
    const now = Date.now(), key = req.ip;
    const list = (hits.get(key) || []).filter(t => now - t < 60000);
    if (list.length >= 10) return bad(res, 429, 'too many attempts');
    req.incHit = () => {
      list.push(now); hits.set(key, list);
      if (hits.size > 1000) for (const [k, v] of hits) if (!v.some(x => now - x < 60000)) hits.delete(k);
    };
    next();
  }

  const api = express.Router();
  api.post('/auth/login', rateLimit, (req, res) => {
    const { username, password } = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username ?? ''));
    if (!u || !verifyPassword(String(password ?? ''), u.password_hash)) {
      req.incHit();
      return bad(res, 401, 'invalid credentials');
    }
    const token = createSession(db, u.id, config.sessionTtlMs);
    res.setHeader('Set-Cookie', sessionCookie(token, Math.floor(config.sessionTtlMs / 1000)));
    logEvent(db, u.id, 'login');
    res.json({ user: { id: u.id, username: u.username, role: u.role } });
  });

  const authed = express.Router();
  authed.use(authRequired(config));
  authed.post('/auth/logout', (req, res) => { destroySession(db, req.sessionToken); res.json({ ok: true }); });
  authed.get('/auth/me', (req, res) => res.json({ user: req.user }));

  authed.get('/users', adminRequired, (req, res) => {
    res.json(db.prepare('SELECT id,username,role,created_at FROM users').all());
  });
  authed.post('/users', adminRequired, (req, res) => {
    const { username, password, role } = req.body || {};
    try {
      const id = createUser(db, String(username ?? ''), String(password ?? ''), role === 'admin' ? 'admin' : 'editor');
      logEvent(db, req.user.id, 'user.create', { username, role });
      res.json({ id });
    } catch (e) { bad(res, 400, e.message); }
  });
  authed.post('/users/:id/password', adminRequired, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
    if (!u) return bad(res, 404, 'not found');
    if (String(req.body?.password ?? '').length < 8) return bad(res, 400, 'password too short');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(String(req.body.password)), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    logEvent(db, req.user.id, 'user.password', { id: u.id });
    res.json({ ok: true });
  });
  authed.delete('/users/:id', adminRequired, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return bad(res, 400, 'cannot delete self');
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    logEvent(db, req.user.id, 'user.delete', { id });
    res.json({ ok: true });
  });

  authed.get('/events', adminRequired, (req, res) => {
    res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 200').all());
  });
  authed.get('/system/stats', (req, res) => {
    res.json({
      hostname: os.hostname(), platform: process.platform, uptime: os.uptime(),
      loadavg: os.loadavg(), memTotal: os.totalmem(), memFree: os.freemem(),
      cpus: os.cpus().length, node: process.version,
    });
  });
  authed.get('/settings', adminRequired, (req, res) => {
    const out = {}; for (const r of db.prepare('SELECT key,value FROM settings').all()) out[r.key] = r.value;
    res.json(out);
  });
  authed.put('/settings', adminRequired, (req, res) => {
    const stmt = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const [k, v] of Object.entries(req.body || {})) stmt.run(String(k), String(v));
    res.json({ ok: true });
  });

  // module routers (sites/databases/files)
  api.use(authed);
  api.use(sitesRouter({ db, system, config }));
  api.use(databasesRouter({ db, system, config }));
  api.use(filesRouter({ db, system, config }));
  app.use('/api', api);

  app.use(express.static(config.publicDir));
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
    res.status(404).type('text').send('not found');
  });
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'internal error' });
  });
  return app;
}

// CLI: node src/server.js [--port 9443]
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  fs.mkdirSync(app.locals.config.dataDir, { recursive: true });
  if (process.env.JLP_DRYRUN !== '1' && process.platform === 'linux' && app.locals.system instanceof System) {
    for (const dir of [app.locals.config.vhostDir, app.locals.config.logDir]) {
      try { fs.mkdirSync(dir, { recursive: true }); }
      catch (e) { console.log(`warn: could not create ${dir}: ${e.message}`); }
    }
  }
  const empty = app.locals.db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  if (empty && baseConfig.adminUser && baseConfig.adminPassword) {
    createUser(app.locals.db, baseConfig.adminUser, baseConfig.adminPassword, 'admin');
    console.log(`seeded admin user ${baseConfig.adminUser}`);
  }
  if (empty && !baseConfig.adminUser) {
    console.log('no users; set JLP_ADMIN_USER + JLP_ADMIN_PASSWORD env to seed admin');
  }
  app.listen(app.locals.config.port, app.locals.config.host, () =>
    console.log(`jilakepanel on http://${app.locals.config.host}:${app.locals.config.port}`));
}
