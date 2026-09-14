# JilakePanel

Server control panel (CloudPanel-style) for Ubuntu/Debian with first-class **SQLite** management
(the gap CloudPanel leaves open). Node.js >= 22.13 (uses built-in `node:sqlite`), Express 5,
vanilla-JS SPA frontend (no build step). Deps locked to: `express`, `busboy`. Nothing else without
a strong reason.

## Commands

```bash
npm test                 # node --test test/  (all tests, FakeSystem, no root needed)
node --test test/core.test.js   # single file
npm start                # run panel (Linux, root for real system ops)
npm run dev              # watch mode
JLP_DRYRUN=1 npm start   # dev on Windows/mac: FakeSystem, no real OS calls
```

Dev on Windows works: UI + API + panel's own SQLite DB. Only real nginx/PHP/user ops need Linux.

## Architecture

- `src/server.js` — app factory `createApp({config,system,db})`, core routes (auth, users, events,
  settings, system stats). DI via `req.app.locals.{db,system,config}`. `req.user` after auth.
- `src/config.js` — env-driven paths (`JLP_PORT`, `JLP_DATA_DIR`, `JLP_SITES_DIR`, `JLP_VHOST_DIR`, ...).
- `src/db.js` — panel's own SQLite DB + migrations array (append-only).
- `src/auth.js` — scrypt hashes, DB-backed sessions, cookie `jlp_session` (HttpOnly, SameSite=Strict),
  `authRequired` / `adminRequired` middleware.
- `src/system.js` — **System adapter**: every OS mutation goes through `system.exec(file,args)` or the
  high-level helpers (`ensureUser`, `reloadNginx`, `reloadFpm`, `certIssue`, `writeFile`...).
  `FakeSystem` records calls + serves a virtual `files` map — used by all tests. Never call
  `child_process`/`fs` writes to system paths directly in routes; go through the adapter.
- `src/lib/util.js` — `bad(res,status,msg)`, `logEvent`, `jail(root,rel)` path escape guard,
  `DOMAIN_RE`/`USER_RE`/`PHP_RE` validators.
- `src/routes/sites.js` — sites + vhost + FPM pool + TLS (module owner: sites).
- `src/routes/databases.js` — SQLite admin + MySQL/MariaDB (module owner: databases).
- `src/routes/files.js` — file manager, cron, logs, backups (module owner: files).
- `templates/` — nginx vhost + PHP-FPM pool templates (`{{var}}` placeholders).
- `public/` — SPA (index.html, app.js, styles.css), hash-routed, calls `/api/*` with `fetch`.
- `test/` — `node:test` + `assert`, boot app with `createApp({config:{dataDir:tmp,publicDir:tmp},system:new FakeSystem()})`.

## Domain model

Site = Linux system user (`/home/$siteUser`, docroot `/home/$siteUser/htdocs`) + nginx vhost +
optional PHP-FPM pool. Types: `php | node | static | proxy`. Panel stores metadata in its SQLite DB;
nginx/FPM files on disk are rendered from templates. www<->non-www redirect auto. HTTP->HTTPS when
`tls=1`. SQLite DBs are **files discovered under the site home** (usually `~/dbs/*.db`) — that's the
signature feature: browse tables, edit rows, run SQL, import/export per site.

## API contract (all JSON under /api, session cookie auth)

Core: `POST auth/login {username,password}` · `POST auth/logout` · `GET auth/me` ·
`GET|POST /users` (admin) · `POST /users/:id/password` (admin) · `DELETE /users/:id` (admin) ·
`GET /events` (admin) · `GET /system/stats` · `GET|PUT /settings` (admin).

Sites: `GET|POST /sites` · `GET|DELETE /sites/:id` (DELETE body `{purge:true}` removes user+files) ·
`PATCH /sites/:id` (enable/disable/php_version/app_port/proxy_target) ·
`GET|PUT /sites/:id/vhost` (raw nginx conf; validate with `nginx -t` before commit, rollback on fail) ·
`POST /sites/:id/tls {email}` (certbot) · `GET /sites/:id/tls` (status/expiry).
POST /sites body: `{domain, type, siteUser, password, phpVersion?, nodeVersion?, appPort?, proxyTarget?}`.

Databases — SQLite (the differentiator):
`GET /sites/:id/sqlite` (list *.db/*.sqlite under home) · `POST /sites/:id/sqlite {name}` (create file in ~/dbs) ·
`GET /sites/:id/sqlite/:db/tables` · `GET /sites/:id/sqlite/:db/table/:t/rows?page&perPage&filterCol&filterQ` ·
`GET /sites/:id/sqlite/:db/table/:t/schema` · `POST /sites/:id/sqlite/:db/query {sql, confirm}` (multi-stmt; SELECT returns rows (single result set for reads — node:sqlite prepare compiles first stmt only); writes need `confirm:true`; reject PRAGMA/ATTACH/VACUUM-anything-dangerous) ·
`GET /sites/:id/sqlite/:db/export` (dump .sql) · `POST /sites/:id/sqlite/:db/import` (multipart .sql or .db) ·
`DELETE /sites/:id/sqlite/:db`. `:db` param = path relative to site home, must pass `jail()`.

MySQL: `GET|POST /mysql/dbs` {name,user,password} · `DELETE /mysql/dbs/:name` ·
`GET /mysql/dbs/:name/export` · `POST /mysql/dbs/:name/import` (via mysqldump/mysql CLI, socket auth as root).

Files/cron/logs/backups:
`GET /sites/:id/files?path=` (listing) · `GET|PUT /sites/:id/file?path=` (text content) ·
`POST /sites/:id/files/upload?path=` (multipart via busboy) · `DELETE /sites/:id/file?path=` ·
`POST /sites/:id/files/mkdir|rename` · `GET /sites/:id/download?path=` (tar.gz) ·
`GET|POST /sites/:id/crons` + `PATCH|DELETE /sites/:id/crons/:cid` (PATCH accepts `enabled`; disabled jobs sync as `# disabled:` comment lines; synced to /etc/cron.d/jlp-<siteuser>) ·
`GET /crons` (admin; optional `?siteId=`) ·
`GET /sites/:id/logs?type=access|error|fpm&lines=` (admin; tail via `readlines`-style chunked read) ·
`POST /sites/:id/backup` (tar files + sqlite copies + mysqldump → /home/$u/backups/YYMMDD-HHmm.tar.gz) ·
`GET /sites/:id/backups` · `DELETE /sites/:id/backups/:file` (admin) · `POST /sites/:id/restore {file}` ·
retention via setting `backupRetention` (days, minimum 1 — 0/invalid becomes 1).

## Non-negotiables

- **No shell string interpolation** — `exec(file, [args...])` array form only.
- Every path from user input goes through `jail()`; every identifier (table name, domain) validated
  or quoted (`"..."` doubled for SQLite identifiers).
- Auth middleware on every route; `adminRequired` on user/settings mgmt; log mutating actions via `logEvent`.
- Passwords: never in panel DB in plaintext (site user passwords set once via chpasswd, not stored).
- All new behavior ships with a test in `test/<module>.test.js` using `FakeSystem` (+ real temp SQLite
  for DB ops). `npm test` must stay green.
- Keep it boring, keep deps at zero. `ponytail:` comment marks deliberate simplifications + upgrade path.
