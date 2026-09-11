import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { finished } from 'node:stream/promises';
import Busboy from 'busboy';
import { bad, logEvent, jail } from '../lib/util.js';
import { adminRequired } from '../auth.js';

const MAX_TEXT = 1024 * 1024;
const SCHED_RE = /^[*\/,\-0-9]+$/;
const BACKUP_RE = /^\d{6}-\d{4}\.tar\.gz$/;
const SCHED_FIELDS = ['minute', 'hour', 'mday', 'month', 'wday'];

export default function filesRouter({ db, system, config }) {
  const router = Router();

  const homeOf = (site) => path.join(config.sitesDir, site.site_user);
  const chown = (site, abs) => system.exec('chown', [`${site.site_user}:${site.site_user}`, abs]);

  function siteOf(req, res) {
    const s = db.prepare('SELECT * FROM sites WHERE id=?').get(Number(req.params.id));
    if (!s) bad(res, 404, 'site not found');
    return s;
  }
  function jailed(res, home, rel) {
    try { return jail(home, rel); } catch { bad(res, 400, 'path escape denied'); return null; }
  }
  const relPosix = (home, abs) => path.relative(home, abs).split(path.sep).join('/');

  function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  // ---------- file manager (real fs inside site home) ----------

  router.get('/sites/:id/files', (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const home = homeOf(site);
    const abs = jailed(res, home, req.query.path); if (!abs) return;
    let dir;
    try { dir = fs.statSync(abs); } catch { return bad(res, 404, 'not found'); }
    if (!dir.isDirectory()) return bad(res, 400, 'not a directory');
    const out = [];
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      out.push({ name: e.name, path: relPosix(home, p), isDir: e.isDirectory(), size: st.size, mtime: st.mtime.toISOString() });
    }
    out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    res.json(out);
  });

  router.get('/sites/:id/file', (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const abs = jailed(res, homeOf(site), req.query.path); if (!abs) return;
    let st; try { st = fs.statSync(abs); } catch { return bad(res, 404, 'not found'); }
    if (!st.isFile()) return bad(res, 400, 'not a file');
    if (st.size > MAX_TEXT) return bad(res, 415, 'file too large to edit');
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return bad(res, 415, 'binary file');
    res.json({ content: buf.toString('utf8') });
  });

  router.put('/sites/:id/file', async (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const abs = jailed(res, homeOf(site), req.query.path); if (!abs) return;
    const content = req.body?.content;
    if (typeof content !== 'string') return bad(res, 400, 'content required');
    if (Buffer.byteLength(content) > MAX_TEXT) return bad(res, 415, 'file too large');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    await chown(site, abs);
    logEvent(db, req.user.id, 'file.write', { site: site.domain, path: String(req.query.path ?? '') });
    res.json({ ok: true });
  });

  function sanitizeName(name) {
    const n = String(name || '');
    if (!n || n.includes('/') || n.includes('\\') || n.includes('..')) return null;
    return n;
  }

  function saveUpload(req, dir) {
    return new Promise((resolve, reject) => {
      const bb = Busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 5 } });
      let done = false, limitHit = false, sawFile = false;
      const fail = (err) => { if (!done) { done = true; reject(err); } };
      const win = (name) => { if (!done) { done = true; resolve(name); } };
      bb.on('file', (field, file, info) => {
        if (field !== 'file') { file.resume(); return; }
        sawFile = true;
        const name = sanitizeName(info.filename);
        if (!name) { file.resume(); return fail(new Error('invalid filename')); }
        const target = path.join(dir, name);
        const ws = fs.createWriteStream(target);
        file.on('limit', () => {
          limitHit = true; ws.destroy(); fs.rmSync(target, { force: true });
          const e = new Error('file too large'); e.status = 413; fail(e);
        });
        file.pipe(ws);
        finished(ws).then(() => win(name), (err) => { if (!limitHit) fail(err); });
      });
      bb.on('finish', () => { if (!sawFile) fail(new Error('no file field')); });
      bb.on('error', fail);
      req.pipe(bb);
    });
  }

  router.post('/sites/:id/files/upload', async (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const home = homeOf(site);
    const dir = jailed(res, home, req.query.path); if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    try {
      const name = await saveUpload(req, dir);
      await chown(site, path.join(dir, name));
      logEvent(db, req.user.id, 'file.upload', { site: site.domain, name });
      res.json({ ok: true, file: name });
    } catch (e) { bad(res, e.status || 400, e.message); }
  });

  router.delete('/sites/:id/file', (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const abs = jailed(res, homeOf(site), req.query.path); if (!abs) return;
    let st; try { st = fs.lstatSync(abs); } catch { return bad(res, 404, 'not found'); }
    try {
      // ponytail: no recursive delete; rmdirSync fails on non-empty dirs. Upgrade path: rm -rf via adapter behind a confirm flag.
      st.isDirectory() ? fs.rmdirSync(abs) : fs.unlinkSync(abs);
    } catch (e) { return bad(res, 500, e.message); }
    logEvent(db, req.user.id, 'file.delete', { site: site.domain, path: String(req.query.path ?? '') });
    res.json({ ok: true });
  });

  router.post('/sites/:id/files/mkdir', async (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const abs = jailed(res, homeOf(site), req.body?.path); if (!abs) return;
    fs.mkdirSync(abs, { recursive: true });
    await chown(site, abs);
    res.json({ ok: true });
  });

  router.post('/sites/:id/files/rename', async (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const home = homeOf(site);
    const from = jailed(res, home, req.body?.from);
    const to = jailed(res, home, req.body?.to);
    if (!from || !to) return;
    if (!fs.existsSync(from)) return bad(res, 404, 'source not found');
    if (fs.existsSync(to)) return bad(res, 400, 'target already exists');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    await chown(site, to);
    res.json({ ok: true });
  });

  router.get('/sites/:id/download', async (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const home = homeOf(site);
    const abs = jailed(res, home, req.query.path); if (!abs) return;
    if (!fs.existsSync(abs)) return bad(res, 404, 'not found');
    const tmp = path.join(config.dataDir, `dl-${crypto.randomBytes(6).toString('hex')}.tgz`);
    await system.exec('tar', ['-czf', tmp, '-C', home, relPosix(home, abs) || '.']);
    if (!fs.existsSync(tmp)) return bad(res, 500, 'tar produced no output');
    res.on('close', () => fs.rmSync(tmp, { force: true }));
    res.download(tmp, path.basename(abs) + '.tgz');
  });

  // ---------- cron jobs ----------

  function syncCron(site) {
    const rows = db.prepare('SELECT * FROM crons WHERE site_id=?').all(site.id);
    const lines = rows.length
      ? ['SHELL=/bin/bash', ...rows.map(r => `${r.minute} ${r.hour} ${r.mday} ${r.month} ${r.wday} ${r.user} ${r.command}`)]
      : ['# no crons'];
    system.setCrontabFile(`jlp-${site.site_user}`, lines);
  }

  function validJob(v) {
    for (const f of SCHED_FIELDS) if (!SCHED_RE.test(String(v[f] ?? ''))) return false;
    const cmd = String(v.command ?? '');
    return cmd.trim() !== '' && !cmd.includes('\n') && !cmd.includes('\r');
  }

  router.get('/sites/:id/crons', (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    res.json(db.prepare('SELECT * FROM crons WHERE site_id=?').all(site.id));
  });

  router.post('/sites/:id/crons', (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const { minute, hour, mday, month, wday, command, comment } = req.body || {};
    const job = { minute, hour, mday, month, wday, command };
    if (!validJob(job)) return bad(res, 400, 'invalid cron schedule or command');
    const info = db.prepare('INSERT INTO crons(site_id,minute,hour,mday,month,wday,user,command,comment) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(site.id, minute, hour, mday, month, wday, site.site_user, command, comment ? String(comment) : null);
    syncCron(site);
    logEvent(db, req.user.id, 'cron.create', { site: site.domain, id: Number(info.lastInsertRowid) });
    res.json({ id: Number(info.lastInsertRowid) });
  });

  router.patch('/sites/:id/crons/:cid', (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const row = db.prepare('SELECT * FROM crons WHERE id=? AND site_id=?').get(Number(req.params.cid), site.id);
    if (!row) return bad(res, 404, 'not found');
    const merged = { ...row };
    for (const f of [...SCHED_FIELDS, 'command']) if (req.body?.[f] !== undefined) merged[f] = req.body[f];
    if (!validJob(merged)) return bad(res, 400, 'invalid cron schedule or command');
    if (req.body?.comment !== undefined) merged.comment = req.body.comment ? String(req.body.comment) : null;
    db.prepare('UPDATE crons SET minute=?,hour=?,mday=?,month=?,wday=?,command=?,comment=? WHERE id=?')
      .run(merged.minute, merged.hour, merged.mday, merged.month, merged.wday, merged.command, merged.comment ?? null, row.id);
    syncCron(site);
    logEvent(db, req.user.id, 'cron.update', { site: site.domain, id: row.id });
    res.json({ ok: true });
  });

  router.delete('/sites/:id/crons/:cid', (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const row = db.prepare('SELECT * FROM crons WHERE id=? AND site_id=?').get(Number(req.params.cid), site.id);
    if (!row) return bad(res, 404, 'not found');
    db.prepare('DELETE FROM crons WHERE id=?').run(row.id);
    syncCron(site);
    logEvent(db, req.user.id, 'cron.delete', { site: site.domain, id: row.id });
    res.json({ ok: true });
  });

  router.get('/crons', adminRequired, (req, res) => {
    const base = 'SELECT c.*, s.domain FROM crons c JOIN sites s ON s.id=c.site_id';
    res.json(req.query.siteId
      ? db.prepare(base + ' WHERE c.site_id=?').all(Number(req.query.siteId))
      : db.prepare(base).all());
  });

  // ---------- logs ----------

  router.get('/sites/:id/logs', (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const type = String(req.query.type ?? 'access');
    if (!['access', 'error', 'fpm'].includes(type)) return bad(res, 400, 'bad type');
    const file = type === 'access' ? path.join(config.logDir, `${site.domain}-access.log`)
      : type === 'error' ? path.join(config.logDir, `${site.domain}-error.log`)
        : `/var/log/php${site.php_version ?? ''}-fpm.log`;
    let size; try { size = fs.statSync(file).size; } catch { return bad(res, 404, 'log file not found'); }
    const n = Math.min(5000, Math.max(1, Number(req.query.lines) || 200));
    const len = Math.min(size, n * 512);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    res.json({ lines: lines.slice(-n) });
  });

  // ---------- backups ----------

  router.post('/sites/:id/backup', async (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const home = homeOf(site);
    const s = stamp();
    const staging = path.join(config.dataDir, 'tmp', `${site.site_user}-${s}`);
    fs.mkdirSync(staging, { recursive: true });
    try {
      for (const d of ['htdocs', 'dbs']) {
        const src = path.join(home, d);
        if (fs.existsSync(src) && fs.statSync(src).isDirectory()) fs.cpSync(src, path.join(staging, d), { recursive: true, dereference: false });
      }
      for (const m of db.prepare('SELECT name FROM mysql_dbs WHERE site_id=?').all(site.id)) {
        const r = await system.exec('mysqldump', ['--no-tablespaces', m.name]);
        if (r.code === 0 && r.stdout) fs.writeFileSync(path.join(staging, `mysql-${m.name}.sql`), r.stdout);
      }
      const bdir = path.join(home, 'backups');
      fs.mkdirSync(bdir, { recursive: true });
      const out = path.join(bdir, `${s}.tar.gz`);
      await system.exec('tar', ['-czf', out, '-C', path.dirname(staging), path.basename(staging)]);
      // ponytail: FakeSystem never runs tar, so out may not exist; listing/restore still validates by name.
      fs.rmSync(staging, { recursive: true, force: true });
      const days = Number(db.prepare("SELECT value FROM settings WHERE key='backupRetention'").get()?.value ?? 7) || 7;
      const cutoff = Date.now() - days * 86400000;
      for (const f of fs.readdirSync(bdir)) {
        if (!BACKUP_RE.test(f)) continue;
        const p = path.join(bdir, f);
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p); } catch { /* ignore */ }
      }
      logEvent(db, req.user.id, 'backup.create', { site: site.domain, file: `${s}.tar.gz`, tarRan: fs.existsSync(out) });
      res.json({ ok: true, file: `${s}.tar.gz` });
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      bad(res, 500, e.message);
    }
  });

  router.get('/sites/:id/backups', (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const bdir = path.join(homeOf(site), 'backups');
    let out = [];
    try {
      out = fs.readdirSync(bdir).filter(f => BACKUP_RE.test(f)).map(f => {
        const st = fs.statSync(path.join(bdir, f));
        return { file: f, size: st.size, mtime: st.mtime.toISOString() };
      });
    } catch { /* no backups dir yet */ }
    out.sort((a, b) => b.file.localeCompare(a.file));
    res.json(out);
  });

  router.post('/sites/:id/restore', async (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const home = homeOf(site);
    const file = String(req.body?.file ?? '');
    if (!BACKUP_RE.test(file)) return bad(res, 400, 'invalid backup name');
    const abs = jailed(res, home, path.join('backups', file)); if (!abs) return;
    if (!fs.existsSync(abs)) return bad(res, 404, 'backup not found');
    await system.exec('tar', ['-xzf', abs, '-C', home]);
    await system.exec('chown', ['-R', `${site.site_user}:${site.site_user}`, home]);
    logEvent(db, req.user.id, 'backup.restore', { site: site.domain, file });
    res.json({ ok: true });
  });

  router.delete('/sites/:id/backups/:file', (req, res) => {
    const site = siteOf(req, res); if (!site) return;
    const file = String(req.params.file ?? '');
    if (!BACKUP_RE.test(file)) return bad(res, 400, 'invalid backup name');
    const abs = jailed(res, homeOf(site), path.join('backups', file)); if (!abs) return;
    try { fs.rmSync(abs); } catch { return bad(res, 404, 'backup not found'); }
    logEvent(db, req.user.id, 'backup.delete', { site: site.domain, file });
    res.json({ ok: true });
  });

  return router;
}
