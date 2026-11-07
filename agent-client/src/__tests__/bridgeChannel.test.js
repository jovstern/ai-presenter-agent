import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectBridge } from '../bridgeChannel.js';
import { defined } from './defined.js';

/** @import { AgentMessage } from '../bridgeProtocol.js' */

// A fake sandbox/bridge.js end: connectBridge() hands it the transferred port
// through an injected postConnect, because jsdom drops postMessage transfer lists.
function setup() {
  /** @type {MessagePort[]} */
  const handed = [];
  const channel = connectBridge({
    postConnect: (port) => {
      handed.push(port);
    },
  });
  const bridgePort = defined(handed[0], 'the port handed to postConnect');
  /** @type {AgentMessage[]} */
  const inbox = [];
  /** @type {((message: AgentMessage) => void) | null} */
  let waiter = null;
  bridgePort.onmessage = (/** @type {MessageEvent<AgentMessage>} */ event) => {
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(event.data);
    } else {
      inbox.push(event.data);
    }
  };
  /** @returns {Promise<AgentMessage>} */
  const nextBridgeMessage = () =>
    inbox.length
      ? Promise.resolve(defined(inbox.shift()))
      : new Promise((resolve) => (waiter = resolve));
  // The next message, which must be an action (with the id its result answers).
  const nextAction = async () => {
    const message = await nextBridgeMessage();
    if (message.type !== 'action') throw new Error(`expected an action, got ${message.type}`);
    return message;
  };
  return { channel, bridgePort, nextBridgeMessage, nextAction };
}

/** @type {(() => void)[]} */
let cleanup = [];

afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function open() {
  const ends = setup();
  cleanup.push(() => {
    ends.channel.close();
    ends.bridgePort.close();
  });
  return ends;
}

