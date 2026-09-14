import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
  async ensureUser(user, password) { // Linux system user for a site; returns true if created, false if already existed
    const exists = (await this.exec('id', ['-u', user])).code === 0;
    if (!exists) await this.ok('useradd', ['-m', '-s', '/bin/bash', user]);
    await this.exec('chpasswd', [], { input: `${user}:${password}` });
    await this.exec('usermod', ['-aG', 'www-data', user]);
    return !exists;
  }
  async removeUser(user) { await this.exec('userdel', ['-r', '-f', user]); }
  async reloadNginx() { await this.ok('nginx', ['-t']); await this.ok('systemctl', ['reload', 'nginx']); }
  async reloadFpm(version) { await this.ok('systemctl', ['reload', `php${version}-fpm`]); }
  async certIssue(domain, email, domains) {
    const list = (domains && domains.length ? domains : [domain]);
    const args = ['--nginx', '-n', '--redirect'];
    for (const d of list) args.push('-d', d);
    args.push('-m', email, '--agree-tos');
    await this.ok('certbot', args);
  }
  async publicIp() {
    const r = await this.exec('curl', ['-s', '--max-time', '10', 'https://api.ipify.org']);
    const ip = (r.stdout || '').trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  }
  async setCrontabFile(name, lines) { this.writeFile(`/etc/cron.d/${name}`, lines.join('\n') + '\n'); }
  writeFile(p, content) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
  readFile(p) { return fs.readFileSync(p, 'utf8'); }
}

// Records calls, returns canned results. Used in tests and JLP_DRYRUN=1 dev mode.
export class FakeSystem extends System {
  constructor() { super(); this.calls = []; this.files = new Map(); this.results = new Map(); this.once = new Map(); this.users = new Map(); this.createUsers = false; }
  stub(file, result) { this.results.set(file, { code: 0, stdout: '', stderr: '', ...result }); }
  // stub for the NEXT exec of `file` only, then clears itself
  stubOnce(file, result) { (this.once.get(file) ?? this.once.set(file, []).get(file)).push({ code: 0, stdout: '', stderr: '', ...result }); }
  async exec(file, args = [], opts = {}) {
    this.calls.push({ file, args, opts });
    if (file === 'id' && this.createUsers) return { code: 1, stdout: '', stderr: '' };
    const q = this.once.get(file);
    if (q?.length) return q.shift();
    if (this.results.has(file)) return this.results.get(file);
    return { code: 0, stdout: '', stderr: '' };
  }
  writeFile(p, content) { this.files.set(p, content); }
  // virtual map first, real disk fallback (templates etc. must resolve on dryrun boots)
  readFile(p) { if (this.files.has(p)) return this.files.get(p); return fs.readFileSync(p, 'utf8'); }
}
