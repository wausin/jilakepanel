import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { FakeSystem } from '../src/system.js';
import { createUser } from '../src/auth.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

// Boots the panel in-process against a FakeSystem + temp data/sites dirs. No root,
// no real OS calls, no external server process. The real `public/` + `templates/`
// are served so the actual SPA and vhost/FPM templates are exercised.
export async function start() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jlp-e2e-'));
  const dataDir = path.join(tmp, 'data');
  const sitesDir = path.join(tmp, 'sites');
  const logDir = path.join(tmp, 'logs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(sitesDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const system = new FakeSystem();
  const config = {
    dataDir,
    sitesDir,
    publicDir: path.join(repoRoot, 'public'),
    templatesDir: path.join(repoRoot, 'templates'),
    logDir,
    vhostDir: path.join(tmp, 'nginx'),
    vhostEnabledDir: path.join(tmp, 'nginx-enabled'),
    fpmPoolDir: path.join(tmp, 'fpm'),
  };

  const app = createApp({ config, system });
  const db = app.locals.db;

  // seed admin user (login via the SPA)
  createUser(db, 'admin', 'sup3rsecret', 'admin');

  // seed ONE site with real filesystem structure under the temp sitesDir.
  const docroot = path.join(sitesDir, 'demo', 'htdocs');
  fs.mkdirSync(docroot, { recursive: true });
  fs.writeFileSync(path.join(docroot, 'index.php'), '<?php echo \'hi\'; ?>\n');

  const dbsDir = path.join(sitesDir, 'demo', 'dbs');
  fs.mkdirSync(dbsDir, { recursive: true });
  const appDb = new DatabaseSync(path.join(dbsDir, 'app.db'));
  appDb.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users(name) VALUES('alice'),('bob');");
  appDb.close();

  db.prepare(
    'INSERT INTO sites(domain,type,site_user,docroot,php_version,tls,enabled) VALUES(?,?,?,?,?,?,?)'
  ).run('demo.test', 'php', 'demo', docroot, '8.3', 0, 1);

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { url, server, close, tmp, db };
}
