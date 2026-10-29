// Types only: the messages agent-client and sandbox/bridge.js exchange
// (docs/adr/0001-private-bridge-channel.md, the spec's "Data model" table).
// bridge.js is an unbundled classic script and can't import this, so it holds
// a verbatim copy of the region below; __tests__/bridgeProtocol.test.js fails
// if the two drift. Edit both together.

// #region bridge protocol: the source copy, mirrored in sandbox/bridge.js
/**
 * The actions the bridge's allowlist runs on the target app.
 * @typedef {'click' | 'scroll' | 'fill' | 'navigate'} ActionName
 */
/**
 * What one action did: `error` says why when `success` is false.
 * @typedef {{ success: boolean, error?: string }} ActionResult
 */
/**
 * One interactive element of the target app, keyed by its data-testid.
 * `checked` is set for checkboxes and radio buttons only. `value` is set
 * for text inputs, textareas and selects (never a password), cut to 60
 * characters plus an ellipsis.
 * @typedef {{ selector: string, tag: string, label: string, disabled: boolean, hidden: boolean, checked?: boolean, value?: string }} SnapshotNode
 */
/**
 * The full node list plus its diff against the bridge's previous snapshot.
 * `removed` holds selectors.
 * @typedef {{ full: SnapshotNode[], changed: SnapshotNode[], removed: string[] }} Snapshot
 */
/**
 * The handshake, posted to `window` with the bridge's MessagePort as its one
 * transfer. Everything after it travels on the port.
 * @typedef {{ type: 'ds-bridge-connect' }} ConnectMessage
 */
/**
 * agent -> bridge. `action` is the model's function name, unchecked on the
 * agent side: the bridge's allowlist is the authority. `args` are the model's
 * values in actionTools' positional order, unvalidated for the same reason.
 * @typedef {{ type: 'action', id: string, action: string, args: unknown[] }} ActionMessage
 */
/**
 * agent -> bridge: send a snapshot now rather than on the next DOM mutation.
 * @typedef {{ type: 'request-snapshot' }} RequestSnapshotMessage
 */
/**
 * bridge -> agent: the reply to the ActionMessage with the same `id`.
 * @typedef {{ type: 'action-result', id: string, success: boolean, error?: string }} ActionResultMessage
 */
/**
 * bridge -> agent: after every load and debounced DOM mutation, and on request.
 * @typedef {{ type: 'snapshot', full: SnapshotNode[], changed: SnapshotNode[], removed: string[] }} SnapshotMessage
 */
/**
 * bridge -> agent: a new document loaded in the frame. Sent before that
 * load's snapshot.
 * @typedef {{ type: 'navigated' }} NavigatedMessage
 */
/**
 * Everything the agent posts on the port.
 * @typedef {ActionMessage | RequestSnapshotMessage} AgentMessage
 */
/**
 * Everything the bridge posts on the port.
 * @typedef {ActionResultMessage | SnapshotMessage | NavigatedMessage} BridgeMessage
 */
// #endregion

export {};
