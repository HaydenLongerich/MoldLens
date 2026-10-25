import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Every screen in the live camera flow, with a screenshot saved for review.
// Each run writes to its own screenshots/live/<time>/ folder (not committed), so a screenshot
// left open in an image viewer from an earlier run never blocks the next one.
const SHOTS = path.resolve('screenshots/live', new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
mkdirSync(SHOTS, { recursive: true });

async function fillScreening(page: Page) {
  await page.goto('/#screening');
  await page.getByRole('checkbox', { name: /Allow third-party AI providers/ }).check();
  await page.getByRole('checkbox', { name: /Allow private storage/ }).check();
  await page.getByRole('checkbox', { name: 'Basement', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Spots or discoloration', exact: true }).check();
  await page.getByLabel('Anything else?', { exact: false }).fill('Live camera fixture: spots near a basement window.');
  await page.getByLabel('Property type', { exact: true }).selectOption('house');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved.');
}

async function showCode(page: Page) {
  await page.getByRole('button', { name: 'Use phone camera', exact: true }).click();
  await expect(page.getByRole('img', { name: 'QR code to open the live camera on your phone' })).toBeVisible();
  return page.getByLabel('Phone link', { exact: true }).inputValue();
}

async function newPhone(browser: Browser) {
  const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  return { context, page: await context.newPage() };
}

async function tickConsent(page: Page) {
  await page.getByRole('checkbox', { name: /Allow third-party AI providers/ }).check();
  await page.getByRole('checkbox', { name: /Allow private storage/ }).check();
}

test('upload and live camera are separated by "or", and the camera nudges for permission like upload does', async ({ page }) => {
  await page.goto('/#screening');
  await expect(page.getByRole('separator', { name: 'or' })).toBeVisible();
  const panel = page.locator('.live-panel');
  const phoneButton = panel.getByRole('button', { name: 'Use phone camera', exact: true });
  await expect(phoneButton).toHaveAttribute('aria-disabled', 'true');
  await expect(panel.getByRole('button', { name: "Use this device's camera", exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.locator('.screening-field').filter({ has: page.getByRole('separator', { name: 'or' }) }).screenshot({ path: path.join(SHOTS, 'desktop-0-upload-or-camera.png') });

  // Same response as the upload button: highlight the boxes, shake them, and explain.
  // Playwright treats aria-disabled as disabled, but a real user can still click it, so force the click.
  await phoneButton.click({ force: true });
  await expect(page.getByText('Please tick both boxes above before adding photos or a video.')).toBeVisible();
  await expect(page.locator('.screening-consents label.needs-consent')).toHaveCount(2);
  await expect(page.getByRole('img', { name: 'QR code to open the live camera on your phone' })).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-0-permission-nudge.png') });

  await tickConsent(page);
  // No "Save draft" first: asking for a code creates the draft.
  await panel.getByRole('button', { name: 'Use phone camera', exact: true }).click();
  await expect(page.getByRole('img', { name: 'QR code to open the live camera on your phone' })).toBeVisible();
  await expect(page).toHaveURL(/#screening\?id=/);
});

test("desktop: this computer's camera opens over the screening and its photos are added on Done", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await context.newPage();
  await page.goto('/#screening');
  await tickConsent(page);
  await page.locator('.live-panel').getByRole('button', { name: "Use this device's camera", exact: true }).click();
  const camera = page.getByRole('dialog', { name: 'Live camera' });
  await expect(camera.getByRole('heading', { name: 'Share your camera' })).toBeVisible();
  await camera.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(camera.getByText('0 of 12 photos')).toBeVisible();
  await camera.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect(camera.getByText('Photo 1 of 12 saved.')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'desktop-7-device-camera.png') });

  await camera.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(camera).toHaveCount(0);
  await expect(page.locator('.live-panel').getByText('1 photo added to your screening.')).toBeVisible();
  await page.locator('.live-panel').screenshot({ path: path.join(SHOTS, 'desktop-8-device-photos-added.png') });
  await context.close();
});

test("phone: the phone's own camera is the main option and adds its photos to the screening", async ({ browser }) => {
  const { context, page } = await newPhone(browser);
  await page.goto('/#screening');
  await tickConsent(page);
  const panel = page.locator('.live-panel');
  await expect(panel.getByRole('button', { name: "Use this device's camera", exact: true })).toHaveClass(/btn-primary/);
  await expect(panel.getByRole('button', { name: 'Use a different phone', exact: true })).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'phone-0-screening-panel.png') });

  await panel.getByRole('button', { name: "Use this device's camera", exact: true }).click();
  const camera = page.getByRole('dialog', { name: 'Live camera' });
  await camera.getByRole('button', { name: 'Start camera', exact: true }).click();
  await camera.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect(camera.getByText('Photo 1 of 12 saved.')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'phone-8-own-camera.png') });
  await camera.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(panel.getByText('1 photo added to your screening.')).toBeVisible();
  await context.close();
});

