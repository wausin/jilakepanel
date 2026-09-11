import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

export const config = {
  root,
  port: Number(process.env.JLP_PORT) || 9443,
  host: process.env.JLP_HOST || '0.0.0.0',
  dataDir: process.env.JLP_DATA_DIR || path.join(root, 'data'),
  // Linux targets; on dev box these are overridden by env / unused (FakeSystem)
  sitesDir: process.env.JLP_SITES_DIR || '/home',
  vhostDir: process.env.JLP_VHOST_DIR || '/etc/nginx/sites-available/jlp',
  vhostEnabledDir: process.env.JLP_VHOST_ENABLED_DIR || '/etc/nginx/sites-enabled',
  fpmPoolDir: process.env.JLP_FPM_POOL_DIR || '/etc/php',
  logDir: process.env.JLP_LOG_DIR || '/var/log/jlp',
  templatesDir: path.join(root, 'templates'),
  publicDir: path.join(root, 'public'),
  sessionTtlMs: 1000 * 60 * 60 * 12,
  adminUser: process.env.JLP_ADMIN_USER || null,
  adminPassword: process.env.JLP_ADMIN_PASSWORD || null,
};
