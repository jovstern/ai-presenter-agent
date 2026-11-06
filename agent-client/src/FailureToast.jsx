import { useRef } from 'react';
import * as Toast from '@radix-ui/react-toast';
import { focusedIn } from './shadowFocus.js';

/** @import { KeyboardEvent, FocusEvent, RefObject } from 'react' */

// Long enough to read the reason; Radix pauses it while the pointer or focus
// is in the toast. The card shows the reason again once it closes.
const TOAST_DURATION_MS = 8000;

/**
 * The failure toast (spec Screens, R20): a Radix toast, once per failure,
 * with the reason and Dismiss. No action of its own: the card's primary
 * button (Retry, Try again or Reload page) is the one action on screen, and
 * the card hides its own copy of the reason while the toast is open, so the
 * screen holds one reason and one Retry (AgentApp.jsx owns `open`).
 *
 * It is the one live announcement of the reason: Radix's announcer reads the
 * toast's text once, assertively — the reason, then a visually hidden line
 * naming the card's button, for anyone who can't see where to act. The
 * card's copy, shown once the toast has closed, is plain text, so a screen
 * reader hears the reason once.
 *
 * Focus: the toast never takes it. F8 (Radix's hotkey) does, and Tab then
 * walks the toast and Dismiss, and leaves it for the card's primary button
 * either way; a toast that closes with focus inside sends it there too.
 * Radix does those moves by comparing document.activeElement, which inside
 * the widget's shadow root is the host, so its Tab handling skipped out of
 * the toast and its focus proxies landed on Dismiss: the region's capture
 * handlers below do both moves instead.
 *
 * @param {{
 *   failureId: number,
 *   reason: string | undefined,
 *   open: boolean,
 *   onClose: () => void,
 *   actionLabel: string,
 *   returnFocusTo: RefObject<HTMLElement | null>,
 *   announcerContainer: HTMLElement | undefined,
 * }} props
 *   `failureId` names the failure (useLiveAgent's failureCount), a new toast
 *   per failure; `open` and `onClose` are the card's (it closes for good on
 *   its timer, Escape, a swipe or Dismiss); `actionLabel` is the card's
 *   primary button, which the hidden line names; `returnFocusTo` is that
 *   button; `announcerContainer` keeps Radix's live region in the shadow root.
 */
export function FailureToast({
  failureId,
  reason,
  open,
  onClose,
  actionLabel,
  returnFocusTo,
  announcerContainer,
}) {
  const regionRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  /** @param {boolean} nextOpen */
  function handleOpenChange(nextOpen) {
    if (nextOpen) return;
    const region = regionRef.current;
    if (region?.contains(focusedIn(region))) returnFocusTo.current?.focus();
    onClose();
  }

  // The toasts' Tab stops in order: each toast, then its buttons.
  /**
   * @param {HTMLElement} region
   * @returns {HTMLElement[]}
   */
  function toastTabStops(region) {
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
    const stops = toastTabStops(event.currentTarget);
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
    const [newest] = toastTabStops(event.currentTarget);
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
        {/* Keyed by the failure, so each one is a new toast. */}
        <Toast.Root key={failureId} className="toast" open={open} onOpenChange={handleOpenChange}>
          <Toast.Title className="toast__title">{reason}</Toast.Title>
          {/* Read with the reason, not shown: the toast has no button of its
              own to act with, so it says where the action is. */}
          <Toast.Description className="visually-hidden">
            Use the {actionLabel} button on the presenter card.
          </Toast.Description>
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
