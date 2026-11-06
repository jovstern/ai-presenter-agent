import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures.js';
import { TOKEN_OK, card, fakeGeminiLive, stubToken } from './fakeLive.js';

// The agent card in every state the spec's Screens table lists (M7 T6), on
// the real `/` page with the real bundle, through the fake-Live harness
// (fakeLive.js): the token endpoint and the Gemini Live socket are the only
// fakes, so there is no test hook in the bundle. loop.spec.js owns the tool
// loop and the token-per-reconnect accounting; a11y.spec.js owns axe on each
// screen at the default viewport and the knowledge dialog's keyboard walk.

const HOST = '#ai-presenter-agent-host';
const RECONNECT_DELAYS_MS = [0, 1000, 3000, 7000, 15000, 30000]; // liveSession.js
const MAX_ATTEMPTS = RECONNECT_DELAYS_MS.length;
const RETRYABLE = { status: 503, body: { error: { code: 'upstream', message: 'Try later' } } };

// A pause after each visible change, so the recorded demo can be followed.
// Only in this one test: it is the milestone's demo (.claude/skills/pr-demo).
const DEMO_PAUSE_MS = 700;

test.describe('the card through every connection state', () => {
  // The reconnects that fail on purpose get a stubbed 503.
  test.use({ allowedConsoleErrors: [/status of 503/] });

  test('widget demo: Talk, Live with the orb and transcript, a lost connection, Retry', async ({
    page,
  }) => {
    // The backoff's 56 s of delays are skipped with the page's clock, which
    // otherwise runs in real time.
    await page.clock.install();
    const token = await stubToken(page, TOKEN_OK);
    const live = await fakeGeminiLive(page);
    const { panel, status, orb, transcript, button, toasts } = card(page);
    const pause = () => page.waitForTimeout(DEMO_PAUSE_MS);

    // idle
    await page.goto('/');
    await expect(status).toHaveText('Not connected');
    await expect(orb).toHaveAttribute('data-active', 'false');
    await pause();

    // connecting: setupComplete held back; the same button, enabled, as a
    // pending Cancel.
    live.holdSetup(true);
    await button('Talk to the presenter').click();
    await expect(status).toHaveText('Connecting…');
    await expect(button('Cancel')).toHaveAttribute('data-pending', 'true');
    await expect(button('Cancel')).toBeEnabled();
    await expect(button('Cancel')).toBeFocused();
    await pause();
    await expect.poll(() => live.sockets.length).toBe(1);
    live.holdSetup(false);
    live.sendToLatest({ setupComplete: {} });

    // open: the orb's outer ring follows the agent's voice, and settles when
    // it stops.
    await expect(status).toHaveText('Live');
    await expect(button('End')).toBeEnabled();
    await expect(orb).toHaveAttribute('data-active', 'true');
    const level = () => orb.evaluate((node) => Number(node.style.getPropertyValue('--level')));
    expect(await level()).toBeLessThan(0.05);
    live.sendAgentAudio(1.5);
    await expect.poll(level).toBeGreaterThan(0.3);
    await expect.poll(level, { timeout: 5000 }).toBeLessThan(0.05);
    await pause();

    // The transcript: Live's fragments coalesced into turns, a speaker each.
    live.sendToLatest({ serverContent: { outputTranscription: { text: 'Hi, I can' } } });
    live.sendToLatest({ serverContent: { outputTranscription: { text: ' show you around.' } } });
    live.sendToLatest({ serverContent: { turnComplete: true } });
    live.sendToLatest({ serverContent: { inputTranscription: { text: 'Open the' } } });
    live.sendToLatest({ serverContent: { inputTranscription: { text: ' settings.' } } });
    live.sendToLatest({ serverContent: { outputTranscription: { text: 'Opening' } } });
    live.sendToLatest({ serverContent: { outputTranscription: { text: ' them now.' } } });
    await expect(transcript.getByRole('listitem')).toHaveText([
      'Presenter: Hi, I can show you around.',
      'You: Open the settings.',
      'Presenter: Opening them now.',
    ]);
    await pause();

    // A forced close: reconnecting, its attempt counted, End still enabled.
    // The reconnect's setup is held back so the first attempt stays on screen.
    live.holdSetup(true);
    await live.sockets[0].close({ code: 1011, reason: 'e2e forced close' });
    await expect(status).toHaveText(`Reconnecting (attempt 1 of ${MAX_ATTEMPTS})…`);
    await expect(button('End')).toBeEnabled();
    await expect.poll(() => live.sockets.length).toBe(2);
    await pause();

    // Every further attempt fails: the backoff runs out, each step on screen.
    token.respondWith(RETRYABLE);
    live.holdSetup(false);
    await live.sockets[1].close({ code: 1011, reason: 'e2e forced close' });
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      await expect(status).toHaveText(`Reconnecting (attempt ${attempt} of ${MAX_ATTEMPTS})…`);
      await page.clock.fastForward(RECONNECT_DELAYS_MS[attempt - 1]);
    }

    // failed: Connection lost, Retry on the same button, and one toast with
    // the reason and Dismiss; the card holds its own copy of the reason back
    // while the toast shows it — one reason, one Retry on screen.
    const reason = `Could not reconnect after ${MAX_ATTEMPTS} attempts.`;
    await expect(status).toHaveText('Connection lost');
    await expect(button('Retry')).toBeFocused();
    await expect(toasts).toHaveCount(1);
    await expect(toasts).toContainText(reason);
    await expect(toasts.getByRole('button')).toHaveText(['×Dismiss']);
    await expect(panel.getByText(reason)).toBeHidden();
    expect(token.count).toBe(1 + MAX_ATTEMPTS);
    expect(live.sockets).toHaveLength(2); // the refused tokens never opened a socket
    await pause();
    // Once per failure: a render (a transcript line) doesn't bring a second.
    live.sendToLatest({ serverContent: { outputTranscription: { text: ' Still here?' } } });
    await expect(toasts).toHaveCount(1);

    // Retry: a fresh backoff budget, and Live again; the toast goes with the failure.
    token.respondWith(TOKEN_OK);
    await button('Retry').click();
    await expect(status).toHaveText('Live');
    await expect(toasts).toHaveCount(0);
    await expect(panel).not.toContainText(reason);
    await expect(button('End')).toBeFocused();
    expect(live.sockets).toHaveLength(3);
    await pause();

    await button('End').click();
    await expect(status).toHaveText('Not connected');
    await expect(button('Talk to the presenter')).toBeFocused();
    await pause();
  });
});

