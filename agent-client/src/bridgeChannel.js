// Private channel to sandbox/bridge.js (docs/adr/0001-private-bridge-channel.md).
// One window.postMessage handshake transfers a MessagePort; after that every
// message travels on the port, so other scripts on the page can neither read
// snapshots/results nor forge them. Deliberately never listens on `window`.

// How long to wait for the bridge to reply to a dispatched action before
// reporting failure to the model — an unresponsive page shouldn't hang the turn.
const ACTION_TIMEOUT_MS = 4000;

function postConnectToWindow(port) {
  window.postMessage({ type: 'ds-bridge-connect' }, window.location.origin, [port]);
}

export function connectBridge({ postConnect = postConnectToWindow } = {}) {
  const { port1: port, port2: bridgePort } = new MessageChannel();
  const pendingActions = new Map(); // id -> { resolve, timer }
  const snapshotListeners = new Set();
  const navigatedListeners = new Set();

  function settleAction(id, result) {
    const pending = pendingActions.get(id);
    if (!pending) return; // unknown or already settled (e.g. timed out)
    clearTimeout(pending.timer);
    pendingActions.delete(id);
    pending.resolve(result);
  }

  // Assigning onmessage starts the port implicitly (no port.start() needed).
  port.onmessage = (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === 'action-result') {
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

  function dispatchAction(action, args) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(
        () => settleAction(id, { success: false, error: 'Timed out waiting for the page to respond.' }),
        ACTION_TIMEOUT_MS,
      );
      pendingActions.set(id, { resolve, timer });
      port.postMessage({ type: 'action', id, action, args });
    });
  }

  function requestSnapshot() {
    port.postMessage({ type: 'request-snapshot' });
  }

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
