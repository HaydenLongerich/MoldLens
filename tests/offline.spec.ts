import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const appUrl = pathToFileURL(resolve('dist/offline.html')).href;
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j19sAAAAASUVORK5CYII=', 'base64');
const providerCard = (page: Page, name: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });

test('offline app persists uploads, case updates, notes, and provides contractor comparison', async ({ page }, testInfo) => {
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

  await page.getByRole('link', { name: 'Team dashboard', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search clients, addresses, or requests' }).fill('Offline Browser Test');
  await page.getByRole('button', { name: 'Open case for Offline Browser Test', exact: true }).click();
  let caseDialog = page.getByRole('dialog', { name: 'Offline Browser Test', exact: true });
  await expect(caseDialog.locator('.admin-attachment')).toHaveCount(2);
  await caseDialog.getByLabel('Status', { exact: true }).selectOption('In review');
  await caseDialog.getByLabel('Priority', { exact: true }).selectOption('High');
  await caseDialog.getByLabel('Assigned to', { exact: true }).fill('Demo Inspector');
  await caseDialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(caseDialog.getByText('Case updated.', { exact: true })).toBeVisible();
  await caseDialog.getByLabel('Add an internal note').fill('Offline verification: photos and walkthrough reviewed.');
  await caseDialog.getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(caseDialog.getByText('Offline verification: photos and walkthrough reviewed.', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-case-desktop.png'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Open case for Offline Browser Test', exact: true }).click();
  caseDialog = page.getByRole('dialog', { name: 'Offline Browser Test', exact: true });
  await expect(caseDialog.getByLabel('Status', { exact: true })).toHaveValue('In review');
  await expect(caseDialog.getByLabel('Priority', { exact: true })).toHaveValue('High');
  await expect(caseDialog.getByLabel('Assigned to', { exact: true })).toHaveValue('Demo Inspector');
  await expect(caseDialog.getByText('Offline verification: photos and walkthrough reviewed.', { exact: true })).toBeVisible();
  await caseDialog.getByRole('button', { name: 'Close case details' }).click();
  await page.getByRole('link', { name: 'Back to customer page', exact: true }).click();
  await page.getByRole('link', { name: 'My requests', exact: true }).click();
  await expect(page.locator('.request-status-pill')).toHaveText('In review');

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