test.describe('when the server has no API key', () => {
  // The stubbed 500 is logged by the browser as a failed resource load.
  test.use({ allowedConsoleErrors: [/status of 500/] });

  // A reload can't fix a missing key, so there is no Reload page: Try again,
  // on the same focused button, asks the server again (M6 T6).
  test('a not_configured token error offers Try again, not a reload, and never retries by itself', async ({
    page,
  }) => {
    const token = await stubToken(page, {
      status: 500,
      body: {
        error: { code: 'not_configured', message: "The server isn't configured to connect" },
      },
    });
    const live = await fakeGeminiLive(page);
    const { panel, status, alert, button, toasts } = card(page);
    const reason =
      "The server isn't configured to connect. Contact the site owner, then try again (you may need to reload the page).";
    // The client log's connection beacons (clientLog.js, M8 T2), as the real
    // server answered them: one per failure.
    const connectionBeacons = [];
    page.on('response', (response) => {
      if (!response.url().includes('/api/client-log')) return;
      const body = response.request().postDataJSON();
      if (body.type === 'connection') connectionBeacons.push({ body, status: response.status() });
    });
    const connectionBeacon = {
      status: 204,
      body: expect.objectContaining({ type: 'connection', kind: 'config', reason }),
    };

    await page.goto('/');
    await button('Talk to the presenter').focus();
    await page.keyboard.press('Enter');

    await expect(status).toHaveText("Can't connect");
    // The toast says the reason (and is what announces it); the card shows
    // it, as plain text, once the toast has closed, so there is no alert to
    // announce it a second time.
    await expect(alert).toHaveCount(0);
    await expect(toasts).toHaveCount(1);
    await expect(toasts).toContainText(reason);
    await expect(panel.getByText(reason)).toBeHidden();
    await expect(toasts.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    // Held, not absent: its space is kept, so the button doesn't move when
    // the toast closes (below).
    const buttonBox = await button('Try again').boundingBox();
    await expect(button('Try again')).toBeFocused();
    await expect(button('Reload page')).toHaveCount(0);
    // The backoff's first retry is immediate; give it room to (wrongly) happen.
    await page.waitForTimeout(1500);
    expect(token.count).toBe(1);
    expect(live.sockets).toHaveLength(0);
    await expect.poll(() => connectionBeacons).toEqual([connectionBeacon]);

    // The keyboard path into the toast, inside the shadow root: F8 (Radix's
    // hotkey) focuses the viewport, Tab walks the toast and Dismiss, then
    // leaves for the card's button; Escape closes the toast from inside it,
    // focus goes back to the card, and the card shows the reason.
    const viewport = page
      .locator(HOST)
      .getByRole('region', { name: 'Notifications (F8)' })
      .getByRole('list');
    await page.keyboard.press('F8');
    await expect(viewport).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(toasts).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(toasts.getByRole('button', { name: 'Dismiss', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(button('Try again')).toBeFocused();
    await page.keyboard.press('F8');
    await page.keyboard.press('Tab');
    await expect(toasts).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(toasts).toHaveCount(0);
    await expect(button('Try again')).toBeFocused();
    await expect(panel.getByText(reason)).toBeVisible();
    expect(await button('Try again').boundingBox()).toEqual(buttonBox);
    await expect(alert).toHaveCount(0);
    // Once per failure: closed, it stays closed while the failure lasts.
    await page.waitForTimeout(500);
    await expect(toasts).toHaveCount(0);

    // Try again asks the server once more, and fails the same way: a new
    // failure, so a new toast.
    await page.keyboard.press('Enter');
    await expect.poll(() => token.count).toBe(2);
    await expect(toasts).toHaveCount(1);
    await expect(button('Try again')).toBeFocused();
    expect(live.sockets).toHaveLength(0);
    await expect.poll(() => connectionBeacons).toEqual([connectionBeacon, connectionBeacon]);
  });
});

test.describe('when the page nonce is rejected', () => {
  test.use({ allowedConsoleErrors: [/status of 403/] });

  // A rejected nonce is this page's own problem: a reload brings a fresh one.
  test('a 403 token error offers Reload page, never retries, and Reload page reloads', async ({
    page,
  }) => {
    const token = await stubToken(page, {
      status: 403,
      body: { error: { code: 'invalid_nonce', message: 'Unknown or expired nonce' } },
    });
    const { panel, status, button, toasts } = card(page);
    const reason = 'This page can no longer get a connection token. Reload the page to reconnect.';

    await page.goto('/');
    await button('Talk to the presenter').focus();
    await page.keyboard.press('Enter');

    await expect(status).toHaveText("Can't connect");
    await expect(toasts).toContainText(reason);
    await expect(panel.getByText(reason)).toBeHidden();
    await expect(button('Reload page')).toBeFocused();
    // Dismissed, the card shows the reason in the space it kept: Reload page stays put.
    const buttonBox = await button('Reload page').boundingBox();
    await toasts.getByRole('button', { name: 'Dismiss' }).click();
    await expect(toasts).toHaveCount(0);
    await expect(panel.getByText(reason)).toBeVisible();
    expect(await button('Reload page').boundingBox()).toEqual(buttonBox);
    await button('Reload page').focus();
    await page.waitForTimeout(1500);
    expect(token.count).toBe(1);

    // The page really reloads: a fresh card, idle, no failure left over.
    await Promise.all([page.waitForEvent('load'), page.keyboard.press('Enter')]);
    await expect(status).toHaveText('Not connected');
    await expect(toasts).toHaveCount(0);
  });
});

// A blocked mic is something on this side to fix, not a connection failing:
// guidance in the card (an alert), no toast, and the card back on Talk, the
// action the guidance names.
test('a blocked microphone shows the guidance and leaves the card on Talk', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await stubToken(page, TOKEN_OK);
  await fakeGeminiLive(page);
  const { status, alert, button, toasts } = card(page);

  await page.goto('/');
  await button('Talk to the presenter').click();
  await expect(alert).toHaveText(
    'Microphone blocked — allow it in the address bar and press Talk to the presenter.',
  );
  await expect(status).toHaveText('Not connected');
  await expect(button('Talk to the presenter')).toBeVisible();
  await expect(toasts).toHaveCount(0);
});

// Phone, tablet and desktop (spec Screens and Layout): the card's place, a
// keyboard walk through all of it, the dialog making the card inert, and axe
// in both themes on the connected card with a transcript.
const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
const GUTTER = 16;
const CARD_WIDTH = 344;
// Longer than the transcript box at any width, so it scrolls.
const LONG_TURN = Array.from(
  { length: 12 },
  (_, i) => `Sentence ${i + 1} of a long answer that wraps in the card.`,
).join(' ');

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.width} px`, () => {
    test.use({ viewport });

    test('the card fits, the keyboard walks all of it, the dialog makes it inert, and axe passes in light and dark', async ({
      page,
    }) => {
      await stubToken(page, TOKEN_OK);
      const live = await fakeGeminiLive(page);
      const { panel, status, transcript, button } = card(page);
      const knowledge = button('Knowledge files: 0');
      await page.goto('/');

      // Placement: bottom-right with the gutter; at 400 px and below, the
      // full width between the gutters.
      const box = await page.locator(HOST).boundingBox();
      expect(box).not.toBeNull();
      if (!box) return;
      expect(box.x + box.width).toBeCloseTo(viewport.width - GUTTER, 0);
      expect(box.y + box.height).toBeCloseTo(viewport.height - GUTTER, 0);
      expect(box.width).toBeCloseTo(
        viewport.width <= 400 ? viewport.width - 2 * GUTTER : CARD_WIDTH,
        0,
      );

      // Tab from the top of the page (the host page, then the target app's
      // iframe) reaches the card's primary button, with a visible focus ring.
      const talk = button('Talk to the presenter');
      for (let i = 0; i < 40 && !(await isFocused(talk)); i++) {
        await page.keyboard.press('Tab');
      }
      await expect(talk).toBeFocused();
      await expect(talk).toHaveCSS('outline-style', 'solid');
      await page.keyboard.press('Enter');
      await expect(status).toHaveText('Live');
      await expect(button('End')).toBeFocused();

      // A transcript that fits is no Tab stop; once it overflows, its
      // scrollable region is one, before the button, with the focus ring on
      // the unmasked box around it.
      live.sendToLatest({ serverContent: { outputTranscription: { text: 'Welcome.' } } });
      await expect(transcript.getByRole('listitem')).toHaveText(['Presenter: Welcome.']);
      await expect(transcript).not.toHaveAttribute('tabindex');
      live.sendToLatest({ serverContent: { outputTranscription: { text: ` ${LONG_TURN}` } } });
      await expect(transcript).toHaveAttribute('tabindex', '0');
      await page.keyboard.press('Shift+Tab');
      await expect(transcript).toBeFocused();
      await expect(transcript.locator('..')).toHaveCSS('outline-style', 'solid');
      await page.keyboard.press('Tab');
      await expect(button('End')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(knowledge).toBeFocused();
      await expect(knowledge).toHaveCSS('outline-style', 'solid');

      // The dialog: inside the viewport, and the card behind it inert, so
      // it leaves the accessibility tree (Radix's aria-hidden never reaches
      // into the shadow root); closed, the card is back and focus returns.
      await page.keyboard.press('Enter');
      const dialog = page.locator(HOST).getByRole('dialog', { name: 'Knowledge' });
      await expect(dialog).toBeVisible();
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox).not.toBeNull();
      if (!dialogBox) return;
      expect(dialogBox.x).toBeGreaterThanOrEqual(GUTTER - 1);
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width - GUTTER + 1);
      await expect(page.locator(HOST).locator('[inert]')).toContainText('Welcome.');
      await expect.poll(() => exposed(page, 'dialog', 'Knowledge')).toBe(true);
      await expect.poll(() => exposed(page, 'complementary', 'AI presenter')).toBe(false);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.locator(HOST).locator('[inert]')).toHaveCount(0);
      await expect.poll(() => exposed(page, 'complementary', 'AI presenter')).toBe(true);
      await expect(knowledge).toBeFocused();

      for (const colorScheme of /** @type {const} */ (['light', 'dark'])) {
        await page.emulateMedia({ colorScheme });
        // The theme has switched, and the primary button's colour transition
        // has ended, so axe reads this scheme's colours, not a blend.
        const dark = colorScheme === 'dark';
        await expect(panel).toHaveCSS(
          'background-color',
          dark ? 'rgb(24, 24, 27)' : 'rgb(255, 255, 255)',
        );
        await expect(button('End')).toHaveCSS(
          'background-color',
          dark ? 'rgb(129, 140, 248)' : 'rgb(79, 70, 229)',
        );
        const results = await new AxeBuilder({ page }).include(HOST).analyze();
        expect(results.violations, `${colorScheme} scheme`).toEqual([]);
        // axe did walk the shadow root (a shadow-piercing target starts with the host).
        const inShadowRoot = results.passes.flatMap((rule) =>
          rule.nodes.filter(({ target }) => Array.isArray(target[0]) && target[0][0] === HOST),
        );
        expect(inShadowRoot.length).toBeGreaterThan(0);
      }

      // Back to the button, and End by keyboard.
      await page.keyboard.press('Shift+Tab');
      await expect(button('End')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(status).toHaveText('Not connected');
      await expect(talk).toBeFocused();
    });
  });
}

/** @typedef {{ value: number, time: number, recent: boolean }} LayoutShift */

// The card is anchored to the viewport's bottom, so a transcript that grew
// with its text moved the card's top edge on every wrapped line: CLS 0.15 at
// phone width (docs/metrics/m07.md, miss 1). The box is now a fixed height
// from the press that starts the session, and follows the newest line by
// scrolling, which isn't a shift.
test.describe('at 390 px, while the transcript grows', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the card does not shift (worst CLS session window ≤ 0.05) and the newest line stays in view', async ({
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
        for (const entry of entries) {
          shifts.push({ value: entry.value, time: entry.startTime, recent: entry.hadRecentInput });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await stubToken(page, TOKEN_OK);
    const live = await fakeGeminiLive(page);
    const { status, transcript, button } = card(page);
    await page.goto('/');
    await button('Talk to the presenter').click();
    await expect(status).toHaveText('Live');
    // Past the press's 500 ms input window: what follows is speech, not input.
    await page.waitForTimeout(600);
    const start = await page.evaluate(() => performance.now());

    // Six turns, agent and user in turn, a word at a time, each longer than the last.
    const words = LONG_TURN.split(' ');
    for (let turn = 0; turn < 6; turn++) {
      const kind = turn % 2 ? 'inputTranscription' : 'outputTranscription';
      for (const word of words.slice(0, 8 + turn * 2)) {
        live.sendToLatest({ serverContent: { [kind]: { text: ` ${word}` } } });
        await page.waitForTimeout(40);
      }
      if (turn % 2 === 0) live.sendToLatest({ serverContent: { turnComplete: true } });
    }
    await expect(transcript.getByRole('listitem')).toHaveCount(6);
    await expect
      .poll(() => transcript.evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight))
      .toBeLessThanOrEqual(4);
    await expect(transcript).toHaveAttribute('tabindex', '0');

    // CLS session windows: shifts less than 1 s apart, at most 5 s long.
    await page.waitForTimeout(200);
    const shifts = await page.evaluate(
      (since) =>
        /** @type {Window & { __layoutShifts: LayoutShift[] }} */ (window).__layoutShifts.filter(
          (shift) => shift.time >= since && !shift.recent,
        ),
      start,
    );
    let worst = 0;
    let session = { start: -Infinity, last: -Infinity, sum: 0 };
    for (const shift of shifts) {
      if (shift.time - session.last < 1000 && shift.time - session.start < 5000) {
        session.sum += shift.value;
        session.last = shift.time;
      } else {
        session = { start: shift.time, last: shift.time, sum: shift.value };
      }
      worst = Math.max(worst, session.sum);
    }
    expect(worst, JSON.stringify(shifts)).toBeLessThanOrEqual(0.05);
  });
});

/**
 * Whether Chromium's own accessibility tree (what a screen reader browses)
 * exposes a node with this role and name. Playwright's role locators don't
 * treat `inert` as hidden, so the browser is asked directly.
 * @param {import('@playwright/test').Page} page
 * @param {string} role
 * @param {string} name
 */
async function exposed(page, role, name) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    return nodes.some(
      (node) => !node.ignored && node.role?.value === role && node.name?.value === name,
    );
  } finally {
    await cdp.detach();
  }
}

/** Whether `locator` has focus in its own tree (the shadow root's, for the card). */
function isFocused(/** @type {import('@playwright/test').Locator} */ locator) {
  return locator.evaluate((node) => {
    const root = node.getRootNode();
    return root instanceof ShadowRoot && root.activeElement === node;
  });
}
