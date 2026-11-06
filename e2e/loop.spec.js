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

test('a tool batch drives the iframe and the session survives a dropped socket', async ({
  page,
}) => {
  const token = await stubToken(page, TOKEN_OK);
  const live = await fakeGeminiLive(page);
  const { status, button } = card(page);
  const frame = page.frameLocator('#target-app-frame');

  await page.goto('/');
  await expect(status).toHaveText('Not connected');

  await button('Talk to the presenter').click();
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
