import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';
import { card, fakeGeminiLive, stubToken } from './fakeLive.js';

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

// Both themes (styles.css redefines its colour tokens under
// prefers-color-scheme: dark), so axe's colour-contrast rule checks each one.
for (const colorScheme of /** @type {const} */ (['light', 'dark'])) {
  test.describe(`${colorScheme} scheme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme });
    });

    test('the sandbox page with the card idle', async ({ page }) => {
      await page.goto('/');
      await expect(cardButton(page, 'Connect')).toBeVisible();
      // The theme really switched (--color-surface), so axe saw this scheme's colours.
      await expect(page.locator(HOST).locator('.agent-app')).toHaveCSS(
        'background-color',
        colorScheme === 'dark' ? 'rgb(24, 24, 27)' : 'rgb(255, 255, 255)',
      );

      const { violations, checkedInShadowRoot, checked } = await analyze(page);
      expect(violations).toEqual([]);
      // axe names the card's primary button by its class.
      expect(checkedInShadowRoot('.agent-app__primary')).toBe(true);
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
  });
}

// Connected through the fake-Live harness (loop.spec.js) with a transcript
// line on screen: the transcript is what axe's `region` rule flagged before
// the card became a named landmark (docs/metrics/m06.md, observer miss 1).
test('the sandbox page with the card connected and a transcript line', async ({ page }) => {
  await stubToken(page, { status: 200, body: { token: 'e2e-token' } });
  const live = await fakeGeminiLive(page);
  const { status, button } = card(page);

  await page.goto('/');
  await button('Connect').click();
  await expect(status).toHaveText('Live');
  // Fragments as Live streams them: coalesced into one turn (transcript.js).
  live.sendToLatest({ serverContent: { outputTranscription: { text: 'Hello' } } });
  live.sendToLatest({ serverContent: { outputTranscription: { text: ' there.' } } });
  const transcript = page.locator(HOST).getByRole('region', { name: 'Transcript' });
  await expect(transcript.getByRole('listitem')).toHaveText(['Presenter: Hello there.']);
  await expect(transcript.getByText('Hello there.')).toBeVisible();

  const { violations, checkedInShadowRoot } = await analyze(page);
  expect(violations).toEqual([]);
  expect(checkedInShadowRoot('li')).toBe(true);
});

for (const path of ['/target-app/index.html', '/target-app/settings.html']) {
  test(`the target app at ${path}`, async ({ page }) => {
    await page.goto(path);
    const { violations } = await analyze(page);
    expect(violations).toEqual([]);
  });
}
