import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt:${salt}:${h}`;
}
export function verifyPassword(pw, stored) {
  const [alg, salt, h] = String(stored).split(':');
  if (alg !== 'scrypt') return false;
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createUser(db, username, password, role = 'editor') {
  if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(username)) throw new Error('invalid username');
  if (String(password).length < 8) throw new Error('password too short');
  const info = db.prepare('INSERT INTO users(username,password_hash,role) VALUES(?,?,?)')
    .run(username, hashPassword(password), role);
  return Number(info.lastInsertRowid);
}

export function createSession(db, userId, ttlMs) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)')
    .run(token, userId, Date.now() + ttlMs);
  return token;
}
export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
export function getSessionUser(db, token) {
  if (!token) return null;
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
  return db.prepare(
    'SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?'
  ).get(token, Date.now()) || null;
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Express middleware factory. Adds req.user / req.sessionToken.
export function authRequired(config) {
  return (req, res, next) => {
    const db = req.app.locals.db;
    const token = parseCookies(req).jlp_session;
    const user = getSessionUser(db, token);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.user = user; req.sessionToken = token;
    next();
  };
}
export function adminRequired(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}
export function sessionCookie(token, maxAgeSec) {
  return `jlp_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
}
