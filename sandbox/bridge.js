// Runs on sandbox/index.html (top-level), not inside the iframe; the bridge
// manipulates the iframe's DOM directly since both are same-origin. It talks
// to agent-client over a private MessageChannel: one window.postMessage
// handshake transfers the port, then all traffic stays on it.
(function () {
  // Captured at load, so a script that patches MessagePort.prototype.postMessage
  // later can't read or alter replies (a patch made before load still can;
  // see the residual risks below and docs/adr/0001-private-bridge-channel.md).
  const send = MessagePort.prototype.postMessage;

  const KNOWN_ROUTES = ['home', 'settings'];
  // Absolute, not relative to target-app/ — iframe.src resolves against the
  // parent (sandbox) page's URL, not the iframe's current document.
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

  const iframe = document.getElementById('target-app-frame');

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
  function findByTestId(testId) {
    return iframe.contentDocument?.querySelector(`[data-testid="${testId}"]`) ?? null;
  }

  // Navigations waiting for their page: { path, settle(loaded) }.
  let loadWaiters = [];

  // Resolves true once a document at `path` loads in the frame, or false after
  // NAVIGATION_TIMEOUT_MS. Matched by path, so a load of some other page in
  // the meantime (the viewer clicking a link in the frame) doesn't count as
  // this navigate finishing. A load of the same path from another cause can't
  // be told apart, but it does put the requested page in place all the same.
  function waitForLoadOf(path) {
    return new Promise((resolve) => {
      const waiter = {
        path,
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
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { success: true };
    },
  };

  function isAllowedAction(action) {
    return Object.prototype.hasOwnProperty.call(actions, action);
  }

  // The agent's end of the channel; null until the first valid handshake.
  let agentPort = null;

  function postToAgent(message) {
    if (agentPort) send.call(agentPort, message);
  }

  // Accept the first ds-bridge-connect only: posted by this window itself
  // (not the target-app iframe or any other frame), same origin, carrying
  // exactly one port. After that the listener is removed, so later connects
  // are ignored and nothing else is ever read off `window`.
  function handleConnect(event) {
    if (event.origin !== window.location.origin || event.source !== window) return;
    if (event.data?.type !== 'ds-bridge-connect' || event.ports.length !== 1) return;
    window.removeEventListener('message', handleConnect);
    agentPort = event.ports[0];
    agentPort.onmessage = handleAgentMessage; // starts the port implicitly
  }

  window.addEventListener('message', handleConnect);

  async function runAction({ id, action, args }) {
    if (!isAllowedAction(action)) {
      return { type: 'action-result', id, success: false, error: `Action "${action}" is not allowed` };
    }
    // A throwing action must still reply, or the agent waits out its timeout
    // (docs/code-review-notes.md M3).
    try {
      const result = await actions[action](...(Array.isArray(args) ? args : []));
      return { ...result, type: 'action-result', id };
    } catch (err) {
      return { type: 'action-result', id, success: false, error: err?.message || String(err) };
    }
  }

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
  let lastNodesById = new Map();

  function labelFor(el) {
    return el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60) || el.value || '';
  }

  function isHidden(el, computedStyle) {
    return el.hidden || computedStyle.display === 'none' || computedStyle.visibility === 'hidden';
  }

  function buildSnapshotNodes() {
    const doc = iframe.contentDocument;
    if (!doc) return [];
    const elements = [...doc.querySelectorAll('[data-testid]')].slice(0, MAX_SNAPSHOT_NODES);
    return elements.map((el) => {
      const computedStyle = iframe.contentWindow.getComputedStyle(el);
      return {
        selector: el.getAttribute('data-testid'),
        tag: el.tagName.toLowerCase(),
        label: labelFor(el),
        disabled: !!el.disabled,
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
  let debounceTimer = null;
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
