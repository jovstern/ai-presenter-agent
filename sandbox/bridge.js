// @ts-check
// Runs on sandbox/index.html (top-level), not inside the iframe; the bridge
// manipulates the iframe's DOM directly since both are same-origin. It talks
// to agent-client over a private MessageChannel: one window.postMessage
// handshake transfers the port, then all traffic stays on it.
(function () {
  // Type-checked by agent-client's `npm run typecheck` (docs/adr/0002). An
  // unbundled script can't import, so the protocol types are copied in; the
  // agent-client test bridgeProtocol.test.js fails if the copies drift.
  // #region bridge protocol: a verbatim copy of agent-client/src/bridgeProtocol.js
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
   * @typedef {{ selector: string, tag: string, label: string, disabled: boolean, hidden: boolean }} SnapshotNode
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

  // Captured at load, so a script that patches MessagePort.prototype.postMessage
  // later can't read or alter replies (a patch made before load still can;
  // see the residual risks below and docs/adr/0001-private-bridge-channel.md).
  const send = MessagePort.prototype.postMessage;

  /** @type {string[]} */
  const KNOWN_ROUTES = ['home', 'settings'];
  // Absolute, not relative to target-app/ — iframe.src resolves against the
  // parent (sandbox) page's URL, not the iframe's current document.
  /** @type {Record<string, string>} */
  const ROUTE_PATHS = { home: '/target-app/index.html', settings: '/target-app/settings.html' };

  // Size cap so a larger page can't blow the model's context — a guess, not
  // tuned against a real page yet (docs/project-knowledge-handoff.md §3.3).
  const MAX_SNAPSHOT_NODES = 30;
  const SNAPSHOT_DEBOUNCE_MS = 250;
  // Kept under agent-client's ACTION_TIMEOUT_MS (4000, bridgeChannel.js) so a
  // navigate that never loads gets this bridge's own, specific failure back to
  // the model. Longer than that, the agent side gives up first with a generic
  // timeout, and this bridge's late reply lands on an id nobody waits for.
  const NAVIGATION_TIMEOUT_MS = 3500;

  const frameElement = document.getElementById('target-app-frame');
  // sandbox/index.html puts the frame before this deferred script; without it
  // the bridge can do nothing, so fail loudly here rather than on first use.
  if (!(frameElement instanceof HTMLIFrameElement)) {
    throw new Error('bridge.js: no <iframe id="target-app-frame"> on the page');
  }
  const iframe = frameElement; // narrowed once, for the hoisted functions below

  // The action library lives in this closure, never on `window` — a page
  // script reaching `window.dsActions.click(...)` directly would bypass the
  // channel/allowlist checks below entirely (docs/project-knowledge-handoff.md
  // §1.10, the exact v1 gap this is designed around).
  //
  // Binding to the agent is a private MessageChannel instead of a session
  // token (docs/adr/0001-private-bridge-channel.md): passive `message`
  // listeners on the page never see snapshots/results, and forged `window`
  // messages are ignored. Residual risks, documented and not closed: a hostile
  // script that runs *before* agent-client's handshake could connect first and
  // take the bridge, and one that patches MessagePort.prototype.postMessage
  // before this script loads sees the traffic; closing both needs the clone on
  // another origin (docs/code-review-notes.md H1).
  // The cast: the target app's data-testid elements are HTML, and the frame's
  // realm makes `instanceof HTMLElement` false even for those. Should one ever
  // be SVG, its missing click() throws inside runAction and becomes a failure.
  /**
   * @param {string} testId
   * @returns {HTMLElement | null}
   */
  function findByTestId(testId) {
    const el = iframe.contentDocument?.querySelector(`[data-testid="${testId}"]`) ?? null;
    return /** @type {HTMLElement | null} */ (el);
  }

  // Navigations waiting for their page.
  /** @type {{ path: string, settle: (loaded: boolean) => void }[]} */
  let loadWaiters = [];

  // Resolves true once a document at `path` loads in the frame, or false after
  // NAVIGATION_TIMEOUT_MS. Matched by path, so a load of some other page in
  // the meantime (the viewer clicking a link in the frame) doesn't count as
  // this navigate finishing. A load of the same path from another cause can't
  // be told apart, but it does put the requested page in place all the same.
  /**
   * @param {string} path
   * @returns {Promise<boolean>}
   */
  function waitForLoadOf(path) {
    return new Promise((resolve) => {
      const waiter = {
        path,
        /** @param {boolean} loaded */
        settle(loaded) {
          clearTimeout(timer);
          loadWaiters = loadWaiters.filter((w) => w !== waiter);
          resolve(loaded);
        },
      };
      const timer = setTimeout(() => waiter.settle(false), NAVIGATION_TIMEOUT_MS);
      loadWaiters.push(waiter);
    });
  }

  // Each action takes the positional args actionTools.js orders for it.
  /** @type {Record<ActionName, (...args: string[]) => Promise<ActionResult>>} */
  const actions = {
    async click(selector) {
      const el = findByTestId(selector);
      if (!el) return { success: false, error: `No element with data-testid="${selector}"` };
      el.click();
      return { success: true };
    },
    async scroll(selector) {
      const el = findByTestId(selector);
      if (!el) return { success: false, error: `No element with data-testid="${selector}"` };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { success: true };
    },
    async navigate(route) {
      if (!KNOWN_ROUTES.includes(route)) {
        return { success: false, error: `Unknown route "${route}"` };
      }
      const loaded = waitForLoadOf(ROUTE_PATHS[route]);
      iframe.src = ROUTE_PATHS[route];
      // Don't report success until the new document is actually in place, and
      // don't claim it was when it never arrived.
      if (!(await loaded)) return { success: false, error: 'The page did not finish loading.' };
      return { success: true };
    },
    async fill(selector, value) {
      const el = findByTestId(selector);
      if (!el) return { success: false, error: `No element with data-testid="${selector}"` };
      // An element with no `value` used to get an expando set and a success
      // reply while nothing visible changed; the model should hear the truth.
      if (!('value' in el)) {
        return { success: false, error: `data-testid="${selector}" is not a text input` };
      }
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { success: true };
    },
  };

  /**
   * @param {string} action
   * @returns {action is ActionName}
   */
  function isAllowedAction(action) {
    return Object.prototype.hasOwnProperty.call(actions, action);
  }

  // The agent's end of the channel; null until the first valid handshake.
  /** @type {MessagePort | null} */
  let agentPort = null;

  /** @param {BridgeMessage} message */
  function postToAgent(message) {
    if (agentPort) send.call(agentPort, message);
  }

  // Accept the first ds-bridge-connect only: posted by this window itself
  // (not the target-app iframe or any other frame), same origin, carrying
  // exactly one port. After that the listener is removed, so later connects
  // are ignored and nothing else is ever read off `window`.
  /** @param {MessageEvent<unknown>} event Any page script can post to `window`. */
  function handleConnect(event) {
    if (event.origin !== window.location.origin || event.source !== window) return;
    const { data } = event;
    const isConnect =
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      data.type === 'ds-bridge-connect';
    if (!isConnect || event.ports.length !== 1) return;
    window.removeEventListener('message', handleConnect);
    agentPort = event.ports[0];
    agentPort.onmessage = handleAgentMessage; // starts the port implicitly
  }

  window.addEventListener('message', handleConnect);

  /**
   * @param {ActionMessage} message
   * @returns {Promise<ActionResultMessage>}
   */
  async function runAction({ id, action, args }) {
    if (!isAllowedAction(action)) {
      return {
        type: 'action-result',
        id,
        success: false,
        error: `Action "${action}" is not allowed`,
      };
    }
    // A throwing action must still reply, or the agent waits out its timeout
    // (docs/code-review-notes.md M3).
    try {
      // The agent forwards the model's values unchecked, and the actions take
      // them as they come: a non-string selector matches nothing, a non-string
      // fill value is stringified by the input. Hence the cast, not a check.
      const positional = /** @type {string[]} */ (Array.isArray(args) ? args : []);
      const result = await actions[action](...positional);
      return { ...result, type: 'action-result', id };
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      return { type: 'action-result', id, success: false, error: message || String(err) };
    }
  }

  // The port is private to agent-client (ADR 0001), so its messages are
  // taken at the protocol's word; runAction still guards the action and args.
  /** @param {MessageEvent<AgentMessage | null>} event */
  async function handleAgentMessage(event) {
    const data = event.data;
    if (data?.type === 'request-snapshot') {
      diffAndBroadcastSnapshot();
    } else if (data?.type === 'action') {
      postToAgent(await runAction(data));
    }
  }

  // --- DOM grounding snapshot ---
  // Flattened list of interactive/meaningful nodes only, keyed by their
  // data-testid. Always computes the full set *and* a diff (changed/removed)
  // against the last one — cheap, same-process, regardless of page size. The
  // decision that costs tokens (whether to tell the *model* the whole page or
  // just the diff) is made downstream in agent-client/src/domSnapshotContext.js.
  /** @type {Map<string, SnapshotNode>} */
  let lastNodesById = new Map();

  // Elements come from the frame's realm, so `instanceof HTMLElement` (this
  // realm's) would be false for all of them: properties are probed with `in`.
  /** @param {Element} el */
  function labelFor(el) {
    const value = 'value' in el && typeof el.value === 'string' ? el.value : '';
    return el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60) || value || '';
  }

  /**
   * @param {Element} el
   * @param {CSSStyleDeclaration} computedStyle
   */
  function isHidden(el, computedStyle) {
    return (
      ('hidden' in el && el.hidden === true) ||
      computedStyle.display === 'none' ||
      computedStyle.visibility === 'hidden'
    );
  }

  /** @returns {SnapshotNode[]} */
  function buildSnapshotNodes() {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) return [];
    const elements = [...doc.querySelectorAll('[data-testid]')].slice(0, MAX_SNAPSHOT_NODES);
    return elements.map((el) => {
      const computedStyle = win.getComputedStyle(el);
      return {
        selector: el.getAttribute('data-testid') ?? '', // always set: the query requires it
        tag: el.tagName.toLowerCase(),
        label: labelFor(el),
        disabled: 'disabled' in el && el.disabled === true,
        hidden: isHidden(el, computedStyle),
      };
    });
  }

  function diffAndBroadcastSnapshot() {
    // Before the handshake there's no one to tell; agent-client asks for a
    // fresh snapshot once connected, so nothing is lost by dropping this.
    if (!agentPort) return;
    const full = buildSnapshotNodes();
    const nodesById = new Map(full.map((n) => [n.selector, n]));

    const removed = [...lastNodesById.keys()].filter((id) => !nodesById.has(id));
    const changed = full.filter((node) => {
      const prev = lastNodesById.get(node.selector);
      return !prev || JSON.stringify(prev) !== JSON.stringify(node);
    });

    lastNodesById = nodesById;
    postToAgent({ type: 'snapshot', full, changed, removed });
  }

  // Debounced and reconnected on every iframe load — this is the completion-
  // detection mechanism for agent-initiated actions too: rather than a fixed
  // post-action timeout, the model gets a fresh grounding snapshot once the
  // DOM actually settles, from whatever caused the change (agent action,
  // user click, or async page JS alike).
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounceTimer;
  /** @type {MutationObserver | null} */
  let observer = null;

  function scheduleSnapshot() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(diffAndBroadcastSnapshot, SNAPSHOT_DEBOUNCE_MS);
  }

  function watchIframeMutations() {
    observer?.disconnect();
    const doc = iframe.contentDocument;
    if (!doc) return;
    observer = new MutationObserver(scheduleSnapshot);
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true });
  }

  // Native iframe `load` event, not a postMessage handshake — simpler and
  // reliable precisely because the target is same-origin static pages
  // (docs/demostack-ai-presenter-agent.md §5.2).
  //
  // Runs once per document: `setUpDocument` remembers which one it last set
  // up, so the init-time catch-up below and a later `load` for the same
  // document can't both run it.
  /** @type {Document | null} */
  let setUpDocument = null;

  function handleFrameLoad() {
    const doc = iframe.contentDocument;
    if (doc && doc !== setUpDocument) {
      setUpDocument = doc;
      lastNodesById = new Map(); // a new document has nothing in common with the old diff state
      watchIframeMutations();
      // `navigated` first, so the agent marks a keyframe before this load's
      // snapshot arrives rather than after it (which forced a redundant one).
      postToAgent({ type: 'navigated' });
      diffAndBroadcastSnapshot();
    }

    const path = iframe.contentWindow?.location.pathname;
    loadWaiters.filter((waiter) => waiter.path === path).forEach((waiter) => waiter.settle(true));
  }

  iframe.addEventListener('load', handleFrameLoad);

  // This script runs after the <iframe> is parsed, so the first page's `load`
  // may already have fired (a fast, cached same-origin page): catch up now or
  // that page never gets a MutationObserver. The initial about:blank document
  // is also `complete`, so it's excluded; its real load is still to come.
  const initialDoc = iframe.contentDocument;
  if (initialDoc?.readyState === 'complete' && initialDoc.URL !== 'about:blank') {
    handleFrameLoad();
  }
})();
