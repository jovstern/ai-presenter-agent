import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const ROUTES = JSON.parse(ROUTES_JSON);

let frame;
let agentPort;
let openPorts = [];

function stubFrame(
  routesBlock = `<script type="application/json" id="ds-routes">${ROUTES_JSON}</script>`,
) {
  document.body.innerHTML = `<iframe id="target-app-frame"></iframe>${routesBlock}`;
  const iframe = document.getElementById('target-app-frame');
  const state = {
    doc: document.implementation.createHTMLDocument(''),
    path: '/target-app/index.html',
    srcSets: [],
    onSrcSet: null,
  };
  Object.defineProperty(iframe, 'contentDocument', { get: () => state.doc });
  Object.defineProperty(iframe, 'contentWindow', {
    get: () => ({
      location: { pathname: state.path },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      // The frame's realm: its documents are this jsdom window's.
      HTMLInputElement: window.HTMLInputElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement,
      HTMLSelectElement: window.HTMLSelectElement,
    }),
  });
  Object.defineProperty(iframe, 'src', {
    get: () => state.srcSets.at(-1) ?? '',
    set: (value) => {
      state.srcSets.push(value);
      state.onSrcSet?.(value);
    },
  });
  // A new document at `path` finishes loading in the frame.
  state.load = (path) => {
    state.path = path;
    state.doc = document.implementation.createHTMLDocument('');
    iframe.dispatchEvent(new Event('load'));
  };
  state.nextSrcSet = () => new Promise((resolve) => (state.onSrcSet = resolve));
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

function nextMessage(port, type) {
  return new Promise((resolve) => {
    port.onmessage = (event) => {
      if (event.data?.type === type) resolve(event.data);
    };
  });
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const srcSet = frame.nextSrcSet();
    const replies = [];
    agentPort.onmessage = (event) => replies.push(event.data);
    agentPort.postMessage({ type: 'action', id: 'a3', action: 'navigate', args: ['settings'] });
    await srcSet;

    await vi.advanceTimersByTimeAsync(3_499);
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
    expect(frame.doc.querySelector('input').value).toBe('Ada');
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
    const target = frame.doc.querySelector('[data-testid="target"]');
    expect(target.value === 'Ada').toBe(false);
  });

  it.each([
    ['a textarea', '<textarea data-testid="target"></textarea>', 'Ada'],
    ['an email input', '<input data-testid="target" type="email" />', 'ada@example.com'],
  ])('fills %s', async (_name, html, value) => {
    frame.doc.body.innerHTML = html;
    const result = nextMessage(agentPort, 'action-result');
    agentPort.postMessage({ type: 'action', id: 'f5', action: 'fill', args: ['target', value] });

    expect(await result).toMatchObject({ id: 'f5', success: true });
    expect(frame.doc.querySelector('[data-testid="target"]').value).toBe(value);
  });

  const PLAN = `<select data-testid="plan">
      <option value="free">Free plan</option>
      <option value="pro">Pro plan</option>
      <option value="team">Team plan</option>
    </select>`;

  /** Sends one fill and resolves with its reply. */
  function fill(id, selector, value) {
    const result = nextMessage(agentPort, 'action-result');
    agentPort.postMessage({ type: 'action', id, action: 'fill', args: [selector, value] });
    return result;
  }

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
    expect(frame.doc.querySelector('select').value).toBe('pro');
  });

  it('prefers an option whose text matches over one whose value does', async () => {
    frame.doc.body.innerHTML = `<select data-testid="plan">
      <option value="b">a</option>
      <option value="a">b</option>
    </select>`;

    expect(await fill('f8', 'plan', 'a')).toMatchObject({ success: true });
    expect(frame.doc.querySelector('select').value).toBe('b');
  });

  it('fails, naming the options, and leaves the selection alone when no option matches', async () => {
    frame.doc.body.innerHTML = PLAN;
    const select = frame.doc.querySelector('select');
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
    const seen = [];
    const record = (event) => seen.push([event.type, event.bubbles, event.target.value]);
    frame.doc.body.addEventListener('input', record);
    frame.doc.body.addEventListener('change', record);

    expect(await fill('f10', 'target', value)).toMatchObject({ success: true });
    const expected = frame.doc.querySelector('[data-testid="target"]').value;
    expect(seen).toEqual([
      ['input', true, expected],
      ['change', true, expected],
    ]);
  });

  // A framework's controlled input (React) tracks the value through the
  // element's own `value` property; only the prototype's native setter gets
  // past that, so the bridge must not assign through the instance.
  it.each([
    ['an input', '<input data-testid="target" />', 'HTMLInputElement', 'Ada', 'Ada'],
    [
      'a textarea',
      '<textarea data-testid="target"></textarea>',
      'HTMLTextAreaElement',
      'Ada',
      'Ada',
    ],
    [
      'a select',
      PLAN.replace('data-testid="plan"', 'data-testid="target"'),
      'HTMLSelectElement',
      'Pro plan',
      'pro',
    ],
  ])(
    'sets %s through its prototype’s native value setter',
    async (_name, html, type, value, set) => {
      frame.doc.body.innerHTML = html;
      const target = frame.doc.querySelector('[data-testid="target"]');
      const instanceSetter = vi.fn();
      Object.defineProperty(target, 'value', {
        configurable: true,
        get: () => '',
        set: instanceSetter,
      });
      const { prototype } = window[type];
      const native = Object.getOwnPropertyDescriptor(prototype, 'value');
      const nativeSetter = vi.fn(function (v) {
        native.set.call(this, v);
      });
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

describe('sandbox/bridge.js channel', () => {
  it('keeps replying on the port when MessagePort.prototype.postMessage is patched after load', async () => {
    const tap = vi.fn();
    const original = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...args) {
      tap(...args);
      return original.apply(this, args);
    };
    try {
      const result = nextMessage(agentPort, 'action-result');
      // Sent with the captured original, so the tap only sees the bridge's reply if the bridge used the patched one.
      original.call(agentPort, { type: 'action', id: 'a4', action: 'click', args: ['missing'] });
      expect(await result).toMatchObject({ id: 'a4', success: false });
      expect(tap).not.toHaveBeenCalled();
    } finally {
      MessagePort.prototype.postMessage = original;
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
  function loadPage(html) {
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
    const toggle = frame.doc.querySelector('[data-testid="toggle"]');
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

    expect(full[0].options).toHaveLength(20);
    expect(full[0].options[0]).toBe(`00${'y'.repeat(58)}…`);
    expect(full[0].value).toBe(full[0].options[0]);
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
