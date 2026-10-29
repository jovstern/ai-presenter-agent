import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';

// axe on every screen this build has (spec Budgets: 0 violations), with all of
// axe's default rules, best practices included.
//
// The agent card lives in an open shadow root (main.jsx), which axe-core
// walks by default; the iframe's target app is analysed as a frame. Neither
// is taken on trust: each test checks that axe's results include nodes from
// inside the shadow root (a shadow-piercing target is an array of selectors
// whose first entry is the host).

const HOST = '#ai-presenter-agent-host';

/** @param {import('@playwright/test').Page} page */
async function analyze(page) {
  const results = await new AxeBuilder({ page }).analyze();
  // Every node axe looked at, whatever the outcome.
  const checked = [...results.passes, ...results.violations, ...results.incomplete].flatMap(
    (rule) => rule.nodes.map((node) => node.target),
  );
  /** Whether axe checked a node inside the shadow root matching `selector`. */
  const checkedInShadowRoot = (/** @type {string} */ selector) =>
    checked.some(
      (target) =>
        Array.isArray(target[0]) &&
        target[0][0] === HOST &&
        target[0].some((part) => part.includes(selector)),
    );
  return { violations: results.violations, checkedInShadowRoot, checked };
}

/** @param {import('@playwright/test').Page} page */
function cardButton(page, /** @type {string | RegExp} */ name) {
  return page.locator(HOST).getByRole('button', { name, exact: true });
}

test('the sandbox page with the card idle', async ({ page }) => {
  await page.goto('/');
  await expect(cardButton(page, 'Connect')).toBeVisible();

  const { violations, checkedInShadowRoot, checked } = await analyze(page);
  expect(violations).toEqual([]);
  expect(checkedInShadowRoot('button')).toBe(true);
  // The target app inside the iframe was analysed too (a frame target is a
  // list of plain selectors, the iframe first).
  expect(checked.some((target) => target[0] === '#target-app-frame')).toBe(true);
});

test('the sandbox page with the knowledge dialog open', async ({ page }) => {
  await page.goto('/');
  await cardButton(page, 'Knowledge files: 0').click();
  await expect(page.locator(HOST).getByRole('dialog', { name: 'Knowledge' })).toBeVisible();

  const { violations, checkedInShadowRoot } = await analyze(page);
  expect(violations).toEqual([]);
  expect(checkedInShadowRoot('textarea')).toBe(true);
});

for (const path of ['/target-app/index.html', '/target-app/settings.html']) {
  test(`the target app at ${path}`, async ({ page }) => {
    await page.goto(path);
    const { violations } = await analyze(page);
    expect(violations).toEqual([]);
  });
}
