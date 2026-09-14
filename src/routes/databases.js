import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import Busboy from 'busboy';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { adminRequired } from '../auth.js';
import { bad, logEvent, jail } from '../lib/util.js';

const DB_EXT_RE = /\.(db|sqlite3?)$/i;
const MYSQL_SYS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function sendErr(res, e) {
  if (e instanceof HttpError) return bad(res, e.status, e.message);
  if (String(e.message).includes('path escape')) return bad(res, 400, 'path escape denied');
  return bad(res, 500, e.message || 'internal error');
}

function wrapDb(handler, { readOnly = false } = {}) {
  return async (req, res) => {
    const { config } = req.app.locals;
    const home = path.join(config.sitesDir, req.jlpSite.site_user);
    let handle = null;
    try {
      const p = jail(home, dbRel(req.params));
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) throw new HttpError(404, 'db file not found');
      handle = new DatabaseSync(p, { readOnly });
      await handler(req, res, handle, p);
    } catch (e) { sendErr(res, e); }
    finally { try { handle?.close(); } catch {} }
  };
}

function dbRel(params) {
  const rel = String(params.db ?? '');
  if (!rel) throw new HttpError(400, 'missing db path');
  return rel;
}

function qid(name) { return `"${String(name).replaceAll('"', '""')}"`; }

function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return String(v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `x'${Buffer.from(v).toString('hex')}'`;
  return `'${String(v).replaceAll("'", "''")}'`;
}

async function tableExists(handle, name) {
  const row = handle.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name);
  if (!row) throw new HttpError(404, 'unknown table');
  return row;
}

function discover(home) {
  const out = [];
  const walk = (dir, depth, rel) => {
    if (depth > 4 || out.length >= 200) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 200) return;
      if (e.isSymbolicLink() || !e.isDirectory()) continue;
      if (depth === 0 && (e.name === 'backups' || e.name === 'tmp')) continue;
      walk(path.join(dir, e.name), depth + 1, rel ? `${rel}/${e.name}` : e.name);
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 200) return;
      if (e.isSymbolicLink() || !e.isFile() || !DB_EXT_RE.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      const st = fs.statSync(abs);
      out.push({ name: rel ? `${rel}/${e.name}` : e.name, size: st.size, mtime: Math.round(st.mtimeMs) });
    }
  };
  if (fs.existsSync(home) && fs.statSync(home).isDirectory()) walk(home, 0, '');
  return out;
}

