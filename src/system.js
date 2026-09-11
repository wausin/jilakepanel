import { execFile } from 'node:child_process';
import fs from 'node:fs';

// All OS mutation goes through this adapter. Routes must take it from
// req.app.locals.system so tests/dev can swap in FakeSystem.
export class System {
  async exec(file, args = [], opts = {}) {
    return new Promise((resolve) => {
      execFile(file, args, { timeout: opts.timeout ?? 60000, input: opts.input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({
          code: err ? (err.code ?? 1) : 0,
          stdout: stdout || '', stderr: stderr || '',
        }));
    });
  }
  async ok(file, args, opts) { const r = await this.exec(file, args, opts); if (r.code !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${r.stderr || r.stdout}`); return r; }
  isLinux() { return process.platform === 'linux'; }

  // --- high-level ops (all through exec, so FakeSystem intercepts) ---
  async ensureUser(user, password) { // Linux system user for a site
    const exists = (await this.exec('id', ['-u', user])).code === 0;
    if (!exists) await this.ok('useradd', ['-m', '-s', '/bin/bash', user]);
    await this.exec('chpasswd', [], { input: `${user}:${password}` });
    await this.exec('usermod', ['-aG', 'www-data', user]);
  }
  async removeUser(user) { await this.exec('userdel', ['-r', '-f', user]); }
  async reloadNginx() { await this.ok('nginx', ['-t']); await this.ok('systemctl', ['reload', 'nginx']); }
  async reloadFpm(version) { await this.ok('systemctl', ['reload', `php${version}-fpm`]); }
  async certIssue(domain, email) { await this.ok('certbot', ['--nginx', '-n', '--redirect', '-d', domain, '-m', email, '--agree-tos']); }
  async setCrontabFile(name, lines) { this.writeFile(`/etc/cron.d/${name}`, lines.join('\n') + '\n'); }
  writeFile(p, content) { fs.writeFileSync(p, content); }
  readFile(p) { return fs.readFileSync(p, 'utf8'); }
}

// Records calls, returns canned results. Used in tests and JLP_DRYRUN=1 dev mode.
export class FakeSystem extends System {
  constructor() { super(); this.calls = []; this.files = new Map(); this.results = new Map(); this.users = new Map(); }
  stub(file, result) { this.results.set(file, { code: 0, stdout: '', stderr: '', ...result }); }
  async exec(file, args = [], opts = {}) {
    this.calls.push({ file, args, opts });
    if (file === 'tee' || file === 'sh' || file === 'install') return { code: 0, stdout: '', stderr: '' };
    if (this.results.has(file)) return this.results.get(file);
    return { code: 0, stdout: '', stderr: '' };
  }
  writeFile(p, content) { this.files.set(p, content); }
  readFile(p) { if (!this.files.has(p)) throw new Error(`FakeSystem: no file ${p}`); return this.files.get(p); }
}
