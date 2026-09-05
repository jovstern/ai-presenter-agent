/**
 * Sandbox bridge — the "hands" of the Presenter Agent simulation.
 *
 * This script owns:
 *   - the session token (generated here, handed to the agent-client via a data-* attribute)
 *   - the reduced DOM snapshot of the iframe (grounding, no screenshots)
 *   - the action library (click/navigate/scroll/fill) — kept in this closure, NEVER on `window`
 *   - validation of every inbound message before it's allowed to do anything
 *
 * It talks to the agent-client (a separately-built bundle, mounted in a shadow root elsewhere in
 * this same document) purely via window.postMessage — see docs/sandbox-simulation.md §4 for why
 * that's a deliberate choice here, not a same-origin-policy requirement.
 */
(function () {
  "use strict";

  const KNOWN_ROUTES = ["index.html", "settings.html"];
  const ALLOWED_ACTIONS = ["click", "navigate", "scroll", "fill"];
  const MAX_SNAPSHOT_NODES = 30;
  const SELF_ORIGIN = window.location.origin;

  const iframe = document.getElementById("ds-target-iframe");
  const agentEl = document.getElementById("ds-agent");

  // --- session token: minted here, not by a backend, since this build has no agent-creation
  // pipeline. In the full product this arrives from the server alongside the demo's agent
  // binding; here the sandbox stands in for that and hands it to the agent-client via a
  // data-* attribute, the same channel the real system used for its token.
  const sessionToken = crypto.randomUUID();
  agentEl.setAttribute("data-session-token", sessionToken);

  let lastSnapshotBySelector = new Map();

  function post(message) {
    window.postMessage(
      Object.assign({ source: "ds-sandbox-bridge" }, message),
      SELF_ORIGIN
    );
  }

  // --- DOM snapshot -------------------------------------------------------

  function computeSelector(el) {
    const testId = el.getAttribute("data-testid");
    return testId ? `[data-testid="${testId}"]` : null;
  }

  function labelFor(el) {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.textContent.trim().slice(0, 60) ||
      el.tagName.toLowerCase()
    );
  }

  function buildSnapshot() {
    const doc = iframe.contentDocument;
    if (!doc) return [];
    const nodes = Array.from(
      doc.querySelectorAll("[data-testid]")
    ).slice(0, MAX_SNAPSHOT_NODES);

    return nodes
      .map((el) => {
        const selector = computeSelector(el);
        if (!selector) return null;
        return {
          selector,
          role: el.tagName.toLowerCase(),
          label: labelFor(el),
          disabled: !!el.disabled,
        };
      })
      .filter(Boolean);
  }

  function diffAndSendSnapshot() {
    const full = buildSnapshot();
    const nextBySelector = new Map(full.map((n) => [n.selector, n]));

    const changed = full.filter((n) => {
      const prev = lastSnapshotBySelector.get(n.selector);
      return !prev || prev.label !== n.label || prev.disabled !== n.disabled;
    });
    const removed = Array.from(lastSnapshotBySelector.keys()).filter(
      (sel) => !nextBySelector.has(sel)
    );

    lastSnapshotBySelector = nextBySelector;

    if (changed.length === 0 && removed.length === 0) return;

    post({
      type: "ds-dom-snapshot",
      page: iframe.contentWindow.location.pathname.split("/").pop(),
      changed,
      removed,
      full, // small pages here — sending the full set too keeps the agent-client simple
    });
  }

  // --- readiness -----------------------------------------------------------
  // Native `load` event is enough here because the target-app is plain static pages with real
  // navigation, not a client-side-routed SPA. See docs/sandbox-simulation.md §3 for what changes
  // if that's ever not true.

  function handleIframeLoad() {
    diffAndSendSnapshot();
    post({ type: "ds-ready" });
  }

  if (iframe.contentDocument && iframe.contentDocument.readyState === "complete") {
    handleIframeLoad();
  }
  iframe.addEventListener("load", handleIframeLoad);

  // --- action library (closure-scoped — never assigned to `window`) --------

  function resolveElement(selector) {
    const doc = iframe.contentDocument;
    if (!doc) return null;
    return doc.querySelector(selector);
  }

  const actions = {
    click(args) {
      const el = resolveElement(args.selector);
      if (!el) return { success: false, detail: `no element for ${args.selector}` };
      el.click();
      return { success: true };
    },
    fill(args) {
      const el = resolveElement(args.selector);
      if (!el) return { success: false, detail: `no element for ${args.selector}` };
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(el, args.value ?? "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { success: true };
    },
    scroll(args) {
      const el = args.selector ? resolveElement(args.selector) : null;
      if (args.selector && !el) {
        return { success: false, detail: `no element for ${args.selector}` };
      }
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        iframe.contentWindow.scrollTo({
          top: args.y ?? 0,
          left: args.x ?? 0,
          behavior: "smooth",
        });
      }
      return { success: true };
    },
    navigate(args) {
      if (!KNOWN_ROUTES.includes(args.page)) {
        return {
          success: false,
          detail: `"${args.page}" is not a known route (${KNOWN_ROUTES.join(", ")})`,
        };
      }
      iframe.src = `/target-app/${args.page}`;
      return { success: true };
    },
  };

  // --- inbound message validation ------------------------------------------

  window.addEventListener("message", (event) => {
    if (event.origin !== SELF_ORIGIN) return; // reject: wrong origin
    const data = event.data;
    if (!data || data.source !== "ds-agent-client" || data.type !== "ds-action") return;
    if (data.sessionToken !== sessionToken) {
      console.warn("[bridge] rejected action: bad session token", data);
      return;
    }
    if (!ALLOWED_ACTIONS.includes(data.action)) {
      console.warn("[bridge] rejected action: not on allowlist", data.action);
      return;
    }

    const handler = actions[data.action]; // safe: data.action was just checked against the allowlist
    const result = handler(data.args || {});

    post({ type: "ds-action-result", id: data.id, ...result });

    // A successful nav/click/fill can change what's on screen — refresh the snapshot shortly
    // after, once the DOM has had a chance to settle.
    setTimeout(diffAndSendSnapshot, 150);
  });
})();
