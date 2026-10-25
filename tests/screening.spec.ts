import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const staffCredentials = { email: 'staff-browser@example.test', password: 'Browser-fixture-password-2026!' };
const context = { areas: ['basement'], concerns: ['visible_spots'], propertyType: 'house', region: 'ON' };
const consent = { consentAiProcessing: true, consentMediaStorage: true };

test('written screening persists, asks questions, publishes a free report, and links one staff case', async ({ page, browser }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#inspection');
  // Fail before submission if a test-server configuration accidentally permits live AI.
  const config = await (await page.request.get('/api/screening-config')).json();
  expect(config.ai.provider).toBe('mock');
  await page.getByRole('button', { name: 'Start a screening', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start a screening', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: /I agree to AI processing/ }).check();
  await page.getByRole('checkbox', { name: /I agree to private storage/ }).check();
  await page.getByRole('checkbox', { name: 'Basement', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Spots or discoloration', exact: true }).check();
  await page.getByLabel('Anything else?', { exact: false }).fill('Browser fixture: spots around a basement window. No photos were supplied.');
  await page.getByLabel('Property type', { exact: true }).selectOption('house');
  await page.getByLabel('Region', { exact: true }).selectOption('ON');
  await page.getByLabel('Name', { exact: true }).fill('Screening Browser Test');
  await page.getByLabel('Email', { exact: true }).fill('screening-browser@example.test');
  await page.getByLabel('Postal code', { exact: true }).fill('K1S 3W7');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved.');
  const draftUrl = page.url();
  const id = new URLSearchParams(new URL(draftUrl).hash.split('?')[1]).get('id');
  expect(id).toMatch(/^[a-f0-9-]{36}$/);

  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Basement', exact: true })).toBeChecked();
  await expect(page.getByLabel('Property type', { exact: true })).toHaveValue('house');
  await expect(page.getByLabel('Anything else?', { exact: false })).toHaveValue(/No photos were supplied/);
  await page.getByRole('link', { name: 'My requests', exact: true }).click();
  const draftLink = page.locator(`.screening-history-item[href="#screening?id=${id}"]`);
  await expect(draftLink).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No requests yet', exact: true })).toHaveCount(0);
  await draftLink.click();
  await page.getByRole('button', { name: 'Start screening', exact: true }).click();
  await expect(page.locator('.screening-questions')).toBeVisible({ timeout: 30_000 });
  const questions = page.locator('.screening-question');
  expect(await questions.count()).toBeGreaterThan(0);
  expect(await questions.count()).toBeLessThanOrEqual(4);
  for (const question of await questions.all()) await question.getByLabel('Not sure', { exact: true }).check();
  await page.getByRole('button', { name: 'See my results', exact: true }).click();
  await expect(page.locator('.screening-report')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('article.doc')).toContainText(/Limited screening|Inconclusive screening/);
  await expect(page.locator('.screening-highlights')).toHaveCount(0);
  await expect(page.locator('article.doc')).toContainText('Your answers');
  await expect(page.locator('article.doc')).toContainText('No photos were supplied.');
  // Customers get the short report; the measurement table is for staff and contractors.
  await expect(page.locator('article.doc')).not.toContainText('Checks and measurements');
  await page.screenshot({ path: testInfo.outputPath('screening-written-report.png'), fullPage: true });
  await page.reload();
  await expect(page.locator('.screening-report')).toBeVisible();

  // The worker synchronizes report availability into the linked customer case.
  await expect.poll(async () => {
    const cases = await (await page.request.get('/api/my-requests')).json();
    return cases.find((item: { screening?: { id: string } }) => item.screening?.id === id)?.screening?.reportAvailable;
  }).toBe(true);
  await page.getByRole('link', { name: 'My requests', exact: true }).click();
  await expect(page.getByTestId('request-card')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'View screening report', exact: true })).toBeVisible();
  await expect(page.locator(`.screening-history-item[href="#screening?id=${id}"]`)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No requests yet', exact: true })).toHaveCount(0);

  // Staff has a separate browser context, so this view cannot rely on ownership cookies.
  const staffContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL as string });
  try {
    const staffPage = await staffContext.newPage();
    staffPage.on('pageerror', error => errors.push(error.message));
    await staffPage.goto('/#login');
    const session = await (await staffPage.request.get('/api/auth/session')).json();
    await staffPage.getByLabel('Email', { exact: true }).fill(staffCredentials.email);
    await staffPage.getByLabel('Password', { exact: true }).fill(staffCredentials.password);
    if (session.setupRequired) {
      const directory = process.env.MOLDLENS_E2E_DATA_DIR;
      if (!directory) throw new Error('The isolated browser test data directory is missing.');
      await staffPage.getByLabel('Setup code', { exact: true }).fill((await readFile(join(directory, 'staff-setup-code'), 'utf8')).trim());
      await staffPage.getByLabel('Confirm password', { exact: true }).fill(staffCredentials.password);
      await staffPage.getByRole('button', { name: 'Create staff account', exact: true }).click();
    } else await staffPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await staffPage.getByRole('textbox', { name: 'Search clients, addresses, or requests' }).fill('screening-browser@example.test');
    await staffPage.getByRole('button', { name: 'Open case for Screening Browser Test', exact: true }).click();
    await staffPage.getByRole('link', { name: 'View screening report', exact: true }).click();
    await expect(staffPage).toHaveURL(new RegExp(`screening\\?id=${id}&view=staff`));
    await expect(staffPage.locator('.screening-report')).toBeVisible();
    await expect(staffPage.getByRole('button', { name: 'See my results', exact: true })).toHaveCount(0);
    await expect(staffPage.getByRole('button', { name: 'Add photos or a video', exact: true })).toHaveCount(0);
    await expect(staffPage.getByRole('link', { name: 'Request a specialist review', exact: true })).toHaveCount(0);
    await staffPage.getByRole('button', { name: 'Sign out', exact: true }).click();
    await staffPage.goto(`/#screening?id=${id}&view=staff`);
    await expect(staffPage.getByRole('heading', { name: 'Staff sign in', exact: true })).toBeVisible();
    await expect(staffPage.locator('.screening-report')).toHaveCount(0);
  } finally { await staffContext.close(); }
  expect(errors).toEqual([]);
});

test('a delayed draft save cannot replace another screening after navigation', async ({ page }) => {
  await page.goto('/#screening');
  const first = await (await page.request.post('/api/screenings', { data: consent })).json();
  const second = await (await page.request.post('/api/screenings', { data: consent })).json();
  await page.request.patch(`/api/screenings/${first.id}`, { data: { ...context, statement: 'First draft' } });
  await page.request.patch(`/api/screenings/${second.id}`, { data: { ...context, statement: 'Second draft' } });
  await page.goto(`/#screening?id=${first.id}`);
  await expect(page.getByLabel('Anything else?', { exact: false })).toHaveValue('First draft');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const saving = new Promise<void>(resolve => { started = resolve; });
  await page.route(`**/api/screenings/${first.id}`, async route => {
    if (route.request().method() === 'PATCH') { started(); await held; }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await saving;
  try {
    await page.evaluate(id => { window.location.hash = `screening?id=${id}`; }, second.id);
    await expect(page.getByLabel('Anything else?', { exact: false })).toHaveValue('Second draft');
    await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeEnabled();
    const finished = page.waitForResponse(response => response.url().endsWith(`/api/screenings/${first.id}`) && response.request().method() === 'PATCH');
    release();
    await finished;
    await expect(page.locator('.screening-reference')).toHaveText(second.reference);
    await expect(page.getByLabel('Anything else?', { exact: false })).toHaveValue('Second draft');
  } finally { release(); }
});
