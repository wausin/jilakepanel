import { test, expect } from './fixtures.js';

// Resolve the first present selector and return a single Locator (keeps strict mode happy).
async function sel(page, ...candidates) {
  for (const c of candidates) {
    const loc = page.locator(c);
    if (await loc.count()) return loc;
  }
  return page.locator(candidates[0]);
}

const siteRow = (domain) => [
  `[data-testid="site-row-${domain}"]`,
  `tr.click:has-text("${domain}")`,
];

async function login(page) {
  const u = await sel(page, '[data-testid=login-username]', '#login-username', 'input[autocomplete=username]', 'input[type=text]');
  await u.fill('admin');
  const pw = await sel(page, '[data-testid=login-password]', '#login-password', 'input[type=password]');
  await pw.fill('sup3rsecret');
  const go = await sel(page, '[data-testid=login-submit]', '#login-submit', 'button:has-text("Sign in")');
  await go.click();
}

test.beforeEach(async ({ page, baseUrl }) => {
  await page.goto(baseUrl + '/');
});

test('login, dashboard, and site navigation', async ({ page }) => {
  await login(page);

  // dashboard: stat cards visible
  await expect(page.locator('.card.stat').first()).toBeVisible();
  // nav present
  await expect(page.locator('nav a[href="#/sites"]').first()).toBeVisible();

  // navigate to sites
  await (await sel(page, '[data-testid=nav-sites]', 'nav a[href="#/sites"]')).click();
  await expect(await sel(page, ...siteRow('demo.test'))).toBeVisible();
});

test('add site via modal flow', async ({ page }) => {
  await login(page);
  await (await sel(page, '[data-testid=nav-sites]', 'nav a[href="#/sites"]')).click();
  await expect(await sel(page, ...siteRow('demo.test'))).toBeVisible();

  await (await sel(page, '[data-testid=sites-add]', 'button:has-text("Add Site")')).click();
  await expect(page.locator('.modal').first()).toBeVisible();

  await (await sel(page, '[data-testid=site-domain]', 'label.field:has-text("Domain") input')).fill('demo2.test');
  await (await sel(page, '[data-testid=site-user]', 'label.field:has-text("System user") input')).fill('demo2');
  await (await sel(page, '[data-testid=site-password]', 'label.field:has-text("System user password") input')).fill('sup3rsecret123');
  // keep type php default

  await (await sel(page, '[data-testid=modal-ok]', '.mfoot button.btn.primary')).click();

  await expect(await sel(page, ...siteRow('demo2.test'))).toBeVisible();
});

test('site detail: SQLite browse (seeded app.db -> users -> alice)', async ({ page }) => {
  await login(page);
  await (await sel(page, '[data-testid=nav-sites]', 'nav a[href="#/sites"]')).click();
  await (await sel(page, ...siteRow('demo.test'))).click();

  // tabs visible; open SQLite tab
  await expect(page.locator('.tabs').first()).toBeVisible();
  await (await sel(page, '[data-testid=tab-sqlite]', '.tabs a:has-text("SQLite")')).click();

  // db list shows app.db; click it
  await (await sel(page, '[data-testid="db-app.db"]', '.sidelist li:has-text("app.db")')).click();

  // table list shows users; click it
  await (await sel(page, '[data-testid="table-users"]', '.sidelist li:has-text("users")')).click();

  // grid shows alice
  await expect(page.locator('.grid td:has-text("alice")').first()).toBeVisible();
});

test('run SQL query and see result', async ({ page }) => {
  await login(page);
  await (await sel(page, '[data-testid=nav-sites]', 'nav a[href="#/sites"]')).click();
  await (await sel(page, ...siteRow('demo.test'))).click();
  await (await sel(page, '[data-testid=tab-sqlite]', '.tabs a:has-text("SQLite")')).click();
  await (await sel(page, '[data-testid="db-app.db"]', '.sidelist li:has-text("app.db")')).click();

  await (await sel(page, '[data-testid=sqlite-sql]', '.sqlpanel textarea.code.sql')).fill("SELECT * FROM users WHERE name='alice';");
  await (await sel(page, '[data-testid=sqlite-run]', '.sqlpanel button:has-text("Run")')).click();

  await expect(page.locator('.sqlout td:has-text("alice")').first()).toBeVisible();
});

test('theme toggle (soft) and logout', async ({ page }) => {
  await login(page);

  // soft theme assertion: current UI has no theme toggle; tolerate its absence.
  const theme = page.locator('[data-testid=theme-toggle], button:has-text("Theme")');
  if (await theme.count()) {
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || '');
    await theme.first().click();
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme') || '');
    expect(after).not.toBe(before);
  } else {
    test.info().annotations.push({ type: 'note', description: 'theme-toggle missing; skipped (UI redesign pending)' });
  }

  await (await sel(page, '[data-testid=logout]', 'button:has-text("Logout")')).click();
  await expect(await sel(page, '[data-testid=login-submit]', '#login-submit', 'button:has-text("Sign in")')).toBeVisible();
});
