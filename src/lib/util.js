// shared helpers for routes
export function bad(res, status, msg) { return res.status(status).json({ error: msg }); }

export function logEvent(db, userId, action, details) {
  db.prepare('INSERT INTO events(user_id,action,details) VALUES(?,?,?)')
    .run(userId ?? null, action, details ? JSON.stringify(details) : null);
}

// jail a user-supplied relative path inside root; throws on escape (symlinks included)
import path from 'node:path';
import fs from 'node:fs';
export function jail(root, rel) {
  const abs = path.resolve(root, String(rel ?? '.'));
  const normRoot = path.resolve(root);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) throw new Error('path escape denied');
  const ci = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const rootReal = ci(fs.realpathSync(normRoot));
  // target may not exist yet: realpath nearest existing ancestor, rejoin the remainder
  let cur = abs, tail = [];
  while (true) {
    try { cur = fs.realpathSync(cur); break; }
    catch (e) {
      if (e.code !== 'ENOENT' || cur === path.dirname(cur)) throw e;
      tail.unshift(path.basename(cur)); cur = path.dirname(cur);
    }
  }
  const targetReal = ci(path.join(cur, ...tail));
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) throw new Error('path escape denied');
  return abs;
}

export const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
export const USER_RE = /^[a-z][a-z0-9_-]{1,29}$/;
export const PHP_RE = /^8\.[0-9]$|^7\.[0-4]$/;
