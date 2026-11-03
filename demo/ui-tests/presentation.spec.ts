import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { startPresentation, type DemoStatus } from '../presentation.js';
import { ticketDefinitions } from '../runtime.js';

const fixture = fileURLToPath(new URL('../fixture/', import.meta.url));
let status: DemoStatus;
let server: Awaited<ReturnType<typeof startPresentation>>;
let starts: number;
test.beforeEach(async () => {
  starts = 0;
  status = {
    available: true,
    updatedAt: new Date().toISOString(),
    tickets: ticketDefinitions.map((ticket) => ({ ...ticket, state: 'Queued' })),
    released: false,
    message: 'Ready',
  };
  server = await startPresentation({
    beforeDirectory: fixture,
    afterDirectory: fixture,
    readStatus: async () => status,
    onStart: () => {
      starts++;
    },
  });
});
test.afterEach(async () => {
  await server.close();
});

for (const [width, height] of [
  [1920, 1080],
  [1440, 900],
  [1366, 768],
  [1024, 768],
  [768, 1024],
  [390, 844],
  [320, 568],
  [844, 390],
]) {
  test(`presentation at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto(server.url);
    await expect(page.locator('#connection')).toContainText('Live observations');
    await expect(page.locator('#activity')).toHaveCount(0);
    const toggles = page.locator('.ticket-toggle');
    await expect(toggles).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(toggles.nth(i)).toHaveAttribute('aria-expanded', 'false');
      await toggles.nth(i).click();
      await expect(toggles.nth(i)).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.ticket-details').nth(i)).toHaveCSS('opacity', '1');
      await expect(page.locator('.ticket-details').nth(i)).toContainText(ticketDefinitions[i]!.description);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const frame = page.locator('#dashboard');
    expect((await frame.boundingBox())!.height).toBeGreaterThanOrEqual(width! > 900 ? 640 : 600);
    expect(
      await page.locator('#completed').evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    ).toBeLessThanOrEqual(42);
    await expect(page.frameLocator('#dashboard').locator('h1')).toBeVisible();
    expect(
      await page
        .frameLocator('#dashboard')
        .locator('html')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    const dashboard = page.frameLocator('#dashboard');
    expect(
      await dashboard
        .locator('.kpi-label')
        .evaluateAll((labels) => labels.every((label) => label.scrollWidth <= label.clientWidth)),
    ).toBe(true);
    const brand = await dashboard.locator('.brand').boundingBox();
    const badge = await dashboard.locator('header .badge').boundingBox();
    expect(brand!.x + brand!.width <= badge!.x || brand!.y + brand!.height <= badge!.y).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('expanded.png'), fullPage: true });
    await toggles.first().click();
    await expect(page.locator('.ticket-details').first()).toHaveCSS('opacity', '0');
  });
}

test('keyboard, polling, start and release controls', async ({ page }) => {
  await page.goto(server.url);
  await expect(page.locator('#start-demo')).toBeEnabled();
  await expect(page.locator('#after')).toBeDisabled();
  await page.locator('#start-demo').click();
  await expect.poll(() => starts).toBe(1);
  await expect(page.locator('#start-demo')).toBeDisabled();
  const first = page.locator('.ticket-toggle').first();
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(first).toHaveCSS('outline-style', 'solid');
  const original = await first.elementHandle();
  status = { ...status, tickets: status.tickets.map((ticket) => ({ ...ticket, state: 'Merged' })), released: true };
  await expect(page.locator('#completed')).toHaveText('3/3');
  await expect(first).toBeFocused();
  expect(await first.evaluate((node, previous) => node === previous, original)).toBe(true);
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#after')).toBeEnabled();
  await expect(page.locator('#dashboard')).toHaveAttribute('src', '/after/');
  await page.keyboard.press('Space');
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#before').click();
  await expect(page.locator('#dashboard')).toHaveAttribute('src', '/before/');
  await page.locator('#after').click();
  await expect(page.locator('#dashboard')).toHaveAttribute('src', '/after/');
  status = { ...status, available: false };
  await expect(page.locator('#connection')).toContainText('Observation unavailable');
  await expect(page.locator('#after')).toBeDisabled();
});

test('reduced motion disables expansion animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(server.url);
  await page.locator('.ticket-toggle').first().click();
  await expect(page.locator('.ticket-details').first()).toHaveCSS('transition-duration', '0s');
  await expect(page.locator('.ticket-chevron').first()).toHaveCSS('transition-duration', '0s');
});
