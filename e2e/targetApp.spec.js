import { test, expect } from './fixtures.js';
import { TOKEN_OK, card, fakeGeminiLive, stubToken } from './fakeLive.js';

// The target app's own layout (M9 fix wave): the Orders page doesn't shift
// when its script is late, and every page's last control scrolls clear of the
// presenter card, which floats over the bottom of the frame.

/** @typedef {{ value: number, recent: boolean }} LayoutShift */

test.describe('the Orders page on a phone', () => {
  test.use({ viewport: { width: 412, height: 823 } });

  test('does not shift when orders.js arrives late (F1: the rows are static markup)', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      /** @type {LayoutShift[]} */
      const shifts = [];
      Object.assign(window, { __layoutShifts: shifts });
      new PerformanceObserver((list) => {
        // A layout-shift entry: PerformanceEntry plus these two (not in the DOM lib).
        const entries =
          /** @type {Array<PerformanceEntry & { value: number, hadRecentInput: boolean }>} */ (
            list.getEntries()
          );
        for (const entry of entries)
          shifts.push({ value: entry.value, recent: entry.hadRecentInput });
      }).observe({ type: 'layout-shift', buffered: true });
    });
    // A slow link: the page paints before its deferred script runs. Before
    // the fix that first frame had an empty table, and the rows then pushed
    // the New order form ~2,900 px down (CLS 0.679, docs/metrics/m09.md).
    await page.route('**/target-app/orders.js', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });

    await page.goto('/target-app/orders.html');
    // orders.js has run: a tick updates the count.
    await page.getByRole('checkbox', { name: 'Select order 1003' }).check();
    await expect(page.getByTestId('orders-selected-count')).toHaveText('1 selected');

    const shifts = await page.evaluate(
      () => /** @type {Window & { __layoutShifts: LayoutShift[] }} */ (window).__layoutShifts,
    );
    const unprovoked = shifts.filter((shift) => !shift.recent);
    expect(unprovoked.reduce((sum, shift) => sum + shift.value, 0)).toBeLessThan(0.05);
  });

  test('fades the table’s right edge until it is scrolled to the end', async ({ page }) => {
    await page.goto('/target-app/orders.html');
    const region = page.getByRole('region', { name: 'Orders' });

    await expect(region).toHaveClass(/table-scroll--more/);
    await region.evaluate((box) => box.scrollTo({ left: box.scrollWidth }));
    await expect(region).not.toHaveClass(/table-scroll--more/);
  });
});

test.describe('at 360 px with a session open', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  for (const { route, last } of [
    { route: 'orders', last: 'Create order' },
    { route: 'settings', last: 'Save' },
  ]) {
    test(`${last}, at the bottom of ${route}, sits above the card (U2)`, async ({ page }) => {
      await stubToken(page, TOKEN_OK);
      await fakeGeminiLive(page);
      const { status, button } = card(page);
      await page.goto('/');
      await button('Talk to the AI Presenter').click();
      await expect(status).toHaveText('Live');

      const frame = page.frameLocator('iframe');
      await frame.getByTestId(`nav-${route}`).click();
      const control = frame.getByRole('button', { name: last, exact: true });
      await expect(control).toBeVisible();
      await control.evaluate((el) => {
        const root = el.ownerDocument.scrollingElement;
        root?.scrollTo({ top: root.scrollHeight });
      });

      const cardBox = await page.locator('#ai-presenter-agent-host').boundingBox();
      const controlBox = await control.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(controlBox).not.toBeNull();
      if (!cardBox || !controlBox) return;
      expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(cardBox.y);
    });
  }
});
