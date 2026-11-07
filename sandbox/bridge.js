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
   * `checked` is set for checkboxes and radio buttons only. `value` is set
   * for text inputs, textareas and selects (never a hidden input, a password
   * or a card-number / one-time-code field), cut to 60 characters plus an
   * ellipsis; a select's is its selected option's visible text. `options` is
   * set for selects only: the first 20 options' visible text, each cut the
   * same way. `fill` picks a select's option by that text.
   * @typedef {{ selector: string, tag: string, label: string, disabled: boolean, hidden: boolean, checked?: boolean, value?: string, options?: string[] }} SnapshotNode
   */
  /**
   * The full node list plus its diff against the bridge's previous snapshot.
   * `removed` holds selectors. `omitted` is set only on a page with more
   * elements than the bridge's cap: how many it left out, those furthest from
   * the viewport.
   * @typedef {{ full: SnapshotNode[], changed: SnapshotNode[], removed: string[], omitted?: number }} Snapshot
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
   * bridge -> agent: the reply to the ActionMessage with the same `id`. A
   * success is sent once the page has settled, right after the snapshot of it,
   * so that snapshot belongs to this action; a failure is sent at once.
   * @typedef {{ type: 'action-result', id: string, success: boolean, error?: string }} ActionResultMessage
   */
  /**
   * bridge -> agent: after every load and debounced DOM mutation, before each
   * successful action's result, and on request.
   * @typedef {{ type: 'snapshot', full: SnapshotNode[], changed: SnapshotNode[], removed: string[], omitted?: number }} SnapshotMessage
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

  // Route name -> page path, from target-app/routes.json: the one route list
  // (docs/code-review-notes.md M1), which the server templates into this
  // page's #ds-routes data block and actionTools.js turns into `navigate`'s
  // enum. Absolute paths, not relative to target-app/: iframe.src resolves
  // against the parent (sandbox) page's URL, not the iframe's document.
  const ROUTE_PATHS = readRoutes();

  // Size cap so a larger page can't blow the model's context. Kept at 30 in
  // M6 T5 and again in M9 T6 on the Orders page (139 elements), where 30 nodes
  // made a 3.4 kB keyframe, ~103 B a node: inside the 4 kB budget, with room
  // for a select's options; 40 would not be (docs/metrics/README.md). On a
  // page over the cap the nodes nearest the viewport are kept (pickElements).
  const MAX_SNAPSHOT_NODES = 30;
  // Changes nobody asked for (the viewer's clicks, async page JS) go out once
  // the DOM has been quiet this long.
  const SNAPSHOT_DEBOUNCE_MS = 250;
  // An action's result waits for the page to settle, so its snapshot rides in
  // that action's tool response (#25): settled is no mutation, input or change
  // for SETTLE_QUIET_MS, or SETTLE_CAP_MS of settling, whichever comes first.
  // 100 ms is six frames: a handler's own change, a framework's re-render (a
  // microtask or the next frame) and a few rAF steps after it all land inside
  // it, while a click stays well under the spec's 300 ms round trip. The cap
  // bounds a page that never stops mutating (an animation, a ticking clock);
  // a slower change (a fetch) still goes out on the debounce.
  const SETTLE_QUIET_MS = 100;
  const SETTLE_CAP_MS = 1000;
  // Everything one action waits for (a navigate's load, a link click's new
  // page, the settling) ends by this long after it starts, so the reply beats
  // agent-client's ACTION_TIMEOUT_MS (4000, bridgeChannel.js) with 300 ms to
  // spare: a navigate that never loads gets this bridge's own, specific
  // failure back to the model. Past 4 s the agent side gives up first with a
  // generic timeout, and this bridge's late reply lands on an id nobody waits
  // for. Still more than twice the spec's 1.5 s navigate budget.
  const ACTION_DEADLINE_MS = 3700;

  const frameElement = document.getElementById('target-app-frame');
  // sandbox/index.html puts the frame before this deferred script; without it
  // the bridge can do nothing, so fail loudly here rather than on first use.
  if (!(frameElement instanceof HTMLIFrameElement)) {
    throw new Error('bridge.js: no <iframe id="target-app-frame"> on the page');
  }
  const iframe = frameElement; // narrowed once, for the hoisted functions below

  // Without its routes the bridge can't navigate, and a silent empty list
  // would turn every navigate into "Unknown route": fail loudly at load.
  /** @returns {Map<string, string>} */
  function readRoutes() {
    const fail = (/** @type {string} */ why) => {
      throw new Error(`bridge.js: the #ds-routes block ${why}`);
    };
    const block = document.getElementById('ds-routes');
    if (!block) return fail('is missing');
    /** @type {unknown} */
    let routes;
    try {
      routes = JSON.parse(block.textContent ?? '');
    } catch {
      return fail('is not JSON');
    }
    if (typeof routes !== 'object' || routes === null || Array.isArray(routes)) {
      return fail('is not an object');
    }
    const entries = Object.entries(routes);
    if (entries.length === 0) return fail('lists no routes');
    for (const [name, routePath] of entries) {
      if (typeof routePath !== 'string' || !routePath.startsWith('/target-app/')) {
        return fail(`maps "${name}" to something other than a /target-app/ path`);
      }
    }
    // A Map, so a model-supplied "toString" or "__proto__" is no route.
    return new Map(entries);
  }

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
    // Escaped, so a quote or backslash in the id can't break the selector.
    const selector = `[data-testid="${CSS.escape(testId)}"]`;
    const el = iframe.contentDocument?.querySelector(selector) ?? null;
    return /** @type {HTMLElement | null} */ (el);
  }

  // Actions waiting for a page to load.
  /** @type {{ path: string | null, settle: (loaded: boolean) => void }[]} */
  let loadWaiters = [];

  // Resolves true once a document at `path` (any document, for null) loads in
  // the frame, or false at `deadline` (a performance.now() time). Matched by path, so
  // a load of some other page in the meantime (the viewer clicking a link in
  // the frame) doesn't count as a navigate finishing. A load of the same path
  // from another cause can't be told apart, but it does put the requested
  // page in place all the same.
  /**
   * @param {string | null} path
   * @param {number} deadline
   * @returns {Promise<boolean>}
   */
  function waitForLoadOf(path, deadline) {
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
      const timer = setTimeout(
        () => waiter.settle(false),
        Math.max(0, deadline - performance.now()),
      );
      loadWaiters.push(waiter);
    });
  }

  // Each action takes its deadline (a performance.now() time, ACTION_DEADLINE_MS
  // after it started), then the positional args actionTools.js orders for it.
  /** @type {Record<ActionName, (deadline: number, ...args: string[]) => Promise<ActionResult>>} */
  const actions = {
    async click(_deadline, selector) {
      const el = findByTestId(selector);
      if (!el) return { success: false, error: `No element with data-testid="${selector}"` };
      el.click();
      return { success: true };
    },
    async scroll(_deadline, selector) {
      const el = findByTestId(selector);
      if (!el) return { success: false, error: `No element with data-testid="${selector}"` };
      // Instant, not smooth (M9 T6): the result waits for the page to settle,
      // and on a page over the snapshot cap a scroll changes the snapshot, so
      // a smooth scroll held the reply 0.7–1 s, past the spec's 300 ms round
      // trip, and answering sooner would snapshot the page mid-scroll.
      el.scrollIntoView({ behavior: 'instant', block: 'center' });
      return { success: true };
    },
    async navigate(deadline, route) {
      const routePath = ROUTE_PATHS.get(route);
      if (routePath === undefined) {
        return { success: false, error: `Unknown route "${route}"` };
      }
      const loaded = waitForLoadOf(routePath, deadline);
      iframe.src = routePath;
      // Don't report success until the new document is actually in place, and
      // don't claim it was when it never arrived.
      if (!(await loaded)) {
        // Given up on, so the next action doesn't wait out its own deadline
        // for this dead navigation (pageSettled does the same for a link's).
        navigationInFlight = false;
        return { success: false, error: 'The page did not finish loading.' };
      }
      return { success: true };
    },
    async fill(_deadline, selector, value) {
      const el = findByTestId(selector);
      if (!el) return { success: false, error: `No element with data-testid="${selector}"` };
      // An element with no `value` used to get an expando set and a success
      // reply while nothing visible changed, and a button or checkbox has a
      // `value` that isn't what the user sees: setting it changed nothing
      // visible either. The model should hear the truth.
      if (!isTextControl(el) || !('value' in el)) {
        return { success: false, error: `data-testid="${selector}" is not a text input` };
      }
      // What a user couldn't do, the agent doesn't either: a disabled field
      // (itself, or in a disabled fieldset) or a read-only one is refused.
      if (el.matches(':disabled')) {
        return { success: false, error: `data-testid="${selector}" is disabled` };
      }
      if ('readOnly' in el && el.readOnly === true) {
        return { success: false, error: `data-testid="${selector}" is read-only` };
      }
      const newValue = String(value);
      if (isSelect(el)) {
        // Matched by what the viewer (and the snapshot) sees, then by value.
        // No match must not set `value`: that clears the selection.
        const option = matchOption(el, newValue);
        if (!option) {
          const options = optionTexts(el).join(', ');
          return {
            success: false,
            error: `data-testid="${selector}" has no option "${newValue}"; options: ${options}`,
          };
        }
        // A disabled option (or one in a disabled optgroup) can't be picked.
        if (option.matches(':disabled')) {
          return {
            success: false,
            error: `data-testid="${selector}" has option "${option.text.trim()}", but it is disabled`,
          };
        }
        // The option itself, not `value`: with two options sharing a value,
        // `value` would pick the first, not the one matched by its text.
        // React tracks no select value of its own, so the change event below
        // is all a controlled select needs.
        option.selected = true;
      } else {
        // Refused rather than cut short, so the model never believes it typed
        // text the field dropped. `maxLength` is -1 when there's no limit.
        const limit = 'maxLength' in el && typeof el.maxLength === 'number' ? el.maxLength : -1;
        if (limit >= 0 && newValue.length > limit) {
          return {
            success: false,
            error: `data-testid="${selector}" takes at most ${limit} characters; the value has ${newValue.length}`,
          };
        }
        nativeValueSetter(el).call(el, newValue);
      }
      // Both, bubbling, as a user's edit fires them: a framework listens for
      // `input`, a plain page (or a select's handler) often for `change`.
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
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
    const deadline = performance.now() + ACTION_DEADLINE_MS;
    // An earlier change's debounced snapshot, landing inside this action's
    // settle window, would make its page a keyframe; a success's own snapshot
    // covers that change, and a failure sends it as the debounce would have.
    const earlierChangePending = cancelDebouncedSnapshot();
    // A throwing action must still reply, or the agent waits out its timeout
    // (docs/code-review-notes.md M3).
    try {
      // The agent forwards the model's values unchecked, and the actions take
      // them as they come: a non-string selector matches nothing, a non-string
      // fill value is stringified by the input. Hence the cast, not a check.
      const positional = /** @type {string[]} */ (Array.isArray(args) ? args : []);
      const result = await actions[action](deadline, ...positional);
      // A failure changed nothing, so it answers at once. A success first
      // sends the page as the action left it: the port is ordered, so the
      // agent holds that snapshot before the result reaches it.
      if (result.success) {
        await pageSettled(deadline);
        cancelDebouncedSnapshot(); // this snapshot covers what it would have sent
        diffAndBroadcastSnapshot({ always: true });
      } else if (earlierChangePending) {
        scheduleDebouncedSnapshot();
      }
      return { ...result, type: 'action-result', id };
    } catch (err) {
      if (earlierChangePending) scheduleDebouncedSnapshot();
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
      diffAndBroadcastSnapshot({ always: true });
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
  function isCheckable(el) {
    return 'type' in el && (el.type === 'checkbox' || el.type === 'radio');
  }

  /** @param {Element} el */
  function inputType(el) {
    return el.tagName === 'INPUT' && 'type' in el && typeof el.type === 'string' ? el.type : '';
  }

  // The input types whose `value` is not text the user types or sees in the
  // field: `fill` refuses them and snapshots report no value for them.
  const NON_TEXT_INPUT_TYPES = new Set([
    'checkbox',
    'radio',
    'button',
    'submit',
    'reset',
    'file',
    'image',
    'range',
    'color',
    // Not shown to the user, and often a CSRF token: never filled or reported.
    'hidden',
  ]);
  // Fields whose content is a secret even though the input type is text.
  const SECRET_AUTOCOMPLETE = /^(cc-|one-time-code$|current-password$|new-password$)/;
  // An input whose value is its caption, so it names the button.
  const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset']);
  const MAX_VALUE_LENGTH = 60;
  // A snapshot node's name, whatever its source.
  const MAX_NAME_LENGTH = 60;
  // A select's options listed in a snapshot (and in a failed fill's error).
  const MAX_OPTIONS = 20;

  // What `fill` may type into, and what a snapshot reports a value for.
  /** @param {Element} el */
  function isTextControl(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has(inputType(el));
  }

  // A text control's content, so the model can see what a fill (or the
  // viewer) typed. Never a password's, a card number's or a one-time code's.
  /** @param {Element} el */
  function isSecret(el) {
    const tokens = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
    return inputType(el) === 'password' || tokens.some((token) => SECRET_AUTOCOMPLETE.test(token));
  }

  /** @param {string} text */
  function cut(text) {
    return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
  }

  // The cast, as in findByTestId: the frame's realm makes `instanceof
  // HTMLSelectElement` false, so the tag decides.
  /**
   * @param {Element} el
   * @returns {el is HTMLSelectElement}
   */
  function isSelect(el) {
    return el.tagName === 'SELECT';
  }

  /** @param {HTMLSelectElement} select */
  function optionTexts(select) {
    return [...select.options].slice(0, MAX_OPTIONS).map((option) => cut(option.text.trim()));
  }

  /**
   * The option whose visible text is `wanted` (ignoring case and surrounding
   * space), else the one whose value is.
   * @param {HTMLSelectElement} select
   * @param {string} wanted
   */
  function matchOption(select, wanted) {
    const key = wanted.trim().toLowerCase();
    const options = [...select.options];
    return (
      options.find((option) => option.text.trim().toLowerCase() === key) ??
      options.find((option) => option.value.trim().toLowerCase() === key)
    );
  }

  // The prototype's own `value` setter, from the frame's realm: a framework's
  // controlled input (React) overrides `value` on the instance to track it,
  // and only the native setter gets past that so its listener sees the
  // change (docs/code-review-notes.md M5). Per element type, since each has
  // its own setter.
  /**
   * @param {HTMLElement} el An input or textarea (a select is set through its option).
   * @returns {(this: HTMLElement, value: string) => void}
   */
  function nativeValueSetter(el) {
    const realm = /** @type {Window & typeof globalThis} */ (iframe.contentWindow);
    const type = el.tagName === 'TEXTAREA' ? realm.HTMLTextAreaElement : realm.HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(type.prototype, 'value')?.set;
    // runAction turns the throw into a failure reply.
    if (!setter) throw new Error(`No native value setter for <${el.tagName.toLowerCase()}>`);
    return setter;
  }

  /**
   * A select's value is its selected option's visible text, the text `fill`
   * matches; '' when nothing is selected.
   * @param {Element} el
   * @returns {string | undefined}
   */
  function valueOf(el) {
    if (!isTextControl(el) || isSecret(el)) return undefined;
    if (isSelect(el)) return cut(el.selectedOptions[0]?.text.trim() ?? '');
    return cut('value' in el && typeof el.value === 'string' ? el.value : '');
  }

  // A form control is named by its <label>. A checkbox's `value` is no name
  // (it is "on" by default), and naming the notifications toggle "on" let the
  // model report it as already on without clicking it (the live e2e, M5 T5).
  // A text field's value is its content, reported as `value`, not its name;
  // only a button-like input is named by its value (its caption). The order
  // is the accessible-name spec's: aria-labelledby's text first, then
  // aria-label, the <label>, the content or a button's caption, and last the
  // placeholder, then the title, so a field with only a placeholder isn't
  // named ''. Every source is cut to MAX_NAME_LENGTH (docs/code-review-notes.md,
  // M5 re-review).
  /** @param {Element} el */
  function labelledByText(el) {
    const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    return ids
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
  }

  /** @param {Element} el */
  function labelFor(el) {
    const { labels } = /** @type {{ labels?: NodeListOf<HTMLLabelElement> | null }} */ (el);
    const labelText = labels
      ? [...labels].map((label) => label.textContent?.trim() ?? '').join(' ')
      : '';
    const value =
      BUTTON_INPUT_TYPES.has(inputType(el)) && 'value' in el && typeof el.value === 'string'
        ? el.value
        : '';
    const name =
      labelledByText(el) ||
      el.getAttribute('aria-label') ||
      labelText ||
      el.textContent?.trim() ||
      value ||
      el.getAttribute('placeholder') ||
      el.getAttribute('title') ||
      '';
    return name.slice(0, MAX_NAME_LENGTH);
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

  // How far an element is from the frame's viewport, in px vertically: 0 on
  // screen, Infinity when it isn't rendered (display: none, or in a hidden
  // ancestor), so a hidden element is the first to be left out.
  /**
   * @param {Element} el
   * @param {number} viewportHeight
   */
  function distanceFromViewport(el, viewportHeight) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return Infinity;
    if (rect.bottom < 0) return -rect.bottom;
    if (rect.top > viewportHeight) return rect.top - viewportHeight;
    return 0;
  }

  // The elements a snapshot reports, in page order. Under the cap, all of them.
  // Over it (issue #22: a 60-row table), the MAX_SNAPSHOT_NODES nearest the
  // viewport, on screen first: what the viewer sees is what they ask about,
  // and in page order the cap kept the top of the page whatever was scrolled
  // to, so the rest of a long page could never be reached. The model is told
  // how many were left out (`omitted`), and a scroll brings others in.
  /**
   * @param {Element[]} elements
   * @param {number} viewportHeight
   */
  function pickElements(elements, viewportHeight) {
    if (elements.length <= MAX_SNAPSHOT_NODES) return { picked: elements, omitted: 0 };
    const kept = elements
      .map((el, index) => ({ index, distance: distanceFromViewport(el, viewportHeight) }))
      .sort((a, b) => a.distance - b.distance || a.index - b.index)
      .slice(0, MAX_SNAPSHOT_NODES)
      .map(({ index }) => index)
      .sort((a, b) => a - b);
    return {
      picked: kept.map((index) => elements[index]),
      omitted: elements.length - MAX_SNAPSHOT_NODES,
    };
  }

  /** @returns {{ nodes: SnapshotNode[], omitted: number }} */
  function buildSnapshotNodes() {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) return { nodes: [], omitted: 0 };
    const { picked, omitted } = pickElements(
      [...doc.querySelectorAll('[data-testid]')],
      win.innerHeight,
    );
    const nodes = picked.map((el) => {
      const computedStyle = win.getComputedStyle(el);
      /** @type {SnapshotNode} */
      const node = {
        selector: el.getAttribute('data-testid') ?? '', // always set: the query requires it
        tag: el.tagName.toLowerCase(),
        label: labelFor(el),
        disabled: 'disabled' in el && el.disabled === true,
        hidden: isHidden(el, computedStyle),
      };
      if (isCheckable(el)) node.checked = 'checked' in el && el.checked === true;
      const value = valueOf(el);
      if (value !== undefined) node.value = value;
      if (isSelect(el)) node.options = optionTexts(el);
      return node;
    });
    return { nodes, omitted };
  }

  // Whether the last snapshot left elements out: only then does a scroll
  // change what a snapshot holds, so only then does one send a snapshot.
  let pageOverCap = false;
  let lastOmitted = 0;

  // `always` is for the snapshots someone waits for: an action's settled page
  // (#25: its tool response carries it, changed or not), an explicit
  // request-snapshot and a frame load. A change nobody asked for (the
  // debounce) that leaves the snapshot as it was is dropped instead: on a page
  // over the cap every scroll schedules one, and an empty delta would only
  // cost the model a turn (M9 fix wave, C1).
  /** @param {{ always: boolean }} options */
  function diffAndBroadcastSnapshot({ always }) {
    // Before the handshake there's no one to tell; agent-client asks for a
    // fresh snapshot once connected, so nothing is lost by dropping this.
    if (!agentPort) return;
    const { nodes: full, omitted } = buildSnapshotNodes();
    pageOverCap = omitted > 0;
    const nodesById = new Map(full.map((n) => [n.selector, n]));

    const removed = [...lastNodesById.keys()].filter((id) => !nodesById.has(id));
    const changed = full.filter((node) => {
      const prev = lastNodesById.get(node.selector);
      return !prev || JSON.stringify(prev) !== JSON.stringify(node);
    });
    const unchanged = changed.length === 0 && removed.length === 0 && omitted === lastOmitted;

    lastNodesById = nodesById;
    lastOmitted = omitted;
    if (unchanged && !always) return;
    postToAgent({ type: 'snapshot', full, changed, removed, ...(omitted > 0 ? { omitted } : {}) });
  }

  // Reconnected on every iframe load. Every mutation, input or change both
  // schedules the debounced snapshot (for changes nobody asked for: the
  // viewer's clicks, async page JS) and restarts a running action's quiet
  // window (pageSettled), whose own snapshot then replaces the debounced one.
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounceTimer;
  /** @type {MutationObserver | null} */
  let observer = null;
  // The quiet-window restarts of actions waiting for the page to settle.
  /** @type {Set<() => void>} */
  const settleWaiters = new Set();

  // Set when the frame's document starts to unload (a link click, a form
  // submit, a script setting location, a navigate), cleared by the next load
  // or by an action that gave up waiting for it. A navigation that starts but
  // never commits (a 204, a download, one cancelled) fires beforeunload and
  // no load, so the flag stays set and the next successful action waits out
  // its own deadline once before clearing it. Not reachable on today's target
  // app, which has neither.
  let navigationInFlight = false;

  function scheduleDebouncedSnapshot() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      diffAndBroadcastSnapshot({ always: false });
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  /** @returns {boolean} Whether a debounced snapshot was pending. */
  function cancelDebouncedSnapshot() {
    const pending = debounceTimer !== undefined;
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
    return pending;
  }

  function scheduleSnapshot() {
    scheduleDebouncedSnapshot();
    settleWaiters.forEach((restart) => restart());
  }

  // Resolves once the page an action left has settled, by `deadline` at the
  // latest. When the action started a navigation (a link click), that is the
  // new page: the old document doesn't change, so its quiet window would pass
  // and answer with the page being left (#25 review). A navigation that
  // hasn't loaded by the deadline is given up on, so the next action doesn't
  // wait for it too.
  /** @param {number} deadline */
  async function pageSettled(deadline) {
    for (;;) {
      if (navigationInFlight && !(await waitForLoadOf(null, deadline))) {
        navigationInFlight = false;
      }
      await quietPage(Math.max(0, Math.min(SETTLE_CAP_MS, deadline - performance.now())));
      if (!navigationInFlight || performance.now() >= deadline) return;
    }
  }

  // Resolves once the frame has had no mutation, input or change for
  // SETTLE_QUIET_MS, or `cap` ms from now, whichever comes first.
  /**
   * @param {number} cap
   * @returns {Promise<void>}
   */
  function quietPage(cap) {
    if (cap <= 0) return Promise.resolve(); // out of time: as the page is now
    return new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let quietTimer;
      const restart = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, SETTLE_QUIET_MS);
      };
      const capTimer = setTimeout(done, cap);
      function done() {
        clearTimeout(quietTimer);
        clearTimeout(capTimer);
        settleWaiters.delete(restart);
        resolve();
      }
      settleWaiters.add(restart);
      restart();
    });
  }

  function watchIframeMutations() {
    observer?.disconnect();
    const doc = iframe.contentDocument;
    if (!doc) return;
    observer = new MutationObserver(scheduleSnapshot);
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true });
    // Form state (a checkbox's `checked`, a typed value) changes no attribute,
    // so the observer alone never sees it. The listeners go with the document.
    doc.addEventListener('input', scheduleSnapshot, true);
    doc.addEventListener('change', scheduleSnapshot, true);
    // On a page over the cap, a scroll (the viewer's or a `scroll` action's)
    // changes which elements are nearest the viewport, and an action settles
    // only once the scrolling stops. Captured, so a scrolling container
    // counts too.
    doc.addEventListener(
      'scroll',
      () => {
        if (pageOverCap) scheduleSnapshot();
      },
      true,
    );
    // beforeunload as soon as a navigation starts, pagehide in case it was
    // skipped; both go with the document's window.
    const markNavigating = () => {
      navigationInFlight = true;
    };
    iframe.contentWindow?.addEventListener('beforeunload', markNavigating);
    iframe.contentWindow?.addEventListener('pagehide', markNavigating);
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
      navigationInFlight = false;
      lastNodesById = new Map(); // a new document has nothing in common with the old diff state
      lastOmitted = 0;
      watchIframeMutations();
      // `navigated` first, so the agent marks a keyframe before this load's
      // snapshot arrives rather than after it (which forced a redundant one).
      postToAgent({ type: 'navigated' });
      diffAndBroadcastSnapshot({ always: true });
    }

    const path = iframe.contentWindow?.location.pathname;
    loadWaiters
      .filter((waiter) => waiter.path === null || waiter.path === path)
      .forEach((waiter) => waiter.settle(true));
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
