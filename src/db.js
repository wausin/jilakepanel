import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN('admin','editor')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sites(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL CHECK(type IN('php','node','static','proxy')),
    site_user TEXT UNIQUE NOT NULL,
    docroot TEXT NOT NULL,
    php_version TEXT,
    node_version TEXT,
    app_port INTEGER,
    proxy_target TEXT,
    tls INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS mysql_dbs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
    name TEXT UNIQUE NOT NULL,
    db_user TEXT
  );
  CREATE TABLE IF NOT EXISTS crons(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    minute TEXT NOT NULL, hour TEXT NOT NULL, mday TEXT NOT NULL,
    month TEXT NOT NULL, wday TEXT NOT NULL,
    user TEXT NOT NULL, command TEXT NOT NULL,
    comment TEXT
  );
  CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
  `,
  `
  ALTER TABLE crons ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
  `,
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'panel.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations(v INTEGER PRIMARY KEY)`);
  const cur = db.prepare('SELECT MAX(v) AS v FROM _migrations').get()?.v ?? 0;
  MIGRATIONS.forEach((sql, i) => {
    if (i >= cur) { db.exec(sql); db.prepare('INSERT INTO _migrations VALUES(?)').run(i); }
  });
  return db;
}
