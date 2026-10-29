import { test, expect } from './fixtures.js';

// The M4 demo flow on the real `/` page, with no key: the real agent-client
// bundle, the real @google/genai socket code, the real bridge and target app.
// Only the two network edges are faked: /api/live-token (page.route) and the
// Gemini Live socket (page.routeWebSocket, so the SDK opens a real browser
// WebSocket that Playwright answers instead of Google). The mic is Chromium's
// fake device (playwright.config.js). This puts B2 (one reconnect and one
// token per drop), H4 (in-order tool batches) and the tool loop in CI.

const LIVE_SOCKET = /^wss:\/\/generativelanguage\.googleapis\.com\//;
const TOKEN_PATH = '/api/live-token?*';

/**
 * A fake Gemini Live server. Each socket the page opens is answered here;
 * `setupComplete` goes out when the SDK sends its `setup`, unless the test
 * holds it back to watch the page wait.
 * @param {import('@playwright/test').Page} page
 */
async function fakeGeminiLive(page) {
  /** @type {import('@playwright/test').WebSocketRoute[]} */
  const sockets = [];
  // Client frames, parsed, per socket.
  const sent = [];
  let holdSetup = false;

  await page.routeWebSocket(LIVE_SOCKET, (ws) => {
    const frames = [];
    sockets.push(ws);
    sent.push(frames);
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message));
      frames.push(frame);
      if (frame.setup && !holdSetup) ws.send(JSON.stringify({ setupComplete: {} }));
    });
  });

  return {
    sockets,
    /** @param {boolean} hold */
    holdSetup(hold) {
      holdSetup = hold;
    },
    /** @param {object} message */
    sendToLatest(message) {
      sockets.at(-1)?.send(JSON.stringify(message));
    },
    /** The `toolResponse` frames the page sent, across every socket, in order. */
    toolResponses() {
      return sent.flat().flatMap((frame) => frame.toolResponse?.functionResponses ?? []);
    },
  };
}

/**
 * Stubs the token endpoint and records the nonce each call carried.
 * @param {import('@playwright/test').Page} page
 * @param {{ status: number, body: object }} reply
 */
async function stubToken(page, reply) {
  /** @type {(string | null)[]} */
  const nonces = [];
  await page.route(TOKEN_PATH, async (route) => {
    nonces.push(new URL(route.request().url()).searchParams.get('nonce'));
    await route.fulfill({ status: reply.status, json: reply.body });
  });
  return {
    get count() {
      return nonces.length;
    },
    nonces,
  };
}

/**
 * The nonce the server templated into this page (server/app.js, H1).
 * @param {import('@playwright/test').Page} page
 */
function pageNonce(page) {
  return page.locator('script[data-ds-nonce]').getAttribute('data-ds-nonce');
}

/** @param {import('@playwright/test').Page} page */
function card(page) {
  const host = page.locator('#ai-presenter-agent-host');
  return {
    status: host.getByRole('status'),
    alert: host.getByRole('alert'),
    /** @param {string} name */
    button: (name) => host.getByRole('button', { name, exact: true }),
  };
}

test('a tool batch drives the iframe and the session survives a dropped socket', async ({
  page,
}) => {
  const token = await stubToken(page, { status: 200, body: { token: 'e2e-token' } });
  const live = await fakeGeminiLive(page);
  const { status, button } = card(page);
  const frame = page.frameLocator('#target-app-frame');

  await page.goto('/');
  await expect(status).toHaveText('Not connected');

  await button('Connect').click();
  await expect(status).toHaveText('Live');
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
  await expect.poll(() => live.sockets.length).toBe(2);
  expect(token.count).toBe(2); // exactly one fresh token for the one reconnect

  live.holdSetup(false);
  live.sendToLatest({ setupComplete: {} });
  await expect(status).toHaveText('Live');
  expect(token.nonces).toEqual([nonce, nonce]); // reusable within its TTL, by design (H1)
  expect(live.sockets).toHaveLength(2);

  await button('Disconnect').click();
  await expect(status).toHaveText('Not connected');
  await expect(button('Connect')).toBeFocused();
  // No retry was scheduled behind the hang-up.
  await page.waitForTimeout(1500);
  expect(token.count).toBe(2);
  expect(live.sockets).toHaveLength(2);
});

test.describe('when the server has no API key', () => {
  // The stubbed 500 is logged by the browser as a failed resource load.
  test.use({ allowedConsoleErrors: [/status of 500/] });

  test('a not_configured token error offers a reload and never retries', async ({ page }) => {
    const token = await stubToken(page, {
      status: 500,
      body: {
        error: { code: 'not_configured', message: "The server isn't configured to connect" },
      },
    });
    const live = await fakeGeminiLive(page);
    const { status, alert, button } = card(page);

    await page.goto('/');
    await button('Connect').click();

    await expect(status).toHaveText('Connection lost');
    await expect(alert).toHaveText(
      "The server isn't configured to connect. Contact the site owner, then reload this page.",
    );
    await expect(button('Reload page')).toBeVisible();
    // The backoff's first retry is immediate; give it room to (wrongly) happen.
    await page.waitForTimeout(1500);
    expect(token.count).toBe(1);
    expect(live.sockets).toHaveLength(0);
  });
});