test('desktop: the phone code panel and its copyable link', async ({ page }) => {
  await fillScreening(page);
  const panel = page.locator('.live-panel');
  await expect(panel.getByRole('button', { name: 'Use phone camera', exact: true })).toBeVisible();
  await panel.screenshot({ path: path.join(SHOTS, 'desktop-1-start.png') });

  const link = await showCode(page);
  expect(link).toMatch(/\/live\/[0-9a-f-]{36}#[A-Za-z0-9_-]{16,}$/);
  await expect(panel.getByText('Scan with your phone camera')).toBeVisible();
  await panel.screenshot({ path: path.join(SHOTS, 'desktop-2-code.png') });
});

test('phone: consent screen before the camera starts', async ({ page, browser }) => {
  await fillScreening(page);
  const link = await showCode(page);
  const { context, page: phone } = await newPhone(browser);
  await phone.goto(link);
  await expect(phone.getByRole('heading', { name: 'Share your camera' })).toBeVisible();
  await phone.screenshot({ path: path.join(SHOTS, 'phone-1-consent.png') });
  await context.close();
});

test('a phone pairs and gets guidance on its own screen, and the desktop shows no live feed', async ({ page, browser }) => {
  await fillScreening(page);
  const link = await showCode(page);
  const { context, page: phone } = await newPhone(browser);
  await phone.goto(link);
  await phone.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(phone.getByText('0 of 12 photos')).toBeVisible();
  await expect(page.getByText('Phone connected. Take photos on your phone.', { exact: true })).toBeVisible();
  await expect(phone.locator('.live-guidance')).not.toHaveText('Point the camera at the affected area.', { timeout: 15_000 });
  await expect(page.locator('.live-preview, .live-chat, .live-bubble')).toHaveCount(0);

  await phone.screenshot({ path: path.join(SHOTS, 'phone-2-live.png') });
  await page.locator('.live-panel').screenshot({ path: path.join(SHOTS, 'desktop-3-connected.png') });
  await context.close();
});

test('a photo taken on the phone appears on the desktop and joins the screening', async ({ page, browser }) => {
  await fillScreening(page);
  const link = await showCode(page);
  const { context, page: phone } = await newPhone(browser);
  await phone.goto(link);
  await phone.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByText('Phone connected. Take photos on your phone.', { exact: true })).toBeVisible();

  await phone.getByRole('button', { name: 'Take photo', exact: true }).click();
  await expect(phone.getByText('Photo 1 of 12 saved.')).toBeVisible();
  await phone.screenshot({ path: path.join(SHOTS, 'phone-3-saved.png') });

  const panel = page.locator('.live-panel');
  await expect(panel.getByRole('img', { name: 'Photo from the phone' })).toBeVisible();
  await panel.getByRole('button', { name: /Add 1 photo to screening/ }).click();
  await expect(page.getByText('1 photo added to your screening.')).toBeVisible();
  await expect(panel.locator('.live-thumb span', { hasText: 'Added' })).toBeVisible();
  await panel.screenshot({ path: path.join(SHOTS, 'desktop-4-photo-added.png') });
  await context.close();
});

test('an incomplete link explains what to do instead of showing a broken camera', async ({ browser }) => {
  const { context, page: phone } = await newPhone(browser);
  await phone.goto('/live/');
  await expect(phone.getByRole('heading', { name: 'This link is incomplete' })).toBeVisible();
  await phone.screenshot({ path: path.join(SHOTS, 'phone-4-incomplete-link.png') });
  await context.close();
});

test('a wrong or expired code ends on the phone with a clear message', async ({ page, browser }) => {
  await fillScreening(page);
  const link = await showCode(page);
  const id = link.match(/\/live\/([0-9a-f-]{36})/)?.[1];
  const { context, page: phone } = await newPhone(browser);
  await phone.goto(`/live/${id}#not-the-real-token-value`);
  await phone.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(phone.getByRole('heading', { name: 'Live camera ended' })).toBeVisible();
  await expect(phone.getByText('This code has expired. Create a new code on the computer.')).toBeVisible();
  await phone.screenshot({ path: path.join(SHOTS, 'phone-5-expired-code.png') });
  await context.close();
});

test('a second phone with the same code takes over, and the first phone is told', async ({ page, browser }) => {
  await fillScreening(page);
  const link = await showCode(page);
  const first = await newPhone(browser);
  await first.page.goto(link);
  await first.page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByText('Phone connected. Take photos on your phone.', { exact: true })).toBeVisible();

  const second = await newPhone(browser);
  await second.page.goto(link);
  await second.page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(first.page.getByRole('heading', { name: 'Live camera ended' })).toBeVisible({ timeout: 15_000 });
  await expect(first.page.getByText('Another phone connected with this code.')).toBeVisible();
  await first.page.screenshot({ path: path.join(SHOTS, 'phone-6-replaced.png') });
  await first.context.close();
  await second.context.close();
});

test('ending the live camera on the desktop disconnects the phone', async ({ page, browser }) => {
  await fillScreening(page);
  const link = await showCode(page);
  const { context, page: phone } = await newPhone(browser);
  await phone.goto(link);
  await phone.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByText('Phone connected. Take photos on your phone.', { exact: true })).toBeVisible();

  await page.locator('.live-panel').getByRole('button', { name: 'End phone camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use phone camera', exact: true })).toBeVisible();
  await expect(phone.getByRole('heading', { name: 'Live camera ended' })).toBeVisible({ timeout: 15_000 });
  await expect(phone.getByText('This live session has ended.')).toBeVisible();
  await phone.screenshot({ path: path.join(SHOTS, 'phone-7-session-ended.png') });
  await page.locator('.live-panel').screenshot({ path: path.join(SHOTS, 'desktop-6-after-end.png') });
  await context.close();
});
