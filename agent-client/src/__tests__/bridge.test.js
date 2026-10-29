import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// sandbox/ has no package or test runner of its own, so its bridge script is
// run here as the page would run it: a classic script evaluated once against
// this jsdom window. The iframe is stubbed (jsdom doesn't load frame URLs): a
// test decides which document the frame holds and when its `load` fires.
const BRIDGE_SOURCE = readFileSync(path.resolve(import.meta.dirname, '../../../sandbox/bridge.js'), 'utf8');

let frame;
let agentPort;
let openPorts = [];

function stubFrame() {
  document.body.innerHTML = '<iframe id="target-app-frame"></iframe>';
  const iframe = document.getElementById('target-app-frame');
  const state = {
    doc: document.implementation.createHTMLDocument(''),
    path: '/target-app/index.html',
    srcSets: [],
    onSrcSet: null,
  };
  Object.defineProperty(iframe, 'contentDocument', { get: () => state.doc });
  Object.defineProperty(iframe, 'contentWindow', {
    get: () => ({ location: { pathname: state.path }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }),
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
