import { TOOL_DECLARATIONS } from '../agent-client/src/actionTools.js';
import {
  createDomSnapshotContext,
  formatSnapshotMessage,
} from '../agent-client/src/domSnapshotContext.js';
import ROUTES from '../target-app/routes.json' with { type: 'json' };
import { test, expect } from './fixtures.js';

// The spec's §5.6 bridge validation test (docs/demostack-ai-presenter-agent.md):
// sandbox/bridge.js in a real browser, against the real target app, over a
// real MessageChannel. The fixture page has the bridge and the iframe but no
// agent-client, so this test plays the agent: it performs the handshake and
// the port transfer itself (ADR 0001) and talks the protocol on its port.

const FIXTURE_PATH = '/e2e/bridge-fixture.html';

// The same frame, routes block and script tags as sandbox/index.html, minus
// agent-client. The routes block is the server's own, cut from its `/`.
/** @param {string} routesBlock */
const fixtureHtml = (routesBlock) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Bridge fixture</title>
    <link rel="icon" href="data:," />
  </head>
  <body>
    <iframe id="target-app-frame" title="Target app" src="/target-app/index.html"></iframe>
    ${routesBlock}
    <script defer src="/sandbox/bridge.js"></script>
  </body>
</html>`;

const ROUTES_BLOCK = /<script type="application\/json" id="ds-routes">[\s\S]*?<\/script>/;

// How long a message that should be ignored gets to show up anyway, after a
// round trip on the real port has already proved the bridge is responsive.
const IGNORED_GRACE_MS = 300;

test.beforeEach(async ({ page, baseURL }) => {
  // Served with the real server's headers (the sandbox page's CSP included),
  // so the bridge runs under the policy it ships with.
  await page.route(FIXTURE_PATH, async (route) => {
    const response = await route.fetch({ url: `${baseURL}/` });
    const routesBlock = (await response.text()).match(ROUTES_BLOCK)?.[0];
    if (!routesBlock) throw new Error('the sandbox page has no #ds-routes block');
    await route.fulfill({ response, body: fixtureHtml(routesBlock) });
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
  // The fill's input event schedules a snapshot whose delta shows the field,
  // named by its <label>, with what was typed (bridge.js).
  await expect
    .poll(async () =>
      (await received(page))
        .filter((message) => message.type === 'snapshot')
        .flatMap((snapshot) => snapshot.changed)
        .find((node) => node.selector === 'search-input' && node.value === 'pricing'),
    )
    .toEqual({
      selector: 'search-input',
      tag: 'input',
      label: 'Search',
      disabled: false,
      hidden: false,
      value: 'pricing',
    });

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

test('an action’s settled snapshot comes before its result, with hidden correct for save-confirmation', async ({
  page,
}) => {
  expect(await act(page, 'navigate', ['settings'])).toEqual({ success: true });

  const confirmationIn = (messages) =>
    messages
      .filter((message) => message.type === 'snapshot')
      .map((snapshot) => snapshot.full.find((node) => node.selector === 'save-confirmation'))
      .filter(Boolean);
  const types = (messages) => messages.map((message) => message.type);

  // The settings load: `navigated`, then the load's snapshot, then the
  // settled page's (#25), then the result; in both snapshots the
  // confirmation is in the DOM but display:none.
  const onLoad = await received(page);
  expect(types(onLoad)).toEqual(['navigated', 'snapshot', 'snapshot', 'action-result']);
  expect(confirmationIn(onLoad)).toEqual([
    expect.objectContaining({ tag: 'p', label: 'Saved.', hidden: true }),
    expect.objectContaining({ tag: 'p', label: 'Saved.', hidden: true }),
  ]);

  // Saving shows it: the click's own snapshot, sent before its result,
  // carries exactly that change.
  expect(await act(page, 'click', ['save-button'])).toEqual({ success: true });
  const afterSave = (await received(page)).slice(onLoad.length);
  expect(types(afterSave)).toEqual(['snapshot', 'action-result']);
  expect(afterSave[0].changed).toEqual([
    { selector: 'save-confirmation', tag: 'p', label: 'Saved.', disabled: false, hidden: false },
  ]);
  expect(afterSave[0].removed).toEqual([]);
  // The debounced snapshot the click also scheduled was replaced, not sent.
  await page.waitForTimeout(IGNORED_GRACE_MS);
  expect(await received(page)).toHaveLength(onLoad.length + 2);
});

// docs/code-review-notes.md M1: target-app/routes.json is the one route list.
// The model's `navigate` enum (actionTools.js) and the routes the bridge
// accepts (the server's #ds-routes block) both come from it.
test('the bridge accepts exactly the navigate enum’s routes', async ({ page }) => {
  const navigate = TOOL_DECLARATIONS.find((tool) => tool.name === 'navigate');
  const routeEnum = navigate?.parametersJsonSchema?.properties?.route?.enum;
  expect(routeEnum).toEqual(Object.keys(ROUTES));

  for (const route of [...routeEnum].reverse()) {
    expect(await act(page, 'navigate', [route]), route).toEqual({ success: true });
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector('iframe')?.contentWindow?.location.pathname),
      )
      .toBe(ROUTES[route]);
  }
  expect(await act(page, 'navigate', ['admin'])).toEqual({
    success: false,
    error: 'Unknown route "admin"',
  });
});

test.describe('fill on Settings', () => {
  test.beforeEach(async ({ page }) => {
    expect(await act(page, 'navigate', ['settings'])).toEqual({ success: true });
    // Every input and change event that reaches the Settings document, in order.
    await page.evaluate(() => {
      const doc = document.querySelector('iframe')?.contentDocument;
      /** @type {string[]} */
      const events = [];
      for (const type of ['input', 'change']) {
        doc?.addEventListener(type, (event) => {
          const target = /** @type {HTMLElement} */ (event.target);
          events.push(`${event.type} ${target.dataset.testid} bubbles=${event.bubbles}`);
        });
      }
      window.__fillEvents = events;
    });
  });

  /** @param {import('@playwright/test').Page} page */
  const fillEvents = (page) => page.evaluate(() => window.__fillEvents);

  /**
   * The latest snapshot node for `selector`, once one matches `expected`.
   * @param {import('@playwright/test').Page} page
   * @param {string} selector
   * @param {Record<string, unknown>} expected
   */
  function expectSnapshotNode(page, selector, expected) {
    return expect
      .poll(async () =>
        (await received(page))
          .filter((message) => message.type === 'snapshot')
          .flatMap((snapshot) => snapshot.full)
          .filter((node) => node.selector === selector)
          .at(-1),
      )
      .toMatchObject(expected);
  }

  test('types into the Notes textarea, firing input and change', async ({ page }) => {
    expect(await act(page, 'fill', ['notes-input', 'Call back on Monday'])).toEqual({
      success: true,
    });

    await expect(frame(page).getByLabel('Notes')).toHaveValue('Call back on Monday');
    expect(await fillEvents(page)).toEqual([
      'input notes-input bubbles=true',
      'change notes-input bubbles=true',
    ]);
    await expectSnapshotNode(page, 'notes-input', {
      tag: 'textarea',
      label: 'Notes',
      value: 'Call back on Monday',
    });
  });

  test('chooses a Plan option by its visible text, firing input and change', async ({ page }) => {
    await expectSnapshotNode(page, 'plan-select', {
      tag: 'select',
      label: 'Plan',
      value: 'Free plan',
      options: ['Free plan', 'Pro plan', 'Team plan'],
    });

    expect(await act(page, 'fill', ['plan-select', 'pro plan'])).toEqual({ success: true });

    await expect(frame(page).getByLabel('Plan')).toHaveValue('pro');
    expect(await fillEvents(page)).toEqual([
      'input plan-select bubbles=true',
      'change plan-select bubbles=true',
    ]);
    await expectSnapshotNode(page, 'plan-select', { value: 'Pro plan' });
  });

  test('chooses a Plan option by its value', async ({ page }) => {
    expect(await act(page, 'fill', ['plan-select', 'team'])).toEqual({ success: true });

    await expect(frame(page).getByLabel('Plan')).toHaveValue('team');
    await expectSnapshotNode(page, 'plan-select', { value: 'Team plan' });
  });

  test('a Plan that matches no option fails, naming the options, and changes nothing', async ({
    page,
  }) => {
    expect(await act(page, 'fill', ['plan-select', 'Pro plan'])).toEqual({ success: true });
    const before = (await fillEvents(page)).length;

    expect(await act(page, 'fill', ['plan-select', 'Enterprise'])).toEqual({
      success: false,
      error:
        'data-testid="plan-select" has no option "Enterprise"; options: Free plan, Pro plan, Team plan',
    });

    await expect(frame(page).getByLabel('Plan')).toHaveValue('pro');
    expect(await fillEvents(page)).toHaveLength(before);
  });
});

// Issue #22: the Orders page has 139 data-testid elements, past bridge.js's
// MAX_SNAPSHOT_NODES (30). A snapshot keeps the 30 nearest the frame's
// viewport and says how many it left out; agent-client turns each one into a
// keyframe or a delta as it would for the model (domSnapshotContext.js).
test.describe('the Orders page, over the snapshot cap', () => {
  const KEYFRAME_BUDGET_BYTES = 4096; // the spec's 4 kB
  const ORDERS_ELEMENTS = 139;
  const MAX_SNAPSHOT_NODES = 30;

  test.beforeEach(async ({ page }) => {
    // The sandbox page's frame fills the window; the fixture's is the
    // default 300 x 150, which would leave hardly any row in view.
    await page.evaluate(() => {
      const iframe = document.querySelector('iframe');
      if (iframe) iframe.style.cssText = 'display: block; width: 100%; height: 100vh; border: 0';
    });
  });

  /**
   * Runs one action and returns the snapshot sent just before its result.
   * @param {import('@playwright/test').Page} page
   * @param {string} action
   * @param {unknown[]} args
   */
  async function snapshotOf(page, action, args) {
    const before = (await received(page)).length;
    expect(await act(page, action, args)).toEqual({ success: true });
    const messages = (await received(page)).slice(before);
    return messages.filter((message) => message.type === 'snapshot').at(-1);
  }

  const selectors = (/** @type {{ full: { selector: string }[] }} */ snapshot) =>
    snapshot.full.map((node) => node.selector);
  const bytes = (/** @type {string} */ text) => new TextEncoder().encode(text).length;

  test('keeps what is in view, within the keyframe budget, and sends small changes as deltas', async ({
    page,
  }) => {
    const context = createDomSnapshotContext();
    context.markNavigated();
    const loaded = await snapshotOf(page, 'navigate', ['orders']);

    // On load: the top of the page, the first orders included; the far rows
    // and the form below the table are left out, and counted.
    expect(loaded.full).toHaveLength(MAX_SNAPSHOT_NODES);
    expect(loaded.omitted).toBe(ORDERS_ELEMENTS - MAX_SNAPSHOT_NODES);
    expect(selectors(loaded)).toEqual(expect.arrayContaining(['nav-orders', 'order-1003-select']));
    expect(selectors(loaded)).not.toContain('order-1030-select');
    expect(selectors(loaded)).not.toContain('order-customer');
    const keyframe = formatSnapshotMessage(context.decide(loaded));
    expect(keyframe).toContain(
      `The page has ${ORDERS_ELEMENTS - MAX_SNAPSHOT_NODES} more elements`,
    );
    expect(bytes(keyframe)).toBeLessThanOrEqual(KEYFRAME_BUDGET_BYTES);

    // Ticking a row: that checkbox, the count and Ship selected, as a delta.
    const ticked = await snapshotOf(page, 'click', ['order-1003-select']);
    expect(context.decide(ticked)).toEqual({
      type: 'delta',
      changed: [
        expect.objectContaining({ selector: 'orders-selected-count', label: '1 selected' }),
        expect.objectContaining({ selector: 'ship-selected', disabled: false }),
        expect.objectContaining({ selector: 'order-1003-select', checked: true }),
      ],
      removed: [],
    });
    await expect(frame(page).getByRole('checkbox', { name: 'Select order 1003' })).toBeChecked();

    // Scrolling to the form brings it in, as a keyframe of the new view.
    const scrolled = await snapshotOf(page, 'scroll', ['order-customer']);
    expect(selectors(scrolled)).toEqual(expect.arrayContaining(['order-customer', 'order-date']));
    expect(selectors(scrolled)).not.toContain('order-1003-select');
    const scrolledDecision = context.decide(scrolled);
    expect(scrolledDecision.type).toBe('keyframe');
    expect(bytes(formatSnapshotMessage(scrolledDecision))).toBeLessThanOrEqual(
      KEYFRAME_BUDGET_BYTES,
    );

    // Filling a field of the form, now in view: one node, as a delta.
    const filled = await snapshotOf(page, 'fill', ['order-customer', 'Pied Piper']);
    expect(context.decide(filled)).toEqual({
      type: 'delta',
      changed: [{ ...selectorNode('order-customer', 'Customer'), value: 'Pied Piper' }],
      removed: [],
    });
  });

  test('a viewer’s scroll sends a snapshot of what came into view', async ({ page }) => {
    expect(await act(page, 'navigate', ['orders'])).toEqual({ success: true });
    const before = (await received(page)).length;

    await frame(page)
      .getByRole('button', { name: 'Ship order 1040' })
      .evaluate((button) => button.scrollIntoView({ block: 'center' }));

    await expect
      .poll(async () =>
        (await received(page))
          .slice(before)
          .filter((message) => message.type === 'snapshot')
          .flatMap((snapshot) => snapshot.full.map((node) => node.selector)),
      )
      .toContain('order-1040-select');
  });
});

/**
 * A visible, enabled text input's snapshot node, before its value.
 * @param {string} selector
 * @param {string} label
 */
function selectorNode(selector, label) {
  return { selector, tag: 'input', label, disabled: false, hidden: false };
}
