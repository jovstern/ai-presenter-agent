import { test, expect } from './fixtures.js';
import { card, fakeGeminiLive, pageNonce, stubToken } from './fakeLive.js';

// The M4 demo flow on the real `/` page, with no key: the real agent-client
// bundle, the real @google/genai socket code, the real bridge and target app.
// Only the two network edges are faked: /api/live-token (page.route) and the
// Gemini Live socket (page.routeWebSocket, so the SDK opens a real browser
// WebSocket that Playwright answers instead of Google). The mic is Chromium's
// fake device (playwright.config.js). This puts B2 (one reconnect and one
// token per drop), H4 (in-order tool batches) and the tool loop in CI.

test('a tool batch drives the iframe and the session survives a dropped socket', async ({
  page,
}) => {
  const token = await stubToken(page, { status: 200, body: { token: 'e2e-token' } });
  const live = await fakeGeminiLive(page);
  const { status, button } = card(page);
  const frame = page.frameLocator('#target-app-frame');

  await page.goto('/');
  await expect(status).toHaveText('Not connected');

  // setupComplete held back, to see the pending state: the same button,
  // still enabled, as a pending Cancel.
  live.holdSetup(true);
  await button('Talk to the presenter').click();
  await expect(status).toHaveText('Connecting…');
  await expect(button('Cancel')).toHaveAttribute('data-pending', 'true');
  await expect(button('Cancel')).toBeEnabled();
  await expect.poll(() => live.sockets.length).toBe(1);
  live.holdSetup(false);
  live.sendToLatest({ setupComplete: {} });
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
  // Only id, name and success: whether the click's own snapshot rides along
  // as `page` depends on the bridge's 250 ms debounce outlasting a port round
  // trip, which is timing, not behaviour (liveSession.test.js covers both).
  expect(toggleResponse).toMatchObject({
    id: 'call-toggle',
    name: 'click',
    response: { success: true },
  });

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
  await expect(button('Talk to the presenter')).toBeFocused();
  // No retry was scheduled behind the hang-up.
  await page.waitForTimeout(1500);
  expect(token.count).toBe(2);
  expect(live.sockets).toHaveLength(2);
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

    await page.goto('/');
    await button('Talk to the presenter').focus();
    await page.keyboard.press('Enter');

    await expect(status).toHaveText("Can't connect");
    // The reason stays in the card as plain text; the toast is what announces
    // it, so there is no alert to announce it a second time.
    await expect(panel).toContainText(reason);
    await expect(alert).toHaveCount(0);
    await expect(toasts).toHaveCount(1);
    await expect(toasts).toContainText(reason);
    await expect(toasts.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(button('Try again')).toBeFocused();
    await expect(button('Reload page')).toHaveCount(0);
    // The backoff's first retry is immediate; give it room to (wrongly) happen.
    await page.waitForTimeout(1500);
    expect(token.count).toBe(1);
    expect(live.sockets).toHaveLength(0);

    // The keyboard path into the toast, inside the shadow root: F8 (Radix's
    // hotkey) focuses the viewport, Tab walks the toast, its action and
    // Dismiss, then leaves for the card's button; Escape closes the toast from
    // inside it and focus goes back to the card.
    const viewport = page
      .locator('#ai-presenter-agent-host')
      .getByRole('region', { name: 'Notifications (F8)' })
      .getByRole('list');
    await page.keyboard.press('F8');
    await expect(viewport).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(toasts).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(toasts.getByRole('button', { name: 'Try again', exact: true })).toBeFocused();
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
  });
});

test.describe('when the page nonce is rejected', () => {
  test.use({ allowedConsoleErrors: [/status of 403/] });

  // A rejected nonce is this page's own problem: a reload brings a fresh one.
  test('a 403 token error offers Reload page and never retries', async ({ page }) => {
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
    await expect(panel).toContainText(reason);
    await expect(toasts).toContainText(reason);
    await expect(toasts.getByRole('button', { name: 'Reload page', exact: true })).toBeVisible();
    await expect(button('Reload page')).toBeFocused();
    await page.waitForTimeout(1500);
    expect(token.count).toBe(1);
  });
});
