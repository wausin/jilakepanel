import fs from 'node:fs';
import { test as base, expect } from '@playwright/test';
import { URL_FILE } from './global-setup.js';

// globalSetup starts the in-process server and writes its URL to URL_FILE; the
// config's static baseURL cannot see it (config loads before globalSetup), so we
// expose it as a fixture and navigate with absolute URLs.
export const test = base.extend({
  baseUrl: async ({}, use) => {
    use(fs.readFileSync(URL_FILE, 'utf8').trim());
  },
});

export { expect };
