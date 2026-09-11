#!/usr/bin/env bash
# JilakePanel installer — Ubuntu 22.04/24.04, Debian 12, run as root.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

REPO="${JLP_REPO:-https://github.com/YOU/jilakepanel.git}"
DIR=/opt/jilakepanel

# Node >= 22.13 (for node:sqlite)
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJ=$(node -p 'process.versions.node.split(".")[0]')
  MIN=$(node -p 'process.versions.node.split(".")[1]')
  [ "$MAJ" -gt 22 ] || { [ "$MAJ" -eq 22 ] && [ "$MIN" -ge 13 ]; } && NEED_NODE=0
fi
if [ "$NEED_NODE" = 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

apt-get install -y git nginx php8.3-fpm mariadb-server certbot python3-certbot-nginx

if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR" && npm install --omit=dev

UMASK_ARG=""
if [ ! -f /etc/jilakepanel.env ]; then
  PW=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)
  cat > /etc/jilakepanel.env <<EOF
JLP_ADMIN_USER=admin
JLP_ADMIN_PASSWORD=$PW
JLP_HOST=0.0.0.0
JLP_PORT=9443
EOF
  echo "admin password: $PW  (also in /etc/jilakepanel.env)"
fi
chmod 600 /etc/jilakepanel.env

cp bin/jilakepanel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now jilakepanel
echo "panel up on port 9443 — LOCK IT DOWN (firewall/TLS) before daily use"
