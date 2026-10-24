import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j19sAAAAASUVORK5CYII=', 'base64');

test('one-page request validates, uploads photo and video, and persists without optional details', async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto('/#inspection');
  await expect(page.getByRole('heading', { name: 'Worried about mold?' })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(page.getByLabel('Street address', { exact: true })).not.toBeVisible();
  await expect(page.getByLabel('Phone number', { exact: true })).not.toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('inspection-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Request a review', exact: true }).click();
  await expect(page.getByLabel('What are you noticing?', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('What are you noticing?', { exact: true })).toBeFocused();
  await page.getByLabel('What are you noticing?', { exact: true }).fill('E2E fixture: discolouration near the basement window after a leak.');
  await page.getByLabel('Name', { exact: true }).fill('Intake Browser Test');
  await page.getByLabel('Email', { exact: true }).fill('intake-test@example.com');
  await page.getByLabel('Postal code', { exact: true }).fill('K1S 3W7');
  await page.getByLabel('Upload photos or videos').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
  await expect(page.getByRole('alert')).toContainText('please use a JPG');
  const video = await readFile(resolve('public/sample-data/02_Virtual_Sample/Videos/Walkthrough_Silent.mp4'));
  await page.getByLabel('Upload photos or videos').setInputFiles([
    { name: 'basement-photo.png', mimeType: 'image/png', buffer: tinyPng },
    { name: 'Walkthrough_Silent.mp4', mimeType: 'video/mp4', buffer: video },
  ]);
  await expect(page.locator('.simple-upload-file')).toHaveCount(2);
  await expect(page.getByAltText('Upload preview: basement-photo.png')).toBeVisible();
  await page.getByRole('checkbox', { name: 'I agree to have my details and uploads saved for review.' }).check();
  await page.getByRole('button', { name: 'Request a review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  const reference = (await page.getByTestId('request-reference').innerText()).trim();
  expect(reference).toBeTruthy();
  await page.getByRole('button', { name: 'View my request' }).click();
  await expect(page.getByRole('heading', { name: 'My requests', exact: true })).toBeVisible();
  await expect(page.getByTestId('request-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'View details', exact: true }).click();
  await expect(page.getByText('E2E fixture: discolouration near the basement window after a leak.')).toBeVisible();
  await expect(page.getByTestId('request-media')).toHaveCount(2);
  await expect(page.getByTestId('request-status')).toHaveText('New');
  await page.screenshot({ path: testInfo.outputPath('request-submitted-desktop.png'), fullPage: true });
  for (const url of await page.locator('.my-request-attachment').evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href))) {
    const response = await page.request.get(url);
    expect(response.ok()).toBeTruthy();
    expect(Number(response.headers()['content-length'])).toBeGreaterThan(0);
  }
  await page.reload();
  await expect(page.getByTestId('request-card')).toHaveCount(1);
  await expect(page.locator('.my-request-id')).toContainText(reference);
  expect(browserErrors).toEqual([]);
});

test('mobile customers can reach their requests without a navigation menu', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#inspection');
  await expect(page.getByRole('heading', { name: 'Worried about mold?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request a review', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('inspection-mobile.png'), fullPage: true });
  await page.getByRole('link', { name: 'My requests', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No requests yet', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start a request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Worried about mold?' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
