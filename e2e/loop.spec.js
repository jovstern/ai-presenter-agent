import { test, expect } from './fixtures.js';
import { TOKEN_OK, card, fakeGeminiLive, pageNonce, stubToken } from './fakeLive.js';

// The M4 demo flow on the real `/` page, with no key: the real agent-client
// bundle, the real @google/genai socket code, the real bridge and target app.
// Only the two network edges are faked: /api/live-token (page.route) and the
// Gemini Live socket (page.routeWebSocket, so the SDK opens a real browser
// WebSocket that Playwright answers instead of Google). The mic is Chromium's
// fake device (playwright.config.js). This puts B2 (one reconnect and one
// token per drop), H4 (in-order tool batches) and the tool loop in CI. The
// card's own states (pending Cancel, the failures and their toasts) are
// widget.spec.js's.

/**
 * The nodes a `page` lists: a keyframe's all, a delta's changed ones.
 * @param {string} page
 */
function snapshotNodes(page) {
  return JSON.parse(page.split('\n')[1]);
}

/**
 * The counter's value in a `page`, if the snapshot lists it.
 * @param {string} page
 */
function counterIn(page) {
  return snapshotNodes(page).find(
    (/** @type {{ selector: string }} */ node) => node.selector === 'counter-value',
  )?.label;
}

