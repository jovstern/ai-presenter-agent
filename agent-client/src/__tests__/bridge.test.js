import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defined } from './defined.js';

/** @import { BridgeMessage, SnapshotMessage } from '../bridgeProtocol.js' */

/**
 * The stubbed frame a test drives: the document and window it holds, every
 * `src` the bridge set, and the hooks that load a page into it.
 * @typedef {object} FrameStub
 * @property {Document} doc
 * @property {string} path
 * @property {string[]} srcSets
 * @property {((value: string) => void) | null} onSrcSet
 * @property {EventTarget} win
 * @property {(path: string) => void} load A new document at `path` finishes loading.
 * @property {() => Promise<string>} nextSrcSet Resolves with the next `src` the bridge sets.
 */

// sandbox/ has no package or test runner of its own, so its bridge script is
// run here as the page would run it: a classic script evaluated once against
// this jsdom window. The iframe is stubbed (jsdom doesn't load frame URLs): a
// test decides which document the frame holds and when its `load` fires.
const BRIDGE_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, '../../../sandbox/bridge.js'),
  'utf8',
);
// The one route list: the server templates this file into the sandbox page's
// #ds-routes data block, which is what the bridge reads.
const ROUTES_JSON = readFileSync(
  path.resolve(import.meta.dirname, '../../../target-app/routes.json'),
  'utf8',
);
/** @type {Record<string, string>} */
const ROUTES = JSON.parse(ROUTES_JSON);

/** @type {FrameStub} */
let frame;
/** @type {MessagePort} */
let agentPort;
/** @type {MessagePort[]} */
let openPorts = [];

/** @returns {FrameStub} */
function stubFrame(
  routesBlock = `<script type="application/json" id="ds-routes">${ROUTES_JSON}</script>`,
) {
  document.body.innerHTML = `<iframe id="target-app-frame"></iframe>${routesBlock}`;
  const iframe = defined(document.getElementById('target-app-frame'), 'the frame');
  // One window per document, as in a browser, where a document's listeners
  // (the bridge's beforeunload / pagehide) go with it.
  const newWindow = () =>
    Object.assign(new EventTarget(), {
      location: {
        get pathname() {
          return state.path;
        },
      },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      // The frame's realm: its documents are this jsdom window's.
      HTMLInputElement: window.HTMLInputElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement,
      HTMLSelectElement: window.HTMLSelectElement,
    });
  /** @type {FrameStub} */
  const state = {
    doc: document.implementation.createHTMLDocument(''),
    path: '/target-app/index.html',
    srcSets: [],
    onSrcSet: null,
    win: newWindow(),
    load: (path) => {
      state.path = path;
      state.doc = document.implementation.createHTMLDocument('');
      state.win = newWindow();
      iframe.dispatchEvent(new Event('load'));
    },
    nextSrcSet: () => new Promise((resolve) => (state.onSrcSet = resolve)),
  };
  Object.defineProperty(iframe, 'contentDocument', { get: () => state.doc });
  Object.defineProperty(iframe, 'contentWindow', { get: () => state.win });
  Object.defineProperty(iframe, 'src', {
    get: () => state.srcSets.at(-1) ?? '',
    set: (/** @type {string} */ value) => {
      state.srcSets.push(value);
      state.onSrcSet?.(value);
    },
  });
  return state;
}

// jsdom drops postMessage transfer lists, so the handshake is dispatched as the
// event the browser would deliver: same origin, from this window, one port.
function handshake() {
  const { port1, port2 } = new MessageChannel();
  openPorts.push(port1, port2);
  const event = new Event('message');
  Object.assign(event, {
    origin: window.location.origin,
    source: window,
    data: { type: 'ds-bridge-connect' },
    ports: [port2],
  });
  window.dispatchEvent(event);
  return port1;
}

/**
 * Resolves with the next bridge message of `type` on the port.
 * @template {BridgeMessage['type']} T
 * @param {MessagePort} port
 * @param {T} type
 * @returns {Promise<Extract<BridgeMessage, { type: T }>>}
 */
function nextMessage(port, type) {
  return new Promise((resolve) => {
    port.onmessage = (event) => {
      if (event.data?.type === type) resolve(event.data);
    };
  });
}

/**
 * The value of a form control the bridge can fill (or a button, which has a
 * value too), or a failure if `el` is anything else.
 * @param {EventTarget | null} el
 */
function valueOf(el) {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLButtonElement
  ) {
    return el.value;
  }
  throw new Error('expected a form control');
}

/** @param {string} testId */
function byTestId(testId) {
  const el = frame.doc.querySelector(`[data-testid="${testId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no element with data-testid="${testId}"`);
  return el;
}

/** Sends one fill and resolves with its reply. @param {string} id @param {string} selector @param {string} value */
function fill(id, selector, value) {
  const result = nextMessage(agentPort, 'action-result');
  agentPort.postMessage({ type: 'action', id, action: 'fill', args: [selector, value] });
  return result;
}

