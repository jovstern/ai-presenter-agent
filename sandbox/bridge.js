// Runs on sandbox/index.html (top-level), not inside the iframe — one
// postMessage hop between agent-client and this bridge, not two; the bridge
// manipulates the iframe's DOM directly since both are same-origin.
(function () {
  const KNOWN_ROUTES = ['home', 'settings'];
  // Absolute, not relative to target-app/ — iframe.src resolves against the
  // parent (sandbox) page's URL, not the iframe's current document.
  const ROUTE_PATHS = { home: '/target-app/index.html', settings: '/target-app/settings.html' };

  const iframe = document.getElementById('target-app-frame');

  // The action library lives in this closure, never on `window` — a page
  // script reaching `window.dsActions.click(...)` directly would bypass the
  // origin/allowlist checks below entirely (docs/project-knowledge-handoff.md
  // §1.10, the exact v1 gap this is designed around).
  //
  // Session-token binding (docs/demostack-ai-presenter-agent.md §5.2) is
  // deferred to M4: it authenticates a message against a specific live
  // Gemini session, and no session exists yet at this milestone — adding it
  // now would mean validating against nothing real. Only origin + allowlist
  // are enforced here.
  function findByTestId(testId) {
    return iframe.contentDocument?.querySelector(`[data-testid="${testId}"]`) ?? null;
  }

  const actions = {
    click(selector) {
      const el = findByTestId(selector);
      if (!el) return { success: false, error: `No element with data-testid="${selector}"` };
      el.click();
      return { success: true };
    },
    scroll(selector) {
      const el = findByTestId(selector);
      if (!el) return { success: false, error: `No element with data-testid="${selector}"` };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { success: true };
    },
    navigate(route) {
      if (!KNOWN_ROUTES.includes(route)) {
        return { success: false, error: `Unknown route "${route}"` };
      }
      iframe.src = ROUTE_PATHS[route];
      return { success: true };
    },
    fill(selector, value) {
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

  window.addEventListener('message', (event) => {
    if (!isAllowedOrigin(event.origin)) return;
    const data = event.data;
    if (!data || data.type !== 'ds-action') return;

    if (!isAllowedAction(data.action)) {
      window.postMessage(
        { type: 'ds-action-result', id: data.id, success: false, error: `Action "${data.action}" is not allowed` },
        window.location.origin,
      );
      return;
    }

    const result = actions[data.action](...(data.args ?? []));
    window.postMessage({ type: 'ds-action-result', id: data.id, ...result }, window.location.origin);
  });

  // Native iframe `load` event, not a postMessage handshake — simpler and
  // reliable precisely because the target is same-origin static pages
  // (docs/demostack-ai-presenter-agent.md §5.2).
  iframe.addEventListener('load', () => {
    window.postMessage({ type: 'ds-ready' }, window.location.origin);
  });
})();