function upload(req) {
  let file = null;
  const save = new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 5 } });
    bb.on('file', (name, stream, info) => {
      if (name !== 'file') { stream.resume(); return; }
      const ext = path.extname(path.basename(String(info.filename))).toLowerCase();
      const safeExt = (ext === '.sql' || ext === '.db' || ext === '.sqlite' || ext === '.sqlite3') ? ext : '.bin';
      const tmp = path.join(os.tmpdir(), `jlp-up-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
      file = { tmp, filename: info.filename || '' };
      stream.on('limit', () => { fs.rmSync(tmp, { force: true }); done(reject, new HttpError(400, 'file exceeds 100MB limit')); stream.resume(); });
      const ws = fs.createWriteStream(tmp);
      stream.pipe(ws);
      ws.on('error', (e) => done(reject, e));
      ws.on('finish', () => done(resolve));
    });
    bb.on('error', (e) => done(reject, e));
    bb.on('close', () => { if (!file) done(reject, new HttpError(400, 'no file part')); });
    req.pipe(bb);
  });
  return { get file() { return file; }, save };
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export default function databasesRouter({ db, system, config }) {
  const router = new Router();

  const siteHome = (req, res, next) => {
    const site = db.prepare('SELECT * FROM sites WHERE id=?').get(Number(req.params.id));
    if (!site) return bad(res, 404, 'site not found');
    req.jlpSite = site;
    next();
  };

  const list = (req, res) => {
    const home = path.join(config.sitesDir, req.jlpSite.site_user);
    res.json(discover(home));
  };

  const create = async (req, res) => {
    const name = String(req.body?.name ?? '');
    if (!/^[a-z0-9_-]{1,40}$/i.test(name)) return bad(res, 400, 'invalid db name');
    const home = path.join(config.sitesDir, req.jlpSite.site_user);
    const dir = path.join(home, 'dbs');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${name}.db`);
    new DatabaseSync(p).close();
    await system.exec('chown', ['-R', `${req.jlpSite.site_user}:www-data`, p]).catch(() => {});
    logEvent(db, req.user.id, 'sqlite.create', { site: req.jlpSite.id, name });
    const st = fs.statSync(p);
    res.json({ name: `dbs/${name}.db`, size: st.size, mtime: Math.round(st.mtimeMs) });
  };

  const remove = async (req, res) => {
    const home = path.join(config.sitesDir, req.jlpSite.site_user);
    let p, rel = '';
    try {
      rel = dbRel(req.params);
      if (!DB_EXT_RE.test(rel)) return bad(res, 400, 'not a sqlite db file');
      p = jail(home, rel);
      if (!fs.existsSync(p)) return bad(res, 404, 'not found');
    } catch (e) { return sendErr(res, e); }
    fs.rmSync(p, { force: true });
    for (const ext of ['-wal', '-shm']) fs.rmSync(p + ext, { force: true });
    logEvent(db, req.user.id, 'sqlite.delete', { site: req.jlpSite.id, db: rel });
    res.json({ ok: true });
  };

  const tables = wrapDb(async (req, res, handle) => {
    const out = [];
    for (const o of handle.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      let rows = -1;
      if (o.type === 'table') rows = Number(handle.prepare(`SELECT COUNT(*) c FROM ${qid(o.name)}`).get().c);
      out.push({ name: o.name, type: o.type, rows: String(rows) });
    }
    res.json(out);
  }, { readOnly: true });

  const schema = wrapDb(async (req, res, handle) => {
    const t = await tableExists(handle, req.params.t);
    const sql = handle.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(t.name)?.sql ?? null;
    const columns = handle.prepare(`PRAGMA table_info(${qid(t.name)})`).all();
    const indexes = handle.prepare(`PRAGMA index_list(${qid(t.name)})`).all();
    res.json({ name: t.name, type: t.type, sql, columns, indexes });
  }, { readOnly: true });

  const rows = wrapDb(async (req, res, handle) => {
    const t = await tableExists(handle, req.params.t);
    const cols = handle.prepare(`PRAGMA table_info(${qid(t.name)})`).all().map(c => c.name);
    let page = Number(req.query.page) || 1; if (page < 1) page = 1;
    let perPage = Number(req.query.perPage) || 50; perPage = Math.min(500, Math.max(1, perPage));
    let where = '', args = [];
    const { filterCol, filterQ, sortBy, sortDir } = req.query;
    const sort = sortBy || req.query.sort, dir = sortDir || req.query.dir;
    if (filterQ && filterCol) {
      if (!cols.includes(String(filterCol))) throw new HttpError(400, 'unknown filter column');
      where = ` WHERE ${qid(filterCol)} LIKE ?`; args = [String(filterQ)];
    }
    const total = Number(handle.prepare(`SELECT COUNT(*) c FROM ${qid(t.name)}${where}`).get(...args).c);
    let order = '';
    if (sort && cols.includes(String(sort))) order = ` ORDER BY ${qid(sort)} ${String(dir) === 'desc' ? 'DESC' : 'ASC'}`;
    const stmt = handle.prepare(`SELECT * FROM ${qid(t.name)}${where}${order} LIMIT ? OFFSET ?`);
    const list = stmt.all(...args, perPage, (page - 1) * perPage);
    res.json({ columns: cols, rows: list, total, page });
  }, { readOnly: true });

  const query = wrapDb(async (req, res, handle, p) => {
    let sql = String(req.body?.sql ?? '').trim().replace(/;\s*$/, '');
    if (!sql) return bad(res, 400, 'empty sql');
    if (/\b(PRAGMA|ATTACH|DETACH|load_extension|VACUUM\s+INTO|INTO\s+OUTFILE)\b/i.test(sql)) {
      return bad(res, 400, 'statement not allowed');
    }
    const head = sql.replace(/^[\s(]+/, '').slice(0, 20).toUpperCase();
    const isRead = /^(SELECT|WITH|EXPLAIN)/.test(head);
    if (!isRead && req.body?.confirm !== true) return bad(res, 400, 'confirm:true required for write statements');
    if (isRead) {
      // Read path uses a read-only handle: CTE-wrapped writes (WITH ... INSERT)
      // would otherwise execute with no confirm. SQLite enforces it here.
      let ro = null;
      try {
        ro = new DatabaseSync(p, { readOnly: true });
        const st = ro.prepare(sql);
        const r = st.all();
        let columns = [];
        try { columns = st.columns().map(c => c.name); } catch {}
        return res.json({ results: [{ columns, rows: r.slice(0, 1000) }] });
      } catch (e) { return bad(res, 400, e.message); }
      finally { try { ro?.close(); } catch {} }
    }
    try {
      handle.exec(sql);
      const changes = Number(handle.prepare('SELECT changes() c').get().c);
      logEvent(db, req.user.id, 'sqlite.query', { site: req.jlpSite.id, db: dbRel(req.params), write: true, sql: sql.slice(0, 200) });
      res.json({ changes });
    } catch (e) { return bad(res, 400, e.message); }
  });

  const exportDb = wrapDb(async (req, res, handle, p) => {
    const base = path.basename(p).replace(/\.(db|sqlite3?|sqlite)$/i, '').replaceAll('"', '');
    let out = 'BEGIN;\n';
    for (const o of handle.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()) {
      if (o.sql) out += o.sql + ';\n';
      if (o.type !== 'table') continue;
      for (let off = 0; ; off += 200) {
        const chunk = handle.prepare(`SELECT * FROM ${qid(o.name)} LIMIT 200 OFFSET ${off}`).all();
        if (!chunk.length) break;
        const cols = Object.keys(chunk[0]).map(qid).join(', ');
        out += `INSERT INTO ${qid(o.name)} (${cols}) VALUES\n`;
        out += chunk.map(r => `(${Object.values(r).map(lit).join(', ')})`).join(',\n') + ';\n';
        if (chunk.length < 200) break;
      }
    }
    out += 'COMMIT;\n';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.sql"`);
    res.end(out);
  }, { readOnly: true });

  const importDb = async (req, res) => {
    const { config } = req.app.locals;
    const home = path.join(config.sitesDir, req.jlpSite.site_user);
    let rel, p, handle = null, up = null;
    try {
      rel = dbRel(req.params);
      if (!DB_EXT_RE.test(rel)) return bad(res, 400, 'not a sqlite db file');
      if (!String(req.headers['content-type'] || '').startsWith('multipart/form-data')) return bad(res, 400, 'multipart upload required');
      p = jail(home, rel);
      up = upload(req);
      await up.save;
      if (/\.sql$/i.test(up.file.filename)) {
        const sql = fs.readFileSync(up.file.tmp, 'utf8');
        handle = new DatabaseSync(p);
        handle.exec(sql);
      } else if (DB_EXT_RE.test(up.file.filename)) {
        if (fs.existsSync(p)) {
          fs.renameSync(p, p + '.bak');
          for (const ext of ['-wal', '-shm']) fs.rmSync(p + ext, { force: true });
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.copyFileSync(up.file.tmp, p);
        handle = new DatabaseSync(p, { readOnly: true });
        handle.prepare('SELECT count(*) c FROM sqlite_master').get();
      } else {
        return bad(res, 400, 'expected .sql or .db/.sqlite upload');
      }
      logEvent(db, req.user.id, 'sqlite.import', { site: req.jlpSite.id, db: rel, via: /\.sql$/i.test(up.file.filename) ? 'sql' : 'file' });
      res.json({ ok: true });
    } catch (e) { sendErr(res, e); }
    finally { try { handle?.close(); } catch {}; if (up?.file) fs.rmSync(up.file.tmp, { force: true }); }
  };

  const mysqlList = async (req, res) => {
    try {
      const r = await system.exec('mysql', ['-N', '-e', 'SHOW DATABASES']);
      if (r.code !== 0) return bad(res, 500, r.stderr || 'mysql failed');
      const metas = new Map(db.prepare('SELECT * FROM mysql_dbs').all().map(m => [m.name, m]));
      res.json(r.stdout.split('\n').map(s => s.trim()).filter(s => s && !MYSQL_SYS.has(s))
        .map(name => ({ name, meta: metas.get(name) ?? null })));
    } catch (e) { sendErr(res, e); }
  };

  const mysqlCreate = async (req, res) => {
    const { name, user, password, siteId } = req.body || {};
    if (!/^[A-Za-z0-9_]{2,40}$/.test(String(name ?? ''))) return bad(res, 400, 'invalid db name');
    if (!/^[A-Za-z0-9_]{2,40}$/.test(String(user ?? ''))) return bad(res, 400, 'invalid user name');
    const pw = String(password ?? '');
    if (pw.length < 8) return bad(res, 400, 'password too short');
    // ponytail: password embedded into -e string, chars beyond [A-Za-z0-9_] are rejected outright.
    // Upgrade path: write a 0600 --defaults-extra-file temp cnf generated from validated values.
    if (/[^A-Za-z0-9_@#%+.=,-]/.test(pw)) return bad(res, 400, 'password contains unsupported chars');
    const sql = `CREATE DATABASE IF NOT EXISTS \`${name}\`; CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '${pw}'; GRANT ALL ON \`${name}\`.* TO '${user}'@'localhost';`;
    const r = await system.exec('mysql', ['-e', sql]);
    if (r.code !== 0) return bad(res, 500, r.stderr || 'mysql failed');
    db.prepare('INSERT OR IGNORE INTO mysql_dbs(name, db_user, site_id) VALUES(?,?,?)')
      .run(name, user, Number.isInteger(Number(siteId)) ? Number(siteId) : null);
    logEvent(db, req.user.id, 'mysql.create', { name, user });
    res.json({ ok: true });
  };

  const mysqlDelete = async (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9_]{2,40}$/.test(String(name ?? ''))) return bad(res, 400, 'invalid db name');
    if (MYSQL_SYS.has(name)) return bad(res, 403, 'system database');
    const meta = db.prepare('SELECT * FROM mysql_dbs WHERE name=?').get(name);
    const r = await system.exec('mysql', ['-e', `DROP DATABASE IF EXISTS \`${name}\`;`
      + (meta?.db_user ? ` DROP USER IF EXISTS '${meta.db_user}'@'localhost';` : '')]);
    if (r.code !== 0) return bad(res, 500, r.stderr || 'mysql failed');
    db.prepare('DELETE FROM mysql_dbs WHERE name=?').run(name);
    logEvent(db, req.user.id, 'mysql.delete', { name });
    res.json({ ok: true });
  };

  const mysqlExport = async (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9_]{2,40}$/.test(String(name ?? ''))) return bad(res, 400, 'invalid db name');
    if (MYSQL_SYS.has(name)) return bad(res, 403, 'system database');
    const r = await system.exec('mysqldump', ['--no-tablespaces', name]);
    if (r.code !== 0) return bad(res, 500, r.stderr || 'mysqldump failed');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.sql"`);
    res.send(r.stdout);
  };

  const mysqlImport = async (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9_]{2,40}$/.test(String(name ?? ''))) return bad(res, 400, 'invalid db name');
    if (MYSQL_SYS.has(name)) return bad(res, 403, 'system database');
    try {
      let sql;
      if (String(req.headers['content-type'] || '').startsWith('multipart/form-data')) {
        const up = upload(req);
        await up.save;
        sql = fs.readFileSync(up.file.tmp, 'utf8');
        fs.rmSync(up.file.tmp, { force: true });
      } else {
        sql = await collectBody(req);
      }
      const r = await system.exec('mysql', [name], { input: sql });
      if (r.code !== 0) return bad(res, 500, r.stderr || 'mysql import failed');
      logEvent(db, req.user.id, 'mysql.import', { name });
      res.json({ ok: true });
    } catch (e) { sendErr(res, e); }
  };

  const ADMIN_GATED = new Set(['delete', 'import']);
  const METHOD_OF = { delete: 'DELETE', import: 'POST', query: 'POST', tables: 'GET', schema: 'GET', rows: 'GET', export: 'GET' };

  // ponytail: manual tail parse — Express auto-decodes :params, so %2F in :db would break static sub-route matching.
  // Upgrade path: move db ref to ?db= query param and use plain routes.
  const dispatch = (req, res) => {
    let key = 'sub';
    try {
      const m = /^\/sites\/[^/]+\/sqlite\/(.*)$/.exec(req.path);
      if (!m) return bad(res, 404, 'not found');
      const tail = decodeURIComponent(m[1]);
      const sub = /\/table\/([^/]+)\/(schema|rows)$/.exec(tail);
      if (sub) { req.params.db = tail.slice(0, sub.index); req.params.t = sub[1]; key = sub[2]; }
      else {
        const act = /\/(tables|query|export|import)$/.exec(tail);
        if (act) { req.params.db = tail.slice(0, act.index); key = act[1]; }
        else req.params.db = tail;
      }
      if (!req.params.db) return bad(res, 400, 'missing db path');
      if (key === 'sub') {
        if (req.method !== 'DELETE') return bad(res, 404, 'not found');
        key = 'delete';
      }
    } catch { return bad(res, 400, 'bad db path'); }
    if (METHOD_OF[key] !== req.method) return bad(res, 405, 'method not allowed');
    const handler = ({ delete: remove, tables, schema, rows, query, export: exportDb, import: importDb })[key];
    const run = () => Promise.resolve(handler(req, res)).catch(e => sendErr(res, e));
    if (ADMIN_GATED.has(key)) return adminRequired(req, res, run);
    run();
  };

  router.get('/sites/:id/sqlite', siteHome, list);
  router.post('/sites/:id/sqlite', siteHome, create);
  router.all('/sites/:id/sqlite/*db', siteHome, dispatch);

  router.get('/mysql/dbs', adminRequired, mysqlList);
  router.post('/mysql/dbs', adminRequired, mysqlCreate);
  router.delete('/mysql/dbs/:name', adminRequired, mysqlDelete);
  router.get('/mysql/dbs/:name/export', adminRequired, mysqlExport);
  router.post('/mysql/dbs/:name/import', adminRequired, mysqlImport);

  return router;
}