test('a tool batch drives the iframe and the session survives a dropped socket', async ({
  page,
}) => {
  const token = await stubToken(page, TOKEN_OK);
  const live = await fakeGeminiLive(page);
  const { status, button } = card(page);
  const frame = page.frameLocator('#target-app-frame');

  await page.goto('/');
  await expect(status).toHaveText('Not connected');

  await button('Talk to the AI Presenter').click();
  await expect(status).toHaveText('Live');
  await expect(button('End')).toBeVisible();
  expect(token.count).toBe(1);
  expect(live.sockets).toHaveLength(1);
  // The token request echoes the page's own nonce (H1).
  const nonce = await pageNonce(page);
  expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
  expect(token.nonces).toEqual([nonce]);

  // One batch, two calls that must run in order: the click targets an element
  // that exists only once the navigate's page has loaded (H4).
  live.sendToLatest({
    toolCall: {
      functionCalls: [
        { id: 'call-navigate', name: 'navigate', args: { route: 'settings' } },
        { id: 'call-toggle', name: 'click', args: { selector: 'notifications-toggle' } },
      ],
    },
  });

  await expect(frame.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(frame.getByTestId('notifications-toggle')).toBeChecked();
  await expect.poll(() => live.toolResponses()).toHaveLength(2);
  // The settings page's keyframe rides in the navigate's own response, so the
  // model continues from the new page (liveSession.js); the toggle is named by
  // its label and reports its state (bridge.js).
  const [navigateResponse, toggleResponse] = live.toolResponses();
  expect(navigateResponse).toEqual({
    id: 'call-navigate',
    name: 'navigate',
    response: { success: true, page: expect.stringMatching(/^Page snapshot \(full\):/) },
  });
  expect(JSON.parse(navigateResponse.response.page.split('\n')[1])).toContainEqual({
    selector: 'notifications-toggle',
    tag: 'input',
    label: 'Enable notifications',
    disabled: false,
    hidden: false,
    checked: false,
  });
  // The click's own response carries the page it left: the bridge waits for
  // the page to settle and sends that snapshot before the result (#25).
  expect(toggleResponse).toEqual({
    id: 'call-toggle',
    name: 'click',
    response: { success: true, page: expect.stringMatching(/^Page snapshot \(delta\)/) },
  });
  expect(snapshotNodes(toggleResponse.response.page)).toContainEqual(
    expect.objectContaining({ selector: 'notifications-toggle', checked: true }),
  );

  // The server drops the socket. The reconnect's setupComplete is held back so
  // the page is seen waiting in `reconnecting` before it is Live again.
  live.holdSetup(true);
  await live.sockets[0].close({ code: 1011, reason: 'e2e forced close' });
  await expect(status).toHaveText('Reconnecting (attempt 1 of 6)…');
  await expect(button('End')).toBeEnabled();
  await expect.poll(() => live.sockets.length).toBe(2);
  expect(token.count).toBe(2); // exactly one fresh token for the one reconnect

  live.holdSetup(false);
  live.sendToLatest({ setupComplete: {} });
  await expect(status).toHaveText('Live');
  expect(token.nonces).toEqual([nonce, nonce]); // reusable within its TTL, by design (H1)
  expect(live.sockets).toHaveLength(2);

  await button('End').click();
  await expect(status).toHaveText('Not connected');
  await expect(button('Talk to the AI Presenter')).toBeFocused();
  // No retry was scheduled behind the hang-up.
  await page.waitForTimeout(1500);
  expect(token.count).toBe(2);
  expect(live.sockets).toHaveLength(2);
});

// #25: each action's response says what it did to the page, so a model asked
// to "increment the counter to 3" can see where the counter is after each
// click instead of getting three bare successes.
test('every click of a batch answers with the page it left: the counter at 1, 2, 3', async ({
  page,
}) => {
  await stubToken(page, TOKEN_OK);
  const live = await fakeGeminiLive(page);
  const { status, button } = card(page);
  const frame = page.frameLocator('#target-app-frame');

  await page.goto('/');
  await button('Talk to the AI Presenter').click();
  await expect(status).toHaveText('Live');
  await expect(frame.getByTestId('counter-value')).toHaveText('0');

  const clicks = [1, 2, 3].map((n) => ({
    id: `inc-${n}`,
    name: 'click',
    args: { selector: 'counter-increment' },
  }));
  live.sendToLatest({ toolCall: { functionCalls: clicks } });

  await expect.poll(() => live.toolResponses()).toHaveLength(3);
  await expect(frame.getByTestId('counter-value')).toHaveText('3');
  const responses = live.toolResponses();
  expect(responses.map((r) => r.id)).toEqual(['inc-1', 'inc-2', 'inc-3']);
  expect(responses.map((r) => r.response.success)).toEqual([true, true, true]);
  expect(responses.map((r) => counterIn(r.response.page))).toEqual(['1', '2', '3']);

  await button('End').click();
  await expect(status).toHaveText('Not connected');
});

// #25: the loop guard judges an action on the page it was taken on, so ten
// identical clicks that each move the counter on are progress, not a loop
// (the old guard refused the 4th: "I can't repeat the action further").
test('ten identical counter clicks all run: the counter reaches 10', async ({ page }) => {
  await stubToken(page, TOKEN_OK);
  const live = await fakeGeminiLive(page);
  const { status, button } = card(page);
  const frame = page.frameLocator('#target-app-frame');

  await page.goto('/');
  await button('Talk to the AI Presenter').click();
  await expect(status).toHaveText('Live');
  await expect(frame.getByTestId('counter-value')).toHaveText('0');

  const clicks = Array.from({ length: 10 }, (_, i) => ({
    id: `inc-${i + 1}`,
    name: 'click',
    args: { selector: 'counter-increment' },
  }));
  live.sendToLatest({ toolCall: { functionCalls: clicks } });

  await expect.poll(() => live.toolResponses()).toHaveLength(10);
  await expect(frame.getByTestId('counter-value')).toHaveText('10');
  const responses = live.toolResponses();
  expect(responses.map((r) => r.response.success)).toEqual(Array(10).fill(true));
  expect(responses.map((r) => counterIn(r.response.page))).toEqual(
    Array.from({ length: 10 }, (_, i) => String(i + 1)),
  );

  await button('End').click();
  await expect(status).toHaveText('Not connected');
});

// #28: "turn notifications on and save, then off and save" is two rounds of
// toggle, save; the loop guard refused the 4th call as an A-B-A-B cycle. Two
// rounds now pass (a third is refused, loopGuard.test.js).
test('an explicit two-round request runs: on, save, off, save all succeed', async ({ page }) => {
  await stubToken(page, TOKEN_OK);
  const live = await fakeGeminiLive(page);
  const { status, button } = card(page);
  const frame = page.frameLocator('#target-app-frame');

  await page.goto('/');
  await button('Talk to the AI Presenter').click();
  await expect(status).toHaveText('Live');

  const toggle = (/** @type {string} */ id) => ({
    id,
    name: 'click',
    args: { selector: 'notifications-toggle' },
  });
  const save = (/** @type {string} */ id) => ({
    id,
    name: 'click',
    args: { selector: 'save-button' },
  });
  live.sendToLatest({
    toolCall: {
      functionCalls: [
        { id: 'call-navigate', name: 'navigate', args: { route: 'settings' } },
        toggle('on'),
        save('save-1'),
        toggle('off'),
        save('save-2'),
      ],
    },
  });

  await expect.poll(() => live.toolResponses()).toHaveLength(5);
  const responses = live.toolResponses();
  expect(responses.map((r) => r.id)).toEqual(['call-navigate', 'on', 'save-1', 'off', 'save-2']);
  expect(responses.map((r) => r.response.success)).toEqual(Array(5).fill(true));
  expect(responses.some((r) => 'error' in r.response)).toBe(false);
  expect(snapshotNodes(responses[1].response.page)).toContainEqual(
    expect.objectContaining({ selector: 'notifications-toggle', checked: true }),
  );
  expect(snapshotNodes(responses[3].response.page)).toContainEqual(
    expect.objectContaining({ selector: 'notifications-toggle', checked: false }),
  );
  await expect(frame.getByTestId('notifications-toggle')).not.toBeChecked();
  await expect(frame.getByTestId('save-confirmation')).toBeVisible();

  await button('End').click();
  await expect(status).toHaveText('Not connected');
});

// M9 demo: the dense Orders page (#22) driven one call at a time, the way a
// model works it: go there, tick two orders, ship them. Each response carries
// the page after it, and the count follows the ticks.
test('the agent works the Orders page: two orders ticked and shipped', async ({ page }) => {
  await stubToken(page, TOKEN_OK);
  const live = await fakeGeminiLive(page);
  const { status, button } = card(page);
  const frame = page.frameLocator('#target-app-frame');

  await page.goto('/');
  await page.waitForTimeout(1000);
  await button('Talk to the AI Presenter').click();
  await expect(status).toHaveText('Live');
  await page.waitForTimeout(1000);

  const calls = [
    { name: 'navigate', args: { route: 'orders' } },
    { name: 'click', args: { selector: 'order-1003-select' } },
    { name: 'click', args: { selector: 'order-1004-select' } },
    { name: 'click', args: { selector: 'ship-selected' } },
  ];
  for (const [i, call] of calls.entries()) {
    live.sendToLatest({ toolCall: { functionCalls: [{ id: `orders-${i}`, ...call }] } });
    await expect.poll(() => live.toolResponses()).toHaveLength(i + 1);
    await page.waitForTimeout(1000);
  }

  expect(live.toolResponses().map((r) => r.response.success)).toEqual([true, true, true, true]);
  await expect(frame.getByTestId('orders-selected-count')).toHaveText('0 selected');
  await expect(frame.getByTestId('order-1003-ship')).toBeDisabled();
  await expect(frame.getByTestId('order-1004-ship')).toBeDisabled();
  await expect(frame.getByTestId('order-1005-ship')).toBeEnabled();

  await button('End').click();
  await expect(status).toHaveText('Not connected');
});

// #25 review: a link click leaves the old document unchanged, so its quiet
// window used to pass and answer with an empty delta of the page being left.
// The bridge now waits for the new page (here 300 ms late) and its response
// carries the Settings keyframe.
test('a link click answers with the page it opened, not the one it left', async ({ page }) => {
  await stubToken(page, TOKEN_OK);
  const live = await fakeGeminiLive(page);
  const { status, button } = card(page);
  const frame = page.frameLocator('#target-app-frame');
  await page.route('**/target-app/settings.html', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });

  await page.goto('/');
  await button('Talk to the AI Presenter').click();
  await expect(status).toHaveText('Live');
  await expect(frame.getByTestId('counter-value')).toHaveText('0');

  live.sendToLatest({
    toolCall: {
      functionCalls: [{ id: 'call-link', name: 'click', args: { selector: 'nav-settings' } }],
    },
  });

  await expect.poll(() => live.toolResponses()).toHaveLength(1);
  const [linkResponse] = live.toolResponses();
  expect(linkResponse).toEqual({
    id: 'call-link',
    name: 'click',
    response: { success: true, page: expect.stringMatching(/^Page snapshot \(full\):/) },
  });
  const selectors = snapshotNodes(linkResponse.response.page).map((node) => node.selector);
  expect(selectors).toContain('notifications-toggle');
  expect(selectors).not.toContain('counter-value');
  await expect(frame.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await button('End').click();
  await expect(status).toHaveText('Not connected');
});