beforeEach(() => {
  frame = stubFrame();
  new Function(BRIDGE_SOURCE)();
  agentPort = handshake();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  openPorts.forEach((port) => port.close());
  openPorts = [];
});

describe('sandbox/bridge.js routes', () => {
  it.each(Object.entries(ROUTES))(
    'navigates "%s" to %s, from the #ds-routes block',
    async (route, routePath) => {
      const srcSet = frame.nextSrcSet();
      const result = nextMessage(agentPort, 'action-result');
      agentPort.postMessage({ type: 'action', id: 'r1', action: 'navigate', args: [route] });

      expect(await srcSet).toBe(routePath);
      frame.load(routePath);
      expect(await result).toEqual({ type: 'action-result', id: 'r1', success: true });
    },
  );

  it.each(['admin', 'toString', '__proto__'])('rejects the unknown route "%s"', async (route) => {
    const result = nextMessage(agentPort, 'action-result');
    agentPort.postMessage({ type: 'action', id: 'r2', action: 'navigate', args: [route] });

    expect(await result).toEqual({
      type: 'action-result',
      id: 'r2',
      success: false,
      error: `Unknown route "${route}"`,
    });
  });

  it.each([
    ['missing', ''],
    ['not JSON', '<script type="application/json" id="ds-routes">{home:</script>'],
    ['empty', '<script type="application/json" id="ds-routes">{}</script>'],
    ['an array', '<script type="application/json" id="ds-routes">["home"]</script>'],
    [
      'a non-path value',
      '<script type="application/json" id="ds-routes">{"home":"javascript:alert(1)"}</script>',
    ],
  ])('fails loudly at load when the #ds-routes block is %s', (_name, block) => {
    stubFrame(block);
    expect(() => new Function(BRIDGE_SOURCE)()).toThrow(/bridge\.js: .*ds-routes/);
  });
});

describe('sandbox/bridge.js navigate', () => {
  it('reports success once the requested page has loaded', async () => {
    const srcSet = frame.nextSrcSet();
    const result = nextMessage(agentPort, 'action-result');
    agentPort.postMessage({ type: 'action', id: 'a1', action: 'navigate', args: ['settings'] });

    expect(await srcSet).toBe('/target-app/settings.html');
    frame.load('/target-app/settings.html');

    expect(await result).toEqual({ type: 'action-result', id: 'a1', success: true });
  });

  it('is not resolved by a load of some other page', async () => {
    const srcSet = frame.nextSrcSet();
    /** @type {BridgeMessage[]} */
    const replies = [];
    agentPort.onmessage = (event) => replies.push(event.data);
    agentPort.postMessage({ type: 'action', id: 'a2', action: 'navigate', args: ['settings'] });
    await srcSet;

    frame.load('/target-app/index.html'); // e.g. the viewer clicked Home meanwhile
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replies.filter((m) => m.type === 'action-result')).toEqual([]);

    const result = nextMessage(agentPort, 'action-result');
    frame.load('/target-app/settings.html');
    expect(await result).toMatchObject({ id: 'a2', success: true });
  });

  it('reports failure, inside the agent channel’s 4 s action timeout, when the page never loads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const srcSet = frame.nextSrcSet();
    /** @type {BridgeMessage[]} */
    const replies = [];
    agentPort.onmessage = (event) => replies.push(event.data);
    agentPort.postMessage({ type: 'action', id: 'a3', action: 'navigate', args: ['settings'] });
    await srcSet;

    await vi.advanceTimersByTimeAsync(3_699);
    expect(replies).toEqual([]);

    const result = nextMessage(agentPort, 'action-result');
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({
      type: 'action-result',
      id: 'a3',
      success: false,
      error: 'The page did not finish loading.',
    });
  });
});

