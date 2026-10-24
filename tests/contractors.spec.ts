import { expect, test, type Page } from '@playwright/test';

const providerCard = (page: Page, name: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.goto('/#contractors');
  await expect(page.getByRole('heading', { name: 'Good help is close to home.' })).toBeVisible();
  await expect(providerCard(page, 'Mold Busters')).toBeVisible();
});

test('directory searches services and names, handles no results, and filters independent testing correctly', async ({ page }) => {
  const search = page.getByRole('textbox', { name: 'Search specialists' });
  await search.fill('PuroClean');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(providerCard(page, 'PuroClean Ottawa East')).toBeVisible();
  await search.fill('not-a-local-provider');
  await expect(page.getByRole('heading', { name: 'No specialists match just yet.' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await page.getByRole('button', { name: 'Mold removal', exact: true }).click();
  await expect(providerCard(page, 'PuroClean Ottawa East')).toBeVisible();
  await expect(providerCard(page, 'Ottawa Indoor Environmental')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mold inspection', exact: true }).click();
  await expect(providerCard(page, 'Ottawa Indoor Environmental')).toBeVisible();
  await expect(providerCard(page, 'PuroClean Ottawa East')).toHaveCount(0);
});

test('saved providers survive reload and can be removed from the saved list', async ({ page }) => {
  await providerCard(page, 'Enviropure').getByRole('button', { name: 'Save Enviropure', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Saved 1', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(providerCard(page, 'Enviropure')).toBeVisible();
  await providerCard(page, 'Enviropure').getByRole('button', { name: 'Unsave Enviropure', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No specialists match just yet.' })).toBeVisible();
});

test('provider profile shows sourced contact details and closes with Escape', async ({ page }) => {
  const card = providerCard(page, 'PuroClean Ottawa East');
  const detailsButton = card.getByRole('button', { name: 'View specialist' });
  await detailsButton.click();
  const dialog = page.getByRole('dialog', { name: 'Meet your local specialist' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'PuroClean Ottawa East', exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: '613-667-1333', exact: true })).toHaveAttribute('href', 'tel:+16136671333');
  await expect(dialog.getByRole('link', { name: 'Visit website' })).toHaveAttribute('href', 'https://puroclean.ca/franchise/vars-on-puroclean-ottawa-east');
  await expect(dialog.getByText('Request a quote', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(detailsButton).toBeFocused();
});

test('comparison limits selection to three and compares source-backed services and prices', async ({ page }) => {
  await providerCard(page, 'Mold Busters').getByRole('checkbox', { name: 'Compare', exact: true }).check();
  await providerCard(page, 'Ottawa Indoor Environmental').getByRole('checkbox', { name: 'Compare', exact: true }).check();
  await providerCard(page, 'Enviropure').getByRole('checkbox', { name: 'Compare', exact: true }).check();
  await expect(providerCard(page, 'PuroClean Ottawa East').getByRole('checkbox', { name: 'Compare', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Compare 3', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'A clearer picture, side by side.' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('columnheader', { name: 'Mold Busters', exact: true })).toBeVisible();
  await expect(dialog.getByRole('columnheader', { name: 'Ottawa Indoor Environmental', exact: true })).toBeVisible();
  await expect(dialog.getByRole('row', { name: /^Pricing/ })).toContainText('Free');
  await expect(dialog.getByRole('row', { name: /^Pricing/ })).toContainText('Request a quote');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected specialists to compare' })).toHaveCount(0);
});

test('directory and profile fit a narrow mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'My requests', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await providerCard(page, 'Healthy Home Center').getByRole('button', { name: 'View specialist' }).click();
  const dialog = page.getByRole('dialog', { name: 'Meet your local specialist' });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await expect(dialog.getByRole('link', { name: '613-725-7733' })).toBeVisible();
});
