import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';
import { TOKEN_OK, card, fakeGeminiLive, stubToken } from './fakeLive.js';

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
      await expect(cardButton(page, 'Talk to the AI Presenter')).toBeVisible();
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

    test.describe('with the page nonce rejected', () => {
      test.use({ allowedConsoleErrors: [/status of 403/] });

      // The failed card and its toast (Radix, in the shadow root), this theme's colours.
      test('the sandbox page with the card failed and its toast', async ({ page }) => {
        await stubToken(page, {
          status: 403,
          body: { error: { code: 'invalid_nonce', message: 'Unknown or expired nonce' } },
        });
        const { status, button, toasts } = card(page);
        await page.goto('/');
        await button('Talk to the AI Presenter').click();
        await expect(status).toHaveText("Can't connect");
        await expect(toasts).toHaveCount(1);
        // The toast slides in from opacity 0: axe sampling mid-fade read its
        // colours blended with the page (1 flaky contrast failure in 26 runs,
        // docs/metrics/m07.md miss 2), so it waits for the toast to settle.
        await settled(toasts.first());

        const { violations, checkedInShadowRoot } = await analyze(page);
        expect(violations).toEqual([]);
        expect(checkedInShadowRoot('.toast')).toBe(true);
      });
    });

    test('the sandbox page with the knowledge dialog open', async ({ page }) => {
      await page.goto('/');
      await cardButton(page, 'Knowledge files: 0').click();
      const dialog = page.locator(HOST).getByRole('dialog', { name: 'Knowledge' });
      await expect(dialog).toBeVisible();
      // The dialog and its overlay fade in (styles.css): axe sampling mid-fade
      // would read blended colours, as with the toast above, so it waits for
      // both to settle.
      await settled(dialog);
      await settled(page.locator(HOST).locator('.knowledge-modal__overlay'));

      const { violations, checkedInShadowRoot } = await analyze(page);
      expect(violations).toEqual([]);
      // The dialog's controls (axe names the rules field by its generated id,
      // so its label stands in for it).
      expect(checkedInShadowRoot('.knowledge-modal__dropzone')).toBe(true);
      expect(checkedInShadowRoot('label')).toBe(true);
    });

    // Keyboard only, in the real shadow root, where document.activeElement is
    // the host: Radix's own trap let Tab walk out of the dialog and Escape
    // left focus nowhere (KnowledgeModal.jsx). The file picker is reached by
    // Enter on Add files, and Tab then wraps inside the dialog both ways.
    test('the knowledge dialog by keyboard: picker, Tab wraps, Escape returns focus', async ({
      page,
    }) => {
      await page.goto('/');
      const knowledge = cardButton(page, 'Knowledge files: 0');
      await expect(knowledge).toBeVisible();
      // Tab from the top of the page to the knowledge button.
      for (let i = 0; i < 30 && !(await isFocused(knowledge)); i++) {
        await page.keyboard.press('Tab');
      }
      await expect(knowledge).toBeFocused();

      await page.keyboard.press('Enter');
      const dialog = page.locator(HOST).getByRole('dialog', { name: 'Knowledge' });
      await expect(dialog).toBeVisible();
      const add = dialog.getByRole('button', { name: /^Add files/ });
      await expect(add).toBeFocused();

      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.keyboard.press('Enter'),
      ]);
      await chooser.setFiles({
        name: 'notes.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('# Pricing\nThe pro plan is $20.'),
      });
      const remove = dialog.getByRole('button', { name: 'Remove notes.md', exact: true });
      await expect(remove).toBeVisible();
      await expect(add).toBeFocused();

      // Forward through every control, and from the last back to the first.
      const rules = dialog.getByRole('textbox', { name: 'Rules' });
      const close = dialog.getByRole('button', { name: 'Close', exact: true });
      for (const next of [remove, rules, close, add]) {
        await page.keyboard.press('Tab');
        await expect(next).toBeFocused();
      }
      // And backwards from the first to the last.
      await page.keyboard.press('Shift+Tab');
      await expect(close).toBeFocused();

      const { violations, checkedInShadowRoot } = await analyze(page);
      expect(violations).toEqual([]);
      expect(checkedInShadowRoot('.knowledge-modal__file-name')).toBe(true);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(cardButton(page, 'Knowledge files: 1')).toBeFocused();
    });
  });
}

/** Resolves once every animation on `locator`'s element and its subtree has finished. */
function settled(/** @type {import('@playwright/test').Locator} */ locator) {
  return locator.evaluate((node) =>
    Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)),
  );
}

/** Whether `locator` has focus in its own tree (the shadow root's, for the card). */
function isFocused(/** @type {import('@playwright/test').Locator} */ locator) {
  return locator.evaluate((node) => {
    const root = node.getRootNode();
    return root instanceof ShadowRoot && root.activeElement === node;
  });
}

// Connected through the fake-Live harness (loop.spec.js) with a transcript
// line on screen: the transcript is what axe's `region` rule flagged before
// the card became a named landmark (docs/metrics/m06.md, observer miss 1).
test('the sandbox page with the card connected and a transcript line', async ({ page }) => {
  await stubToken(page, TOKEN_OK);
  const live = await fakeGeminiLive(page);
  const { status, button } = card(page);

  await page.goto('/');
  await button('Talk to the AI Presenter').click();
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
