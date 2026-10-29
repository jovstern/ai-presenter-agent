import { test, expect } from './fixtures.js';

// The spec's §5.6 bridge validation test (docs/demostack-ai-presenter-agent.md):
// sandbox/bridge.js in a real browser, against the real target app, over a
// real MessageChannel. The fixture page has the bridge and the iframe but no
// agent-client, so this test plays the agent: it performs the handshake and
// the port transfer itself (ADR 0001) and talks the protocol on its port.

const FIXTURE_PATH = '/e2e/bridge-fixture.html';

// The same frame and script tags as sandbox/index.html, minus agent-client.
const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Bridge fixture</title>
    <link rel="icon" href="data:," />
  </head>
  <body>
    <iframe id="target-app-frame" title="Target app" src="/target-app/index.html"></iframe>
    <script defer src="/sandbox/bridge.js"></script>
  </body>
</html>`;

// How long a message that should be ignored gets to show up anyway, after a
// round trip on the real port has already proved the bridge is responsive.
const IGNORED_GRACE_MS = 300;

test.beforeEach(async ({ page, baseURL }) => {
  // Served with the real server's headers (the sandbox page's CSP included),
  // so the bridge runs under the policy it ships with.
  await page.route(FIXTURE_PATH, async (route) => {
    const response = await route.fetch({ url: `${baseURL}/` });
    await route.fulfill({ response, body: FIXTURE_HTML });
  });
  await page.goto(FIXTURE_PATH); // waits for the iframe's load too

  // The agent's half of the handshake, as bridgeChannel.js does it: keep
  // port1, transfer port2 to the bridge through window.postMessage.
  await page.evaluate(() => {
    const { port1, port2 } = new MessageChannel();
    /** @type {unknown[]} */
    const received = [];
    port1.onmessage = (event) => received.push(event.data);
    window.__agent = { port: port1, received };
    window.postMessage({ type: 'ds-bridge-connect' }, window.location.origin, [port2]);
  });
});

/**
 * Sends one action on the agent's port and resolves with the bridge's reply.
 * @param {import('@playwright/test').Page} page
 * @param {string} action
 * @param {unknown[]} args
 */
function act(page, action, args) {
  return page.evaluate(
    ({ action, args }) =>
      new Promise((resolve) => {
        const { port } = window.__agent;
        const id = crypto.randomUUID();
        /** @param {MessageEvent} event */
        function onReply(event) {
          if (event.data?.type !== 'action-result' || event.data.id !== id) return;
          port.removeEventListener('message', onReply);
          resolve({ success: event.data.success, error: event.data.error });
        }
        port.addEventListener('message', onReply);
        port.postMessage({ type: 'action', id, action, args });
      }),
    { action, args },
  );
}

/**
 * Everything the bridge has posted on the agent's port so far.
 * @param {import('@playwright/test').Page} page
 */
function received(page) {
  return page.evaluate(() => window.__agent.received);
}

/** @param {import('@playwright/test').Page} page */
function frame(page) {
  return page.frameLocator('#target-app-frame');
}

test('click, fill, scroll and navigate change the iframe', async ({ page }) => {
  expect(await act(page, 'click', ['counter-increment'])).toEqual({ success: true });
  await expect(frame(page).getByTestId('counter-value')).toHaveText('1');

  expect(await act(page, 'fill', ['search-input', 'pricing'])).toEqual({ success: true });
  await expect(frame(page).getByTestId('search-input')).toHaveValue('pricing');

  expect(await act(page, 'scroll', ['scroll-target'])).toEqual({ success: true });
  await expect
    .poll(() => page.evaluate(() => document.querySelector('iframe')?.contentWindow?.scrollY))
    .toBeGreaterThan(0);

  // navigate replies only once the new document has loaded (bridge.js).
  expect(await act(page, 'navigate', ['settings'])).toEqual({ success: true });
  await expect(frame(page).getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test('an action outside the allowlist is rejected', async ({ page }) => {
  expect(await act(page, 'eval', ['document.body.remove()'])).toEqual({
    success: false,
    error: 'Action "eval" is not allowed',
  });
  // An inherited Object property is not an action either.
  expect(await act(page, 'toString', [])).toMatchObject({ success: false });
});

test('a navigate to an unknown route is rejected', async ({ page }) => {
  expect(await act(page, 'navigate', ['admin'])).toEqual({
    success: false,
    error: 'Unknown route "admin"',
  });
  await expect(frame(page).getByRole('heading', { name: 'Home' })).toBeVisible();
});

test('fill on an element that is not a text input is rejected', async ({ page }) => {
  expect(await act(page, 'fill', ['counter-value', '99'])).toEqual({
    success: false,
    error: 'data-testid="counter-value" is not a text input',
  });
  await expect(frame(page).getByTestId('counter-value')).toHaveText('0');
});

test('a second ds-bridge-connect is ignored', async ({ page }) => {
  // A late script tries to take the bridge with its own port and act on it.
  await page.evaluate(() => {
    const { port1, port2 } = new MessageChannel();
    /** @type {unknown[]} */
    const hijackerReceived = [];
    port1.onmessage = (event) => hijackerReceived.push(event.data);
    window.__hijacker = hijackerReceived;
    window.postMessage({ type: 'ds-bridge-connect' }, window.location.origin, [port2]);
    port1.postMessage({
      type: 'action',
      id: 'hijack',
      action: 'click',
      args: ['counter-increment'],
    });
    port1.postMessage({ type: 'request-snapshot' });
  });

  // The first channel still works...
  expect(await act(page, 'scroll', ['home-heading'])).toEqual({ success: true });
  await page.waitForTimeout(IGNORED_GRACE_MS);
  // ...and the second one got nothing and did nothing.
  expect(await page.evaluate(() => window.__hijacker)).toEqual([]);
  await expect(frame(page).getByTestId('counter-value')).toHaveText('0');
});

test('forged messages on window are ignored', async ({ page }) => {
  await page.evaluate(() => {
    // An action posted to window instead of the port: the bridge stopped
    // listening on window after the handshake.
    window.postMessage(
      { type: 'action', id: 'forged-action', action: 'click', args: ['counter-increment'] },
      window.location.origin,
    );
    // A forged reply: it never reaches the agent's port.
    window.postMessage(
      { type: 'action-result', id: 'forged-result', success: true },
      window.location.origin,
    );
  });

  expect(await act(page, 'scroll', ['home-heading'])).toEqual({ success: true });
  await page.waitForTimeout(IGNORED_GRACE_MS);
  await expect(frame(page).getByTestId('counter-value')).toHaveText('0');
  const ids = (await received(page)).map((message) => message.id).filter(Boolean);
  expect(ids).not.toContain('forged-action');
  expect(ids).not.toContain('forged-result');
});

test('a snapshot follows a mutation, with hidden correct for save-confirmation', async ({
  page,
}) => {
  expect(await act(page, 'navigate', ['settings'])).toEqual({ success: true });

  const confirmationIn = (messages) =>
    messages
      .filter((message) => message.type === 'snapshot')
      .map((snapshot) => snapshot.full.find((node) => node.selector === 'save-confirmation'))
      .filter(Boolean);

  // The settings load: `navigated`, then a snapshot where the confirmation is
  // in the DOM but display:none.
  await expect.poll(async () => confirmationIn(await received(page))).toHaveLength(1);
  const onLoad = await received(page);
  const navigatedAt = onLoad.findIndex((message) => message.type === 'navigated');
  const snapshotAt = onLoad.findIndex((message) => message.type === 'snapshot');
  expect(navigatedAt).toBeGreaterThanOrEqual(0);
  expect(navigatedAt).toBeLessThan(snapshotAt);
  expect(confirmationIn(onLoad)[0]).toMatchObject({ tag: 'p', label: 'Saved.', hidden: true });

  // Saving shows it: the debounced MutationObserver sends a snapshot whose
  // diff carries exactly that change.
  expect(await act(page, 'click', ['save-button'])).toEqual({ success: true });
  await expect.poll(async () => confirmationIn(await received(page))).toHaveLength(2);
  const afterSave = (await received(page)).filter((message) => message.type === 'snapshot').at(-1);
  expect(afterSave.changed).toEqual([
    { selector: 'save-confirmation', tag: 'p', label: 'Saved.', disabled: false, hidden: false },
  ]);
  expect(afterSave.removed).toEqual([]);
});
