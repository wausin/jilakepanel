import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from './launcher.js';

// globalSetup runs in the runner process and starts the in-process panel server.
// The URL is written to a temp file so the `baseUrl` fixture (e2e/fixtures.js) can
// read it inside the worker process. The returned function is invoked by Playwright
// as the global teardown and closes the server + cleans up.
export const URL_FILE = path.join(os.tmpdir(), 'jlp-e2e-url');

export default async function globalSetup() {
  const { url, close } = await start();
  fs.writeFileSync(URL_FILE, url);
  return async () => {
    await close();
    try { fs.rmSync(URL_FILE, { force: true }); } catch {}
  };
}