describe('connectBridge', () => {
  it('hands exactly one port to postConnect', () => {
    const postConnect = vi.fn();
    const channel = connectBridge({ postConnect });
    cleanup.push(() => {
      channel.close();
      postConnect.mock.calls[0][0].close();
    });
    expect(postConnect).toHaveBeenCalledTimes(1);
    expect(postConnect.mock.calls[0][0]).toBeInstanceOf(MessagePort);
  });

  it('sends actions on the port and correlates results by id', async () => {
    const { channel, bridgePort, nextAction } = open();

    const first = channel.dispatchAction('click', ['save-button']);
    const second = channel.dispatchAction('navigate', ['settings']);
    const firstMsg = await nextAction();
    const secondMsg = await nextAction();

    expect(firstMsg).toMatchObject({ type: 'action', action: 'click', args: ['save-button'] });
    expect(secondMsg).toMatchObject({ type: 'action', action: 'navigate', args: ['settings'] });
    expect(firstMsg.id).not.toBe(secondMsg.id);

    // Reply out of order: each promise still gets its own result.
    bridgePort.postMessage({ type: 'action-result', id: secondMsg.id, success: true });
    bridgePort.postMessage({
      type: 'action-result',
      id: firstMsg.id,
      success: false,
      error: 'nope',
    });

    await expect(first).resolves.toEqual({ success: false, error: 'nope' });
    await expect(second).resolves.toEqual({ success: true });
  });

  it('ignores a result for an unknown id', async () => {
    const { channel, bridgePort, nextAction } = open();

    const pending = channel.dispatchAction('click', ['a']);
    const { id } = await nextAction();
    bridgePort.postMessage({ type: 'action-result', id: 'someone-else', success: true });
    bridgePort.postMessage({ type: 'action-result', id, success: false, error: 'real reply' });

    await expect(pending).resolves.toEqual({ success: false, error: 'real reply' });
  });

  it('resolves with a failure when the bridge does not reply within 4 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { channel, nextBridgeMessage } = open();

    const pending = channel.dispatchAction('click', ['a']);
    await nextBridgeMessage();
    vi.advanceTimersByTime(3999);
    let settled = false;
    pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    vi.advanceTimersByTime(1);
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it('sends request-snapshot on the port', async () => {
    const { channel, nextBridgeMessage } = open();
    channel.requestSnapshot();
    await expect(nextBridgeMessage()).resolves.toEqual({ type: 'request-snapshot' });
  });

  it('delivers snapshots and navigated events to subscribers', async () => {
    const { channel, bridgePort } = open();
    const snapshot = { full: [{ selector: 'a' }], changed: [], removed: [] };

    const gotSnapshot = new Promise((resolve) => channel.onSnapshot(resolve));
    const gotNavigated = new Promise((resolve) => channel.onNavigated(() => resolve('navigated')));
    bridgePort.postMessage({ type: 'navigated' });
    bridgePort.postMessage({ type: 'snapshot', ...snapshot });

    await expect(gotNavigated).resolves.toBe('navigated');
    await expect(gotSnapshot).resolves.toEqual(snapshot);
  });

  it('passes on how many elements a snapshot of a page over the cap left out', async () => {
    const { channel, bridgePort } = open();
    const snapshot = { full: [{ selector: 'a' }], changed: [], removed: [], omitted: 109 };

    const gotSnapshot = new Promise((resolve) => channel.onSnapshot(resolve));
    bridgePort.postMessage({ type: 'snapshot', ...snapshot });

    await expect(gotSnapshot).resolves.toEqual(snapshot);
  });

  it('stops delivering to a subscriber after it unsubscribes', async () => {
    const { channel, bridgePort } = open();
    const removedSnapshot = vi.fn();
    const removedNavigated = vi.fn();
    channel.onSnapshot(removedSnapshot)();
    channel.onNavigated(removedNavigated)();

    // Subscribers are called in order, so once these resolve the removed ones had their chance.
    const gotNavigated = new Promise((resolve) => channel.onNavigated(() => resolve(undefined)));
    const gotSnapshot = new Promise((resolve) => channel.onSnapshot(resolve));
    bridgePort.postMessage({ type: 'navigated' });
    bridgePort.postMessage({ type: 'snapshot', full: [], changed: [], removed: [] });
    await gotNavigated;
    await gotSnapshot;

    expect(removedSnapshot).not.toHaveBeenCalled();
    expect(removedNavigated).not.toHaveBeenCalled();
  });

  it('ignores forged results and snapshots posted on window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const addListener = vi.spyOn(window, 'addEventListener');
    const { channel, nextAction } = open();
    const onSnapshot = vi.fn();
    channel.onSnapshot(onSnapshot);

    const pending = channel.dispatchAction('click', ['a']);
    const { id } = await nextAction();

    // A co-resident page script that guessed the id still can't answer for the bridge.
    const origin = window.location.origin;
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        data: { type: 'ds-action-result', id, success: true },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', { origin, data: { type: 'action-result', id, success: true } }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        data: { type: 'ds-dom-snapshot', full: [], changed: [], removed: [] },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        data: { type: 'snapshot', full: [], changed: [], removed: [] },
      }),
    );

    expect(addListener).not.toHaveBeenCalledWith('message', expect.anything());
    expect(onSnapshot).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    await expect(pending).resolves.toMatchObject({ success: false });
  });

  it('close() settles pending actions as failures', async () => {
    const { channel, nextBridgeMessage } = open();
    const pending = channel.dispatchAction('click', ['a']);
    await nextBridgeMessage();
    channel.close();
    await expect(pending).resolves.toMatchObject({ success: false });
  });
});

describe('connectBridge vs. a patched MessagePort.prototype.postMessage', () => {
  it('keeps sending on the port with the postMessage captured at load', async () => {
    const { channel, nextBridgeMessage } = open();
    // Patched after load, calling through: the channel must not send with it.
    const tap = vi.spyOn(MessagePort.prototype, 'postMessage');
    try {
      channel.requestSnapshot();
      channel.dispatchAction('click', ['save-button']);
      expect(await nextBridgeMessage()).toEqual({ type: 'request-snapshot' });
      expect(await nextBridgeMessage()).toMatchObject({ type: 'action', action: 'click' });
      expect(tap).not.toHaveBeenCalled();
    } finally {
      tap.mockRestore();
    }
  });
});
