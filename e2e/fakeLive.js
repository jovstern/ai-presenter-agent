// The fake-Live harness, shared by loop.spec.js and a11y.spec.js: the token
// endpoint stubbed with page.route and the Gemini Live socket answered with
// page.routeWebSocket, so the real @google/genai socket code runs with no key.

const LIVE_SOCKET = /^wss:\/\/generativelanguage\.googleapis\.com\//;
const TOKEN_PATH = '/api/live-token?*';

/**
 * A fake Gemini Live server. Each socket the page opens is answered here;
 * `setupComplete` goes out when the SDK sends its `setup`, unless the test
 * holds it back to watch the page wait.
 * @param {import('@playwright/test').Page} page
 */
export async function fakeGeminiLive(page) {
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
export async function stubToken(page, reply) {
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
export function pageNonce(page) {
  return page.locator('script[data-ds-nonce]').getAttribute('data-ds-nonce');
}

/**
 * The card's own landmark, and the failure toasts beside it: both in the
 * shadow root, but the toast (and Radix's announcer) outside the card, and
 * the toast's action may share the card button's label.
 * @param {import('@playwright/test').Page} page
 */
export function card(page) {
  const host = page.locator('#ai-presenter-agent-host');
  const panel = host.getByRole('complementary', { name: 'AI presenter' });
  return {
    panel,
    status: panel.getByRole('status'),
    alert: panel.getByRole('alert'),
    /** @param {string} name */
    button: (name) => panel.getByRole('button', { name, exact: true }),
    toasts: host.getByRole('region', { name: 'Notifications (F8)' }).getByRole('listitem'),
  };
}
