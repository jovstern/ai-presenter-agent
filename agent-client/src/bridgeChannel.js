// Private channel to sandbox/bridge.js (docs/adr/0001-private-bridge-channel.md).
// One window.postMessage handshake transfers a MessagePort; after that every
// message travels on the port, so passive `message` listeners on the page never
// see snapshots/results, and forged `window` messages are ignored. Deliberately
// never listens on `window`.
//
// What it does NOT stop: a same-realm script can patch
// MessagePort.prototype.postMessage to read or alter what is sent. `send`
// below is captured when this script loads, which closes patching *after*
// load; a patch made *before* load, or a hostile script winning the handshake
// before ours (the pre-handshake hijack), remain open until the clone runs on
// another origin (docs/code-review-notes.md H1).

/** @import { ActionResult, AgentMessage, BridgeMessage, ConnectMessage, Snapshot } from './bridgeProtocol.js' */

const send = MessagePort.prototype.postMessage;

// How long to wait for the bridge to reply to a dispatched action before
// reporting failure to the model — an unresponsive page shouldn't hang the turn.
const ACTION_TIMEOUT_MS = 4000;

/**
 * The agent's end of the bridge channel. main.jsx opens one per page and never
 * closes it; a live session only subscribes and unsubscribes.
 * @typedef {object} BridgeChannel
 * @property {(action: string, args: unknown[]) => Promise<ActionResult>} dispatchAction
 *   Runs one action on the page. Always resolves: a timeout or close becomes a failure.
 * @property {() => void} requestSnapshot Asks the bridge for a snapshot now.
 * @property {(callback: (snapshot: Snapshot) => void) => () => void} onSnapshot
 *   Subscribes; returns the unsubscribe function.
 * @property {(callback: () => void) => () => void} onNavigated
 *   Subscribes; returns the unsubscribe function.
 * @property {() => void} close Fails every pending action and closes the port.
 */

/**
 * `send` takes `any`; this pins what goes on the port to the protocol.
 * @param {MessagePort} port
 * @param {AgentMessage} message
 */
function postToBridge(port, message) {
  send.call(port, message);
}

/** @param {MessagePort} port */
function postConnectToWindow(port) {
  /** @type {ConnectMessage} */
  const message = { type: 'ds-bridge-connect' };
  window.postMessage(message, window.location.origin, [port]);
}

/**
 * @param {{ postConnect?: (port: MessagePort) => void }} [options]
 *   `postConnect` delivers the bridge's port; tests replace the window handshake.
 * @returns {BridgeChannel}
 */
export function connectBridge({ postConnect = postConnectToWindow } = {}) {
  const { port1: port, port2: bridgePort } = new MessageChannel();
  /** @type {Map<string, { resolve: (result: ActionResult) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pendingActions = new Map();
  /** @type {Set<(snapshot: Snapshot) => void>} */
  const snapshotListeners = new Set();
  /** @type {Set<() => void>} */
  const navigatedListeners = new Set();

  /**
   * @param {string} id
   * @param {ActionResult} result
   */
  function settleAction(id, result) {
    const pending = pendingActions.get(id);
    if (!pending) return; // unknown or already settled (e.g. timed out)
    clearTimeout(pending.timer);
    pendingActions.delete(id);
    pending.resolve(result);
  }

  // Assigning onmessage starts the port implicitly (no port.start() needed).
  // The bridge is our own script on the same page, so its messages are taken
  // at the protocol's word; what matters is that nothing else can post here.
  port.onmessage = (/** @type {MessageEvent<BridgeMessage | null>} */ event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === 'action-result') {
      /** @type {ActionResult} */
      const result = { success: data.success };
      if (data.error !== undefined) result.error = data.error;
      settleAction(data.id, result);
    } else if (data.type === 'snapshot') {
      const snapshot = { full: data.full, changed: data.changed, removed: data.removed };
      snapshotListeners.forEach((listener) => listener(snapshot));
    } else if (data.type === 'navigated') {
      navigatedListeners.forEach((listener) => listener());
    }
  };

  postConnect(bridgePort);

  /**
   * @param {string} action
   * @param {unknown[]} args
   * @returns {Promise<ActionResult>}
   */
  function dispatchAction(action, args) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(
        () =>
          settleAction(id, { success: false, error: 'Timed out waiting for the page to respond.' }),
        ACTION_TIMEOUT_MS,
      );
      pendingActions.set(id, { resolve, timer });
      postToBridge(port, { type: 'action', id, action, args });
    });
  }

  function requestSnapshot() {
    postToBridge(port, { type: 'request-snapshot' });
  }

  /**
   * @template {(...args: never[]) => void} Listener
   * @param {Set<Listener>} listeners
   * @param {Listener} callback
   * @returns {() => boolean}
   */
  function subscribe(listeners, callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  function close() {
    [...pendingActions.keys()].forEach((id) =>
      settleAction(id, { success: false, error: 'The page connection was closed.' }),
    );
    snapshotListeners.clear();
    navigatedListeners.clear();
    port.close();
  }

  return {
    dispatchAction,
    requestSnapshot,
    onSnapshot: (callback) => subscribe(snapshotListeners, callback),
    onNavigated: (callback) => subscribe(navigatedListeners, callback),
    close,
  };
}
