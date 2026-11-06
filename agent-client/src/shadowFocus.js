// Focus inside the widget's shadow root (main.jsx). There, document.activeElement
// is the shadow host, never the focused control, and Radix compares
// document.activeElement to find where focus is: its toast's Tab handling
// (FailureToast.jsx) and its dialog's focus trap (KnowledgeModal.jsx) both
// misjudged it. Each asks the node's own tree instead, as here.

/**
 * What has focus in the node's own tree: the shadow root's active element in
 * the widget, the document's outside one.
 * @param {Node} node
 * @returns {Element | null}
 */
export function focusedIn(node) {
  const root = node.getRootNode();
  return root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
}

// What a Tab press can land on, as far as this widget's markup goes: no
// disabled control, no hidden input (the file picker's), no tabindex -1.
const TABBABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not([type="hidden"]):not([hidden]):not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

// Rendered, so Tab can land on it: the browser's own answer where it has one
// (checkVisibility: display none, an unrendered ancestor), else no `hidden`
// on it or an ancestor, which is how this widget's markup hides things.
/** @param {HTMLElement} node */
function isRendered(node) {
  return typeof node.checkVisibility === 'function'
    ? node.checkVisibility()
    : !node.closest('[hidden]');
}

/**
 * The container's Tab stops, in document order; none is an empty list.
 * @param {Element} container
 * @returns {HTMLElement[]}
 */
export function tabStops(container) {
  return [...container.querySelectorAll(TABBABLE)].filter(
    /** @returns {node is HTMLElement} */
    (node) => node instanceof HTMLElement && node.tabIndex >= 0 && isRendered(node),
  );
}
