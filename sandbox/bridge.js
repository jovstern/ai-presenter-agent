// Runs on sandbox/index.html (top-level), not inside the iframe — one
// postMessage hop between agent-client and this bridge, not two; the bridge
// manipulates the iframe's DOM directly since both are same-origin.
(function () {
  const KNOWN_ROUTES = ['home', 'settings'];
  // Absolute, not relative to target-app/ — iframe.src resolves against the
  // parent (sandbox) page's URL, not the iframe's current document.
  const ROUTE_PATHS = { home: '/target-app/index.html', settings: '/target-app/settings.html' };

  // Size cap so a larger page can't blow the model's context — a guess, not
  // tuned against a real page yet (docs/project-knowledge-handoff.md §3.3).
  const MAX_SNAPSHOT_NODES = 30;
  const SNAPSHOT_DEBOUNCE_MS = 250;
  const NAVIGATION_TIMEOUT_MS = 5000;

  const iframe = document.getElementById('target-app-frame');

  // The action library lives in this closure, never on `window` — a page
  // script reaching `window.dsActions.click(...)` directly would bypass the
  // origin/allowlist checks below entirely (docs/project-knowledge-handoff.md
  // §1.10, the exact v1 gap this is designed around).
  //
  // Session-token binding (docs/demostack-ai-presenter-agent.md §5.2) is
  // deferred to M4/M5: it authenticates a message against a specific live
  // Gemini session, and no session exists yet at this milestone — adding it
  // now would mean validating against nothing real. Only origin + allowlist
  // are enforced here.
  function findByTestId(testId) {
    return iframe.contentDocument?.querySelector(`[data-testid="${testId}"]`) ?? null;
  }

  let pendingLoadResolvers = [];

  function waitForNextLoad() {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, NAVIGATION_TIMEOUT_MS); // fail open, don't hang forever
      pendingLoadResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
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
      const loaded = waitForNextLoad();
      iframe.src = ROUTE_PATHS[route];
      await loaded; // don't report success until the new document is actually in place
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

  function isAllowedOrigin(origin) {
    return origin === window.location.origin;
  }

  function isAllowedAction(action) {
    return Object.prototype.hasOwnProperty.call(actions, action);
  }

  window.addEventListener('message', async (event) => {
    if (!isAllowedOrigin(event.origin)) return;
    const data = event.data;
    if (!data) return;

    if (data.type === 'ds-request-snapshot') {
      diffAndBroadcastSnapshot();
      return;
    }

    if (data.type !== 'ds-action') return;

    if (!isAllowedAction(data.action)) {
      window.postMessage(
        { type: 'ds-action-result', id: data.id, success: false, error: `Action "${data.action}" is not allowed` },
        window.location.origin,
      );
      return;
    }

    const result = await actions[data.action](...(data.args ?? []));
    window.postMessage({ type: 'ds-action-result', id: data.id, ...result }, window.location.origin);
  });

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
    const full = buildSnapshotNodes();
    const nodesById = new Map(full.map((n) => [n.selector, n]));

    const removed = [...lastNodesById.keys()].filter((id) => !nodesById.has(id));
    const changed = full.filter((node) => {
      const prev = lastNodesById.get(node.selector);
      return !prev || JSON.stringify(prev) !== JSON.stringify(node);
    });

    lastNodesById = nodesById;
    window.postMessage({ type: 'ds-dom-snapshot', full, changed, removed }, window.location.origin);
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
  iframe.addEventListener('load', () => {
    lastNodesById = new Map(); // a new document has nothing in common with the old diff state
    watchIframeMutations();
    diffAndBroadcastSnapshot();
    window.postMessage({ type: 'ds-ready' }, window.location.origin);

    const resolvers = pendingLoadResolvers;
    pendingLoadResolvers = [];
    resolvers.forEach((resolve) => resolve());
  });
})();
