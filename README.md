# JilakePanel

Web control panel for Ubuntu/Debian VPS — CloudPanel-style, but with what CloudPanel never had:
**first-class SQLite management** (browse tables, edit rows, run SQL, import/export, per-site backups).

Stack: Node.js >= 22.13 (built-in `node:sqlite`), Express 5, vanilla-JS SPA. Two deps total
(`express`, `busboy`). Manages: Linux site users, nginx vhosts, PHP-FPM pools, Let's Encrypt,
cron, MySQL/MariaDB, file manager, logs, backups.

## Install (Ubuntu 22.04/24.04, root)

```bash
curl -fsSL https://raw.githubusercontent.com/YOU/jilakepanel/main/bin/install.sh | bash
```

Or manual:

```bash
node --version                      # >= 22.13, else: apt install nodejs via NodeSource
git clone <repo> /opt/jilakepanel && cd /opt/jilakepanel
npm install --omit=dev
JLP_ADMIN_USER=admin JLP_ADMIN_PASSWORD='change-me-123' node src/server.js
```

Panel on port 9443. Access via IP, then lock down: firewall to your admin IPs, or front it with
nginx + basic auth. Put behind TLS ASAP (self-signed fine: `openssl req -x509 -newkey rsa:2048 ...`
in front via nginx `proxy_pass`).

## systemd

`bin/jilakepanel.service` ships ready — copy to `/etc/systemd/system/`, set
`EnvironmentFile=/etc/jilakepanel.env`, `systemctl enable --now jilakepanel`.

## Dev (any OS)

```bash
npm install
JLP_DRYRUN=1 npm start    # FakeSystem: no real OS calls; UI + API + SQLite all real
npm test                  # 38 tests, no root needed
```

Windows/Linux/macOS for dev. Real nginx/PHP/user ops need Ubuntu/Debian.

## Env

`JLP_PORT` `JLP_HOST` `JLP_DATA_DIR` `JLP_SITES_DIR` `JLP_VHOST_DIR` `JLP_LOG_DIR`
`JLP_ADMIN_USER` `JLP_ADMIN_PASSWORD` `JLP_DRYRUN=1`

## Docs

Architecture, API contract, conventions: [AGENTS.md](AGENTS.md).