describe('sandbox/bridge.js fill', () => {
  it('types into an input and reports success', async () => {
    frame.doc.body.innerHTML = '<input data-testid="name-input" />';
    const result = nextMessage(agentPort, 'action-result');
    agentPort.postMessage({
      type: 'action',
      id: 'f1',
      action: 'fill',
      args: ['name-input', 'Ada'],
    });

    expect(await result).toEqual({ type: 'action-result', id: 'f1', success: true });
    expect(valueOf(frame.doc.querySelector('input'))).toBe('Ada');
  });

  // Found by the checkJs pass: an element without `value` got an expando and a
  // success reply while nothing on the page changed.
  it('reports failure for an element that is not a text input', async () => {
    frame.doc.body.innerHTML = '<div data-testid="card"></div>';
    const result = nextMessage(agentPort, 'action-result');
    agentPort.postMessage({ type: 'action', id: 'f2', action: 'fill', args: ['card', 'Ada'] });

    expect(await result).toEqual({
      type: 'action-result',
      id: 'f2',
      success: false,
      error: 'data-testid="card" is not a text input',
    });
  });

  it.each([
    ['a button', '<button data-testid="target">Save</button>'],
    ['a checkbox', '<input data-testid="target" type="checkbox" />'],
    ['a submit input', '<input data-testid="target" type="submit" value="Go" />'],
    ['a hidden input', '<input data-testid="target" type="hidden" />'],
  ])('reports failure for %s, which has a value but is no text input', async (_name, html) => {
    frame.doc.body.innerHTML = html;
    const result = nextMessage(agentPort, 'action-result');
    agentPort.postMessage({ type: 'action', id: 'f4', action: 'fill', args: ['target', 'Ada'] });

    expect(await result).toEqual({
      type: 'action-result',
      id: 'f4',
      success: false,
      error: 'data-testid="target" is not a text input',
    });
    expect(valueOf(byTestId('target')) === 'Ada').toBe(false);
  });

  it.each([
    ['a textarea', '<textarea data-testid="target"></textarea>', 'Ada'],
    ['an email input', '<input data-testid="target" type="email" />', 'ada@example.com'],
  ])('fills %s', async (_name, html, value) => {
    frame.doc.body.innerHTML = html;
    const result = nextMessage(agentPort, 'action-result');
    agentPort.postMessage({ type: 'action', id: 'f5', action: 'fill', args: ['target', value] });

    expect(await result).toMatchObject({ id: 'f5', success: true });
    expect(valueOf(byTestId('target'))).toBe(value);
  });

  const PLAN = `<select data-testid="plan">
      <option value="free">Free plan</option>
      <option value="pro">Pro plan</option>
      <option value="team">Team plan</option>
    </select>`;

  it.each([
    ['its visible text', 'Pro plan'],
    ['its text, ignoring case and surrounding space', '  pRO PLAN '],
    ['its value', 'pro'],
  ])('selects an option by %s', async (_name, value) => {
    frame.doc.body.innerHTML = PLAN;

    expect(await fill('f7', 'plan', value)).toEqual({
      type: 'action-result',
      id: 'f7',
      success: true,
    });
    expect(valueOf(frame.doc.querySelector('select'))).toBe('pro');
  });

  it('prefers an option whose text matches over one whose value does', async () => {
    frame.doc.body.innerHTML = `<select data-testid="plan">
      <option value="b">a</option>
      <option value="a">b</option>
    </select>`;

    expect(await fill('f8', 'plan', 'a')).toMatchObject({ success: true });
    expect(valueOf(frame.doc.querySelector('select'))).toBe('b');
  });

  it('fails, naming the options, and leaves the selection alone when no option matches', async () => {
    frame.doc.body.innerHTML = PLAN;
    const select = defined(frame.doc.querySelector('select'));
    select.value = 'team';
    const events = vi.fn();
    select.addEventListener('input', events);
    select.addEventListener('change', events);

    expect(await fill('f9', 'plan', 'Enterprise')).toEqual({
      type: 'action-result',
      id: 'f9',
      success: false,
      error:
        'data-testid="plan" has no option "Enterprise"; options: Free plan, Pro plan, Team plan',
    });
    expect(select.value).toBe('team');
    expect(events).not.toHaveBeenCalled();
  });

  it.each([
    ['an input', '<input data-testid="target" />', 'Ada'],
    ['a textarea', '<textarea data-testid="target"></textarea>', 'Ada'],
    ['a select', PLAN.replace('data-testid="plan"', 'data-testid="target"'), 'Team plan'],
  ])('fires bubbling input and change events on %s', async (_name, html, value) => {
    frame.doc.body.innerHTML = html;
    /** @type {[string, boolean, string][]} */
    const seen = [];
    const record = (/** @type {Event} */ event) =>
      seen.push([event.type, event.bubbles, valueOf(event.target)]);
    frame.doc.body.addEventListener('input', record);
    frame.doc.body.addEventListener('change', record);

    expect(await fill('f10', 'target', value)).toMatchObject({ success: true });
    const expected = valueOf(byTestId('target'));
    expect(seen).toEqual([
      ['input', true, expected],
      ['change', true, expected],
    ]);
  });

  // A framework's controlled input (React) tracks the value through the
  // element's own `value` property; only the prototype's native setter gets
  // past that, so the bridge must not assign through the instance.
  it.each([
    ['an input', '<input data-testid="target" />', window.HTMLInputElement, 'Ada', 'Ada'],
    [
      'a textarea',
      '<textarea data-testid="target"></textarea>',
      window.HTMLTextAreaElement,
      'Ada',
      'Ada',
    ],
  ])(
    'sets %s through its prototype’s native value setter',
    async (_name, html, element, value, set) => {
      frame.doc.body.innerHTML = html;
      const target = byTestId('target');
      const instanceSetter = vi.fn();
      Object.defineProperty(target, 'value', {
        configurable: true,
        get: () => '',
        set: instanceSetter,
      });
      const { prototype } = element;
      const native = defined(
        Object.getOwnPropertyDescriptor(prototype, 'value'),
        'the native value descriptor',
      );
      const nativeSet = defined(native.set, 'the native value setter');
      const nativeSetter = vi.fn(
        /** @this {HTMLElement} @param {string} v */
        function (v) {
          nativeSet.call(this, v);
        },
      );
      Object.defineProperty(prototype, 'value', { ...native, set: nativeSetter });
      try {
        expect(await fill('f11', 'target', value)).toMatchObject({ success: true });
        expect(instanceSetter).not.toHaveBeenCalled();
        expect(nativeSetter).toHaveBeenCalledWith(set);
      } finally {
        Object.defineProperty(prototype, 'value', native);
      }
    },
  );
});

