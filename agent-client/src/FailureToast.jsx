import { useRef, useState } from 'react';
import * as Toast from '@radix-ui/react-toast';
import { focusedIn } from './shadowFocus.js';

/** @import { KeyboardEvent, FocusEvent, RefObject } from 'react' */

// Long enough to read the reason and reach the action; Radix pauses it while
// the pointer or focus is in the toast. The reason stays in the card after.
const TOAST_DURATION_MS = 8000;

/**
 * The failure toast (spec Screens, R20): a Radix toast, once per failure.
 *
 * Open while there is a failure with a reason, until it closes (its timer,
 * Escape, a swipe, Dismiss or its action); the failure it closed for is
 * remembered, so a re-render never reopens it, while the next failure (a new
 * `failureId`) gets a toast of its own, announced anew. No reason (the card
 * left `failed`) closes it.
 *
 * It is the one live announcement of the reason: Radix's announcer reads the
 * toast's text (the reason, then the action's alt text) once, assertively.
 * The card shows the same reason as plain text for as long as the failure
 * lasts, so a screen reader hears it once.
 *
 * Focus: the toast never takes it. F8 (Radix's hotkey) does, and Tab then
 * walks the toast, its action and Dismiss, and leaves it for the card's
 * primary button either way; a toast that closes with focus inside sends it
 * there too. Radix does those moves by comparing document.activeElement,
 * which inside the widget's shadow root is the host, so its Tab handling
 * skipped out of the toast and its focus proxies landed on Dismiss: the
 * region's capture handlers below do both moves instead.
 *
 * @param {{
 *   failureId: number,
 *   reason: string | undefined,
 *   actionLabel: string,
 *   onAction: () => void,
 *   returnFocusTo: RefObject<HTMLElement | null>,
 *   announcerContainer: HTMLElement | undefined,
 * }} props
 *   `failureId` names the failure (useLiveAgent's failureCount); `actionLabel`
 *   and `onAction` are the card's primary action, which the toast repeats;
 *   `returnFocusTo` is that button; `announcerContainer` keeps Radix's live
 *   region in the shadow root.
 */
export function FailureToast({
  failureId,
  reason,
  actionLabel,
  onAction,
  returnFocusTo,
  announcerContainer,
}) {
  const [closedFor, setClosedFor] = useState(0);
  const open = Boolean(reason) && closedFor !== failureId;
  const regionRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  /** @param {boolean} nextOpen */
  function handleOpenChange(nextOpen) {
    if (nextOpen) return;
    setClosedFor(failureId);
    const region = regionRef.current;
    if (region?.contains(focusedIn(region))) returnFocusTo.current?.focus();
  }

  // The toasts' Tab stops in order: each toast, then its buttons.
  /**
   * @param {HTMLElement} region
   * @returns {HTMLElement[]}
   */
  function tabStops(region) {
    return [...region.querySelectorAll('li.toast')].flatMap((toast) => [
      /** @type {HTMLLIElement} */ (toast),
      ...toast.querySelectorAll('button'),
    ]);
  }

  // Capture phase, so it runs before Radix's own listener on the viewport,
  // which stopPropagation then keeps from running.
  /** @param {KeyboardEvent<HTMLDivElement>} event */
  function handleKeyDownCapture(event) {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const stops = tabStops(event.currentTarget);
    const current = stops.indexOf(/** @type {HTMLElement} */ (focusedIn(event.currentTarget)));
    // Past either end (or backwards from the viewport itself, after F8) is
    // undefined: the card's button.
    const next = stops[event.shiftKey ? current - 1 : current + 1];
    event.preventDefault();
    event.stopPropagation();
    (next ?? returnFocusTo.current)?.focus();
  }

  // Tab from the page reaches one of Radix's two focus proxies around the
  // viewport: it goes to the newest toast instead (Radix's intent), and
  // Radix's own proxy handler doesn't run.
  /** @param {FocusEvent<HTMLDivElement>} event */
  function handleFocusCapture(event) {
    const viewport = event.currentTarget.querySelector('.toast-viewport');
    if (viewport?.contains(/** @type {Node} */ (event.target))) return;
    event.stopPropagation();
    const [newest] = tabStops(event.currentTarget);
    (newest ?? returnFocusTo.current)?.focus();
  }

  return (
    <Toast.Provider duration={TOAST_DURATION_MS} announcerContainer={announcerContainer}>
      {/* Ours, for the two capture handlers. The toast is inside it in the
          React tree (events from a portal travel the React tree), though
          Radix portals its DOM into the viewport. */}
      <div
        ref={regionRef}
        onKeyDownCapture={handleKeyDownCapture}
        onFocusCapture={handleFocusCapture}
      >
        {/* Keyed by the failure, so each one is a new toast. Its alt text is
            what the announcement says in place of the action, for anyone who
            can't reach the toast before it goes. */}
        <Toast.Root key={failureId} className="toast" open={open} onOpenChange={handleOpenChange}>
          <Toast.Title className="toast__title">{reason}</Toast.Title>
          <Toast.Action
            className="toast__action"
            altText={`Use the ${actionLabel} button on the presenter card.`}
            onClick={() => {
              returnFocusTo.current?.focus();
              onAction();
            }}
          >
            {actionLabel}
          </Toast.Action>
          <Toast.Close className="toast__close">
            <span aria-hidden="true">×</span>
            <span className="visually-hidden">Dismiss</span>
          </Toast.Close>
        </Toast.Root>
        {/* Rendered in place, in the shadow root, outside the card's landmark
            (a labelled region of its own, "Notifications (F8)"). styles.css
            puts it above the card, so it never covers the primary button. */}
        <Toast.Viewport className="toast-viewport" />
      </div>
    </Toast.Provider>
  );
}
