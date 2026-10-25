import { expect, test } from '@playwright/test';

// The phone runs in its own browser context with no customer cookie, the way a real phone would.
test('a phone scanned from the desktop code takes a photo that joins the desktop screening', async ({ page, browser }) => {
  await page.goto('/#screening');
  await page.getByRole('checkbox', { name: /Allow third-party AI providers/ }).check();
  await page.getByRole('checkbox', { name: /Allow private storage/ }).check();
  await page.getByRole('checkbox', { name: 'Basement', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Spots or discoloration', exact: true }).check();
  await page.getByLabel('Anything else?', { exact: false }).fill('Live camera fixture: spots near a basement window.');
  await page.getByLabel('Property type', { exact: true }).selectOption('house');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved.');

  await page.getByRole('button', { name: 'Use phone camera', exact: true }).click();
  await expect(page.getByRole('img', { name: 'QR code to open the live camera on your phone' })).toBeVisible();
  const link = await page.getByLabel('Phone link', { exact: true }).inputValue();
  expect(link).toMatch(/\/live\/[0-9a-f-]{36}#[A-Za-z0-9_-]{16,}$/);

  const phoneContext = await browser.newContext({ permissions: ['camera'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneContext.newPage();
  const phoneErrors: string[] = [];
  phone.on('pageerror', (error) => phoneErrors.push(error.message));
  await phone.goto(link);
  await phone.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(phone.getByText('0 of 12 photos')).toBeVisible();
  await expect(page.getByText('Phone connected. Take photos on your phone.', { exact: true })).toBeVisible();

  await phone.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect(phone.getByText('Photo 1 of 12 saved.')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Photo from the phone' })).toBeVisible();
  await page.getByRole('button', { name: /Add 1 photo to screening/ }).click();
  await expect(page.getByText('1 photo added to your screening.')).toBeVisible();
  await expect(page.locator('.live-thumb span', { hasText: 'Added' })).toBeVisible();
  expect(phoneErrors).toEqual([]);
  await phoneContext.close();
});