describe('sandbox/bridge.js fill refuses what a user could not do', () => {
  it.each([
    ['a disabled input', '<input data-testid="target" disabled value="old" />', 'is disabled'],
    [
      'an input in a disabled fieldset',
      '<fieldset disabled><input data-testid="target" value="old" /></fieldset>',
      'is disabled',
    ],
    ['a read-only input', '<input data-testid="target" readonly value="old" />', 'is read-only'],
    [
      'a read-only textarea',
      '<textarea data-testid="target" readonly>old</textarea>',
      'is read-only',
    ],
  ])('refuses %s and leaves it alone', async (_name, html, why) => {
    frame.doc.body.innerHTML = html;
    const events = vi.fn();
    frame.doc.body.addEventListener('input', events);

    expect(await fill('d1', 'target', 'new')).toEqual({
      type: 'action-result',
      id: 'd1',
      success: false,
      error: `data-testid="target" ${why}`,
    });
    expect(valueOf(byTestId('target'))).toBe('old');
    expect(events).not.toHaveBeenCalled();
  });

  it('refuses a disabled select', async () => {
    frame.doc.body.innerHTML = `<select data-testid="plan" disabled>
      <option value="free">Free plan</option><option value="pro">Pro plan</option></select>`;
    expect(await fill('d2', 'plan', 'Pro plan')).toMatchObject({
      success: false,
      error: 'data-testid="plan" is disabled',
    });
    expect(valueOf(frame.doc.querySelector('select'))).toBe('free');
  });

  it.each([
    ['a disabled option', '<option value="team" disabled>Team plan</option>'],
    [
      'an option in a disabled optgroup',
      '<optgroup label="Paid" disabled><option value="team">Team plan</option></optgroup>',
    ],
  ])('refuses %s', async (_name, option) => {
    frame.doc.body.innerHTML = `<select data-testid="plan">
      <option value="free">Free plan</option>${option}</select>`;
    expect(await fill('d3', 'plan', 'Team plan')).toMatchObject({
      success: false,
      error: 'data-testid="plan" has option "Team plan", but it is disabled',
    });
    expect(valueOf(frame.doc.querySelector('select'))).toBe('free');
  });

  it('selects the matched option itself when two options share a value', async () => {
    frame.doc.body.innerHTML = `<select data-testid="size">
      <option value="m">Medium</option>
      <option value="m">Medium (fitted)</option>
    </select>`;
    expect(await fill('d4', 'size', 'Medium (fitted)')).toMatchObject({ success: true });
    expect(defined(frame.doc.querySelector('select')).selectedIndex).toBe(1);
  });

  // maxlength: failing, not truncating, so the model never believes it typed
  // text the field cut short.
  it('refuses a value longer than the field’s maxlength, naming the limit', async () => {
    frame.doc.body.innerHTML = '<input data-testid="target" maxlength="5" />';
    expect(await fill('d5', 'target', 'Ada Lovelace')).toEqual({
      type: 'action-result',
      id: 'd5',
      success: false,
      error: 'data-testid="target" takes at most 5 characters; the value has 12',
    });
    expect(valueOf(frame.doc.querySelector('input'))).toBe('');
  });

  it('fills a value that fits the maxlength', async () => {
    frame.doc.body.innerHTML = '<textarea data-testid="target" maxlength="5"></textarea>';
    expect(await fill('d6', 'target', 'Ada')).toMatchObject({ success: true });
    expect(valueOf(frame.doc.querySelector('textarea'))).toBe('Ada');
  });
});

