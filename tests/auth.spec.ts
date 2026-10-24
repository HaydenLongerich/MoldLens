import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const credentials = { email: 'staff-browser@example.test', password: 'Browser-fixture-password-2026!' };

test('staff setup, authenticated view switching, sign-out, and direct dashboard protection', async ({ page, request }, testInfo) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto('/#inspection');
  await expect(page.getByRole('heading', { name: 'Worried about mold?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Staff sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to dashboard', exact: true })).toHaveCount(0);
  expect((await request.get('/api/requests')).status()).toBe(401);

  // A direct URL must be protected just like the visible navigation link.
  await page.goto('/#admin');
  await expect(page.getByRole('heading', { name: 'Set up staff access', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search clients, addresses, or requests' })).toHaveCount(0);
  const dataDirectory = process.env.MOLDLENS_E2E_DATA_DIR;
  if (!dataDirectory) throw new Error('The test runner did not provide its isolated data directory.');
  for (const privatePath of ['/data/staff-setup-code', '/data/requests.json', `/@fs${join(dataDirectory, 'staff-setup-code')}`]) {
    expect([403, 404]).toContain((await request.get(privatePath)).status());
  }
  const setupCode = (await readFile(join(dataDirectory, 'staff-setup-code'), 'utf8')).trim();
  await page.getByLabel('Setup code', { exact: true }).fill(setupCode);
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByLabel('Confirm password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Create staff account', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Search clients, addresses, or requests' })).toBeVisible();
  expect((await page.request.get('/api/requests')).status()).toBe(200);
  await page.screenshot({ path: testInfo.outputPath('staff-dashboard.png'), fullPage: true });

  await page.getByRole('link', { name: 'View customer page', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Worried about mold?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to dashboard', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to dashboard', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Search clients, addresses, or requests' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Search clients, addresses, or requests' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Worried about mold?' })).toBeVisible();
  expect((await page.request.get('/api/requests')).status()).toBe(401);
  await expect(page.getByRole('link', { name: 'Back to dashboard', exact: true })).toHaveCount(0);
  await page.goto('/#admin');
  await expect(page.getByRole('heading', { name: 'Staff sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search clients, addresses, or requests' })).toHaveCount(0);
  await page.getByLabel('Email', { exact: true }).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill('Incorrect-fixture-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Search clients, addresses, or requests' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  expect(browserErrors).toEqual([]);
});
