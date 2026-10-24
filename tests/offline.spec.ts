import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const appUrl = pathToFileURL(resolve('dist/offline.html')).href;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j19sAAAAASUVORK5CYII=', 'base64');
const providerCard = (page: Page, name: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });

test('offline customer preview persists uploads, blocks staff access, and provides contractor comparison', async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(`${appUrl}#inspection`);
  await expect(page.getByRole('heading', { name: 'Worried about mold?' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('inspection-desktop.png'), fullPage: true });
  await page.getByLabel('What are you noticing?', { exact: true }).fill('Offline test: discolouration near the basement window after a leak.');
  await page.getByLabel('Postal code', { exact: true }).fill('K1S 3W7');

  // Leaving the form preserves its text without requiring the customer to repeat it.
  await page.getByRole('link', { name: 'My requests', exact: true }).click();
  await page.getByRole('link', { name: 'MoldLens home', exact: true }).click();
  await expect(page.getByLabel('What are you noticing?', { exact: true })).toHaveValue('Offline test: discolouration near the basement window after a leak.');
  const video = await readFile(resolve('public/sample-data/02_Virtual_Sample/Videos/Walkthrough_Silent.mp4'));
  await page.getByLabel('Upload photos or videos').setInputFiles([
    { name: 'offline-basement.png', mimeType: 'image/png', buffer: tinyPng },
    { name: 'offline-walkthrough.mp4', mimeType: 'video/mp4', buffer: video },
  ]);
  await expect(page.locator('.simple-upload-file')).toHaveCount(2);
  await page.getByLabel('Name', { exact: true }).fill('Offline Browser Test');
  await page.getByLabel('Email', { exact: true }).fill('offline-test@example.com');
  await page.getByRole('checkbox', { name: 'I agree to have my details and uploads saved for review.' }).check();
  await page.getByRole('button', { name: 'Request a review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  const reference = (await page.getByTestId('request-reference').innerText()).trim();
  await page.getByRole('button', { name: 'View my request' }).click();
  await expect(page.locator('.my-request-card')).toHaveCount(1);
  await page.reload();
  await page.getByRole('button', { name: 'View details', exact: true }).click();
  await expect(page.locator('.my-request-id')).toContainText(reference);
  await expect(page.locator('.my-request-attachment')).toHaveCount(2);
  const sizes = await page.locator('.my-request-attachment').evaluateAll(async links => Promise.all(links.map(async link => (await (await fetch((link as HTMLAnchorElement).href)).blob()).size)));
  expect(sizes).toEqual([tinyPng.length, video.length]);
  await page.screenshot({ path: testInfo.outputPath('request-submitted-desktop.png'), fullPage: true });

  await page.getByRole('link', { name: 'Staff sign in', exact: true }).click();
  await expect(page.getByText('Staff access is available in the running app.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open staff sign in', exact: true })).toHaveAttribute('href', 'http://127.0.0.1:5173/#login');
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await page.goto(`${appUrl}#admin`);
  await expect(page.getByText('Staff access is available in the running app.', { exact: false })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Search clients, addresses, or requests' })).toHaveCount(0);
  await page.getByRole('link', { name: 'MoldLens home', exact: true }).click();
  await page.getByRole('link', { name: 'My requests', exact: true }).click();
  await expect(page.locator('.request-status-pill')).toHaveText('New');

  await page.getByRole('link', { name: 'Find a specialist', exact: true }).click();
  await providerCard(page, 'Mold Busters').getByRole('checkbox', { name: 'Compare', exact: true }).check();
  await providerCard(page, 'Enviropure').getByRole('checkbox', { name: 'Compare', exact: true }).check();
  await page.getByRole('button', { name: 'Compare 2', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: 'A clearer picture, side by side.' });
  await expect(comparison).toBeVisible();
  await expect(comparison.getByRole('row', { name: /^Pricing/ })).toContainText('Free');
  await expect(comparison.getByRole('row', { name: /^Pricing/ })).toContainText('Request a quote');
  await page.screenshot({ path: testInfo.outputPath('contractors-comparison-desktop.png'), fullPage: true });
  expect(browserErrors).toEqual([]);
});

test('offline mobile intake fits the screen and reaches local specialists', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${appUrl}#inspection`);
  await expect(page.getByRole('heading', { name: 'Worried about mold?' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('inspection-mobile.png'), fullPage: true });
  await page.getByRole('link', { name: 'Find a specialist', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good help is close to home.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('contractors-mobile.png'), fullPage: true });
});