describe('sandbox/bridge.js selectors', () => {
  // The test id goes into a CSS attribute selector: a quote in it used to
  // break the selector (a SyntaxError, reported as a failure).
  it('finds an element whose data-testid has a quote and a backslash in it', async () => {
    frame.doc.body.innerHTML = '<button data-testid=\'say "hi" \\ bye\'>Hi</button>';
    const clicked = vi.fn();
    defined(frame.doc.querySelector('button')).addEventListener('click', clicked);
    const result = nextMessage(agentPort, 'action-result');
    agentPort.postMessage({
      type: 'action',
      id: 's1',
      action: 'click',
      args: ['say "hi" \\ bye'],
    });

    expect(await result).toEqual({ type: 'action-result', id: 's1', success: true });
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});

describe('sandbox/bridge.js channel', () => {
  it('keeps replying on the port when MessagePort.prototype.postMessage is patched after load', async () => {
    const original = MessagePort.prototype.postMessage;
    const tap = vi.spyOn(MessagePort.prototype, 'postMessage');
    try {
      const result = nextMessage(agentPort, 'action-result');
      // Sent with the captured original, so the tap only sees the bridge's reply if the bridge used the patched one.
      original.call(agentPort, { type: 'action', id: 'a4', action: 'click', args: ['missing'] });
      expect(await result).toMatchObject({ id: 'a4', success: false });
      expect(tap).not.toHaveBeenCalled();
    } finally {
      tap.mockRestore();
    }
  });
});

describe('sandbox/bridge.js snapshots', () => {
  const SETTINGS = `
    <label><input data-testid="toggle" type="checkbox" /> Enable notifications</label>
    <input data-testid="name" value="Ada" />
    <button data-testid="save">Save</button>`;

  // Resolves with the debounced snapshot of the new content, skipping the
  // load's own snapshot of the still-empty document.
  /** @param {string} html */
  function loadPage(html) {
    /** @type {Promise<SnapshotMessage>} */
    const snapshot = new Promise((resolve) => {
      agentPort.onmessage = ({ data }) => {
        if (data?.type === 'snapshot' && data.full.length > 0) resolve(data);
      };
    });
    frame.load('/target-app/settings.html');
    frame.doc.body.innerHTML = html;
    return snapshot;
  }

  it("names a checkbox by its label, never its value, and reports whether it's checked", async () => {
    const { full } = await loadPage(SETTINGS);

    expect(full).toEqual([
      {
        selector: 'toggle',
        tag: 'input',
        label: 'Enable notifications',
        disabled: false,
        hidden: false,
        checked: false,
      },
      // A text field's content is its value, not its name.
      { selector: 'name', tag: 'input', label: '', disabled: false, hidden: false, value: 'Ada' },
      { selector: 'save', tag: 'button', label: 'Save', disabled: false, hidden: false },
    ]);
  });

  // Toggling a checkbox changes a property, not an attribute: without the
  // change listener the MutationObserver never sends this snapshot.
  it('sends a snapshot when a checkbox is toggled', async () => {
    await loadPage(SETTINGS);
    const toggle = byTestId('toggle');
    const next = nextMessage(agentPort, 'snapshot');

    toggle.click();

    const { changed } = await next;
    expect(changed).toEqual([expect.objectContaining({ selector: 'toggle', checked: true })]);
  });

  it('reports a filled value in the next snapshot, under the field’s label', async () => {
    await loadPage(`
      <label for="q">Search</label><input id="q" data-testid="search" type="text" />
      <button data-testid="go">Go</button>`);
    const next = nextMessage(agentPort, 'snapshot');

    agentPort.postMessage({
      type: 'action',
      id: 'f6',
      action: 'fill',
      args: ['search', 'pricing'],
    });

    const { changed } = await next;
    expect(changed).toEqual([
      {
        selector: 'search',
        tag: 'input',
        label: 'Search',
        disabled: false,
        hidden: false,
        value: 'pricing',
      },
    ]);
  });

  it('never reports a password’s value, even as its name', async () => {
    const { full } = await loadPage(
      '<input data-testid="pw" type="password" value="hunter2" /><button data-testid="b">B</button>',
    );

    expect(full[0]).toEqual({
      selector: 'pw',
      tag: 'input',
      label: '',
      disabled: false,
      hidden: false,
    });
  });

  it('reports a textarea’s and a select’s value, a long one cut to 60 characters', async () => {
    const long = 'x'.repeat(100);
    const { full } = await loadPage(`
      <textarea data-testid="notes">${long}</textarea>
      <select data-testid="plan"><option>Free</option><option selected>Pro</option></select>`);

    expect(full.map((node) => node.value)).toEqual([`${'x'.repeat(60)}…`, 'Pro']);
  });

  it('reports a select by its options’ visible text, not their values', async () => {
    const { full } = await loadPage(`
      <label for="plan">Plan</label>
      <select id="plan" data-testid="plan">
        <option value="free">Free plan</option>
        <option value="pro" selected>Pro plan</option>
      </select>`);

    expect(full).toEqual([
      {
        selector: 'plan',
        tag: 'select',
        label: 'Plan',
        disabled: false,
        hidden: false,
        value: 'Pro plan',
        options: ['Free plan', 'Pro plan'],
      },
    ]);
  });

  it('lists at most 20 options, each cut to 60 characters', async () => {
    const options = Array.from(
      { length: 25 },
      (_, i) => `<option value="${i}">${String(i).padStart(2, '0')}${'y'.repeat(80)}</option>`,
    ).join('');
    const { full } = await loadPage(`<select data-testid="many">${options}</select>`);

    const listed = defined(full[0].options, 'the options');
    expect(listed).toHaveLength(20);
    expect(listed[0]).toBe(`00${'y'.repeat(58)}…`);
    expect(full[0].value).toBe(listed[0]);
  });

  it('reports an empty select with no value', async () => {
    const { full } = await loadPage('<select data-testid="none"></select>');

    expect(full[0]).toMatchObject({ value: '', options: [] });
  });

  it('sends a snapshot with the newly selected option’s text after a fill', async () => {
    await loadPage(`<select data-testid="plan">
      <option value="free">Free plan</option>
      <option value="pro">Pro plan</option>
    </select>`);
    const next = nextMessage(agentPort, 'snapshot');

    agentPort.postMessage({ type: 'action', id: 'f12', action: 'fill', args: ['plan', 'pro'] });

    const { changed } = await next;
    expect(changed).toEqual([expect.objectContaining({ selector: 'plan', value: 'Pro plan' })]);
  });

  it('names a submit input by its value, which is its caption', async () => {
    const { full } = await loadPage('<input data-testid="send" type="submit" value="Send" />');

    expect(full).toEqual([
      { selector: 'send', tag: 'input', label: 'Send', disabled: false, hidden: false },
    ]);
  });

  it('never reports a hidden input’s value', async () => {
    const { full } = await loadPage(
      '<input data-testid="csrf" type="hidden" value="secret-token" /><button data-testid="b">B</button>',
    );

    expect(full[0]).not.toHaveProperty('value');
    expect(JSON.stringify(full)).not.toContain('secret-token');
  });

  it.each(['cc-number', 'cc-csc', 'one-time-code', 'current-password', 'new-password'])(
    'never reports the value of a field with autocomplete="%s"',
    async (autocomplete) => {
      const { full } = await loadPage(
        `<input data-testid="f" type="text" autocomplete="${autocomplete}" value="4111111111111111" />`,
      );

      expect(full[0]).not.toHaveProperty('value');
      expect(JSON.stringify(full)).not.toContain('4111');
    },
  );

  it('names an unlabelled field by aria-labelledby, then placeholder, then title', async () => {
    const { full } = await loadPage(`
      <span id="cap">Promo code</span>
      <input data-testid="by-ref" aria-labelledby="cap" />
      <input data-testid="by-placeholder" placeholder="Search" />
      <input data-testid="by-title" title="Your email" />`);

    expect(full.map((node) => [node.selector, node.label])).toEqual([
      ['by-ref', 'Promo code'],
      ['by-placeholder', 'Search'],
      ['by-title', 'Your email'],
    ]);
  });

  // The accessible-name order (accname 1.2): aria-labelledby wins over
  // aria-label, a <label> and the content.
  it('names an element by aria-labelledby before aria-label, its label or its text', async () => {
    const { full } = await loadPage(`
      <span id="cap">Promo code</span>
      <label for="f">Code</label>
      <input id="f" data-testid="field" aria-labelledby="cap" aria-label="Ignored" />
      <button data-testid="btn" aria-labelledby="cap">Apply</button>`);

    expect(full.map((node) => [node.selector, node.label])).toEqual([
      ['field', 'Promo code'],
      ['btn', 'Promo code'],
    ]);
  });

  it('caps every name source at 60 characters, placeholder, title and aria-label included', async () => {
    const long = 'x'.repeat(100);
    const { full } = await loadPage(`
      <input data-testid="by-placeholder" placeholder="${long}" />
      <input data-testid="by-title" title="${long}" />
      <button data-testid="by-aria-label" aria-label="${long}">Go</button>`);

    expect(full.map((node) => node.label.length)).toEqual([60, 60, 60]);
  });
});

// An action's result waits for the page to settle, and the snapshot of the
// settled page goes out first, so the agent can send it inside that action's
// tool response (#25). Settled: no mutation, input or change for
// SETTLE_QUIET_MS, or SETTLE_CAP_MS after the action, whichever comes first,
// and all of it inside ACTION_DEADLINE_MS from the action's start.
describe("sandbox/bridge.js an action's page", () => {
  const SETTLE_QUIET_MS = 100;
  const SETTLE_CAP_MS = 1000;
  const SNAPSHOT_DEBOUNCE_MS = 250;
  const ACTION_DEADLINE_MS = 3700;
  // Captured before any test fakes setTimeout: a real wait, so a port message
  // that is going to arrive gets the chance to.
  const realSetTimeout = globalThis.setTimeout;
  const sleep = (/** @type {number} */ ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
  // Waits, in real time, for port messages that are on their way: a fixed
  // sleep can be too short on a loaded machine.
  /** @param {() => boolean} predicate */
  async function until(predicate) {
    for (let waited = 0; !predicate() && waited < 2000; waited += 5) await sleep(5);
  }

  // A Home-like page whose increment button, like target-app/home.js, bumps
  // the counter in its click handler. Resolves once the load's snapshot and
  // the debounced one of the new content are in, so a test starts quiet.
  async function loadCounterPage() {
    /** @type {BridgeMessage[]} */
    const messages = [];
    agentPort.onmessage = ({ data }) => messages.push(data);
    frame.load('/target-app/index.html');
    frame.doc.body.innerHTML = `
      <span data-testid="counter-value">0</span>
      <button data-testid="counter-increment">Increment</button>
      <button data-testid="noop">Nothing</button>`;
    byTestId('counter-increment').addEventListener('click', () => {
      const value = byTestId('counter-value');
      value.textContent = String(Number(value.textContent) + 1);
    });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
    await until(() => messages.some((m) => m.type === 'snapshot' && m.full.length > 0));
    expect(messages.at(-1)).toMatchObject({ type: 'snapshot', full: expect.any(Array) });
    messages.length = 0;
    return messages;
  }

  /**
   * Posts a click and resolves once the bridge has run it, so the fake clock
   * only moves after the action started.
   * @param {string} id @param {string} selector
   */
  async function click(id, selector) {
    const el = frame.doc.querySelector(`[data-testid="${selector}"]`);
    let clicked = !el; // a missing element is never clicked
    el?.addEventListener('click', () => (clicked = true), { once: true });
    agentPort.postMessage({ type: 'action', id, action: 'click', args: [selector] });
    await until(() => clicked);
  }

  beforeEach(() => {
    // performance too: the bridge measures its deadline with performance.now().
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });

  it('posts the snapshot showing a click’s change before the click’s result, and no second one', async () => {
    const messages = await loadCounterPage();

    await click('c1', 'counter-increment');
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS);
    await until(() => messages.length >= 2);

    expect(messages).toEqual([
      {
        type: 'snapshot',
        full: expect.any(Array),
        changed: [expect.objectContaining({ selector: 'counter-value', label: '1' })],
        removed: [],
      },
      { type: 'action-result', id: 'c1', success: true },
    ]);
    // The click's mutation scheduled the debounced snapshot too; the settled
    // one replaced it, so nothing follows once the debounce would have fired.
    await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS * 2);
    await sleep(20);
    expect(messages).toHaveLength(2);
  });

  it('answers a click that changes nothing once the quiet window has passed, with an empty diff first', async () => {
    const messages = await loadCounterPage();

    await click('c2', 'noop');
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS - 1);
    await sleep(20);
    expect(messages).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await until(() => messages.length >= 2);
    expect(messages).toEqual([
      { type: 'snapshot', full: expect.any(Array), changed: [], removed: [] },
      { type: 'action-result', id: 'c2', success: true },
    ]);
  });

  it('restarts the quiet window on every mutation, and answers by the cap on a page that never stops', async () => {
    const messages = await loadCounterPage();
    const value = byTestId('counter-value');

    await click('c3', 'noop');
    // A mutation every 50 ms, so the page is never quiet for 100 ms.
    for (let elapsed = 0; elapsed < SETTLE_CAP_MS - 50; elapsed += 50) {
      value.setAttribute('data-tick', String(elapsed));
      await vi.advanceTimersByTimeAsync(50);
    }
    await sleep(20);
    expect(messages).toEqual([]);

    value.setAttribute('data-tick', 'last');
    await vi.advanceTimersByTimeAsync(50);
    await until(() => messages.length >= 2);
    expect(messages.map((m) => m.type)).toEqual(['snapshot', 'action-result']);
    expect(messages[1]).toEqual({ type: 'action-result', id: 'c3', success: true });
  });

  it('answers a failed action at once, with no snapshot', async () => {
    const messages = await loadCounterPage();

    await click('c4', 'missing');
    await until(() => messages.length >= 1);

    expect(messages).toEqual([
      {
        type: 'action-result',
        id: 'c4',
        success: false,
        error: 'No element with data-testid="missing"',
      },
    ]);
  });

  it('posts a navigate’s settled snapshot after the load’s own, then the result', async () => {
    /** @type {BridgeMessage[]} */
    const messages = [];
    agentPort.onmessage = ({ data }) => messages.push(data);
    const srcSet = frame.nextSrcSet();
    agentPort.postMessage({ type: 'action', id: 'n1', action: 'navigate', args: ['settings'] });
    await srcSet;

    frame.load('/target-app/settings.html');
    frame.doc.body.innerHTML = '<button data-testid="save-button">Save</button>';
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS);
    await until(() => messages.length >= 4);

    expect(messages.map((m) => m.type)).toEqual([
      'navigated',
      'snapshot', // the load's, of the still-empty document
      'snapshot', // the settled page
      'action-result',
    ]);
    expect(messages[2]).toMatchObject({
      full: [expect.objectContaining({ selector: 'save-button' })],
    });
    expect(messages[3]).toEqual({ type: 'action-result', id: 'n1', success: true });
  });

  // An earlier change's debounced snapshot, still pending when an action
  // starts, would land inside the settle window and turn the action's page
  // into a keyframe; the action's own snapshot covers that change instead.
  it('cancels an earlier change’s pending debounced snapshot when an action starts', async () => {
    const messages = await loadCounterPage();
    byTestId('noop').textContent = 'Still nothing';
    await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS - 50);

    await click('c5', 'noop');
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS);
    await until(() => messages.length >= 2);
    await sleep(20);

    expect(messages).toEqual([
      {
        type: 'snapshot',
        full: expect.any(Array),
        changed: [expect.objectContaining({ selector: 'noop', label: 'Still nothing' })],
        removed: [],
      },
      { type: 'action-result', id: 'c5', success: true },
    ]);
  });

  it('still sends that earlier change when the action fails', async () => {
    const messages = await loadCounterPage();
    byTestId('noop').textContent = 'Still nothing';

    await click('c6', 'missing');
    await until(() => messages.length >= 1);
    expect(messages.map((m) => m.type)).toEqual(['action-result']);

    await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS);
    await until(() => messages.length >= 2);
    expect(messages[1]).toMatchObject({
      type: 'snapshot',
      changed: [expect.objectContaining({ selector: 'noop', label: 'Still nothing' })],
    });
  });

  // A link click: the old document doesn't change, so without the wait the
  // response carried an empty delta of the page being left (#25 review).
  // The click handler stands in for the browser starting the navigation.
  /** @param {string} selector */
  function startsNavigation(selector) {
    byTestId(selector).addEventListener('click', () =>
      frame.win.dispatchEvent(new Event('beforeunload')),
    );
  }

  it('answers a click that starts a navigation only once the new page has loaded and settled', async () => {
    const messages = await loadCounterPage();
    startsNavigation('noop');

    await click('l1', 'noop');
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS * 3); // the new page is slow to arrive
    await sleep(20);
    expect(messages).toEqual([]);

    frame.load('/target-app/settings.html');
    frame.doc.body.innerHTML = '<button data-testid="save-button">Save</button>';
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS);
    await until(() => messages.length >= 4);

    expect(messages.map((m) => m.type)).toEqual([
      'navigated',
      'snapshot', // the load's
      'snapshot', // the settled new page
      'action-result',
    ]);
    expect(messages[2]).toMatchObject({
      full: [expect.objectContaining({ selector: 'save-button' })],
    });
    expect(messages[3]).toEqual({ type: 'action-result', id: 'l1', success: true });
  });

  it('answers a click whose navigation never loads by the deadline', async () => {
    const messages = await loadCounterPage();
    startsNavigation('noop');

    await click('l2', 'noop');
    await vi.advanceTimersByTimeAsync(ACTION_DEADLINE_MS - 1);
    await sleep(20);
    expect(messages).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await until(() => messages.length >= 2);
    expect(messages.map((m) => m.type)).toEqual(['snapshot', 'action-result']);
    expect(messages[1]).toEqual({ type: 'action-result', id: 'l2', success: true });

    // That navigation is given up on: the next action doesn't wait for it.
    await click('l3', 'counter-increment');
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS);
    await until(() => messages.length >= 4);
    expect(messages[3]).toEqual({ type: 'action-result', id: 'l3', success: true });
  });

  it('gives up on a navigate that never loads, so the next action answers after the quiet window', async () => {
    const messages = await loadCounterPage();
    const srcSet = frame.nextSrcSet();
    agentPort.postMessage({ type: 'action', id: 'n3', action: 'navigate', args: ['settings'] });
    await srcSet;
    frame.win.dispatchEvent(new Event('beforeunload')); // the browser starting it

    await vi.advanceTimersByTimeAsync(ACTION_DEADLINE_MS);
    await until(() => messages.length >= 1);
    expect(messages).toEqual([
      {
        type: 'action-result',
        id: 'n3',
        success: false,
        error: 'The page did not finish loading.',
      },
    ]);

    await click('c7', 'counter-increment');
    await vi.advanceTimersByTimeAsync(SETTLE_QUIET_MS);
    await until(() => messages.length >= 3);
    expect(messages.slice(1).map((m) => m.type)).toEqual(['snapshot', 'action-result']);
  });

  // The worst case: a navigate whose page loads just before the deadline onto
  // a page that never stops mutating still answers by it, inside the agent
  // channel's 4 s action timeout (bridgeChannel.js).
  it('answers a navigate that loads at the last moment onto a page that never settles by the deadline', async () => {
    /** @type {BridgeMessage[]} */
    const messages = [];
    agentPort.onmessage = ({ data }) => messages.push(data);
    const srcSet = frame.nextSrcSet();
    agentPort.postMessage({ type: 'action', id: 'n2', action: 'navigate', args: ['settings'] });
    await srcSet;

    await vi.advanceTimersByTimeAsync(ACTION_DEADLINE_MS - 50);
    frame.load('/target-app/settings.html');
    frame.doc.body.setAttribute('data-tick', '0');
    await vi.advanceTimersByTimeAsync(40);
    frame.doc.body.setAttribute('data-tick', '1');
    await vi.advanceTimersByTimeAsync(10);

    await until(() => messages.some((m) => m.type === 'action-result'));
    expect(messages.at(-1)).toEqual({ type: 'action-result', id: 'n2', success: true });
    expect(messages.at(-2)).toMatchObject({ type: 'snapshot' });
  });
});
