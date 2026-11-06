import { useRef, useState } from 'react';
import { useLiveAgent } from './useLiveAgent.js';
import { KnowledgeModal } from './KnowledgeModal.jsx';
import { FailureToast } from './FailureToast.jsx';
import { VolumeOrb } from './VolumeOrb.jsx';
import { Transcript } from './Transcript.jsx';

/** @import { BridgeChannel } from './bridgeChannel.js' */
/** @import { StatusDetails } from './liveSession.js' */
/** @import { AgentStatus, LiveAgent } from './useLiveAgent.js' */

// The status line's wording, from the spec's Screens table.
/**
 * @param {AgentStatus} status
 * @param {StatusDetails | null} details
 */
function statusText(status, details) {
  switch (status) {
    case 'connecting':
      return 'Connecting…';
    case 'open':
      return 'Live';
    case 'reconnecting':
      return `Reconnecting (attempt ${details?.attempt} of ${details?.maxAttempts})…`;
    case 'failed':
      // A fatal failure never had a connection to lose.
      return details?.fatal ? "Can't connect" : 'Connection lost';
    default: // idle, closed
      return 'Not connected';
  }
}

// One primary button whose job follows the status (spec Screens: Talk / End).
// It is never disabled: a disabled button drops keyboard focus, and the
// viewer should always be able to hang up, including during a reconnect's
// backoff; while connecting it is a pending Cancel. A fatal failure isn't
// retried by the backoff, and its button says what can fix it: a rejected
// page token (`token`) needs a reload, which brings a fresh nonce; a server
// with no key (`config`) can't be fixed by a reload, so Try again asks the
// server again — it connects once the owner has fixed the key, without
// losing the page (M6 T6, M4 re-review). Unless fixing the key restarted the
// server: that wipes its in-memory nonces, the retry comes back a rejected
// `token`, and the button becomes Reload page (the reason warns of it).
/**
 * @param {AgentStatus} status
 * @param {StatusDetails | null} details
 * @param {Pick<LiveAgent, 'connect' | 'disconnect' | 'retry'>} agent
 * @returns {{ label: string, onClick: () => void }}
 */
function primaryAction(status, details, { connect, disconnect, retry }) {
  switch (status) {
    case 'connecting':
      return { label: 'Cancel', onClick: disconnect };
    case 'open':
    case 'reconnecting':
      return { label: 'End', onClick: disconnect };
    case 'failed':
      if (details?.fatal === 'token') {
        return { label: 'Reload page', onClick: () => location.reload() };
      }
      return { label: details?.fatal === 'config' ? 'Try again' : 'Retry', onClick: retry };
    default: // idle, closed
      return { label: 'Talk to the presenter', onClick: connect };
  }
}

// getUserMedia rejects with NotAllowedError when the permission is blocked,
// and NotFoundError when there is no mic, both of which the viewer can fix.
// The two voiceSupportError() names, WorkletLoadError and
// AudioResumeTimeoutError (audioIO.js) say what would fix them. Anything else
// (a busy device) can't be fixed from here, so it is reported as it is.
/** @param {Error} error */
function micErrorText(error) {
  if (error.name === 'NotAllowedError') {
    return 'Microphone blocked — allow it in the address bar and press Talk to the presenter.';
  }
  if (error.name === 'InsecureContextError') {
    return 'Voice needs a secure connection (https). Open this page over https, or on localhost.';
  }
  if (error.name === 'AudioUnsupportedError') {
    return "This browser can't capture voice. Use a current Chrome, Edge, Firefox or Safari.";
  }
  // audioIO.js's own name for the capture worklet failing to load: nothing
  // the viewer did, and a reload fetches the file again.
  if (error.name === 'WorkletLoadError') {
    return "Voice couldn't start. Reload the page, then press Talk to the presenter.";
  }
  // audioIO.js's own name for a resume() that never settled (Safari): another
  // press is a fresh user activation, which may let the context start.
  if (error.name === 'AudioResumeTimeoutError') {
    return "Voice couldn't start: the browser kept audio paused. Press Talk to the presenter to try again.";
  }
  if (error.name === 'NotFoundError') {
    return 'No microphone found. Connect one, then press Talk to the presenter.';
  }
  return `Microphone unavailable: ${error.message || String(error)}`;
}

/**
 * @param {{ bridge: BridgeChannel, nonce: string, workletUrl: string, portalContainer: HTMLElement,
 *   onFailure?: (details: StatusDetails) => void }} props
 *   `nonce` is the page nonce for the token request; `workletUrl` is where the
 *   capture worklet is served; `portalContainer` keeps Radix portals (the
 *   dialog, the toast's announcer) inside the shadow root; `onFailure` reports
 *   each connection failure to the client log (all from main.jsx).
 */
export function AgentApp({ bridge, nonce, workletUrl, portalContainer, onFailure }) {
  const agent = useLiveAgent(bridge, nonce, workletUrl, onFailure);
  const { status, details, transcript, micError, connectCount, failureCount } = agent;
  const { outputLevel, micLevel } = agent;
  const action = primaryAction(status, details, agent);
  const primaryRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);

  const failureReason = status === 'failed' ? details?.reason : undefined;
  // The failure whose toast has closed: the toast is open for each new
  // failure (failureCount) with a reason until then, and the card shows the
  // reason itself only once it has closed — one reason on screen, one Retry.
  const [toastClosedFor, setToastClosedFor] = useState(0);
  const toastOpen = Boolean(failureReason) && toastClosedFor !== failureCount;

  return (
    // Inert while the knowledge dialog is open: the dialog is modal, but
    // Radix hides the rest of the page with aria-hidden on document.body's
    // children (hideOthers), which never reaches into this shadow root, so a
    // screen reader's browse mode could still walk the card and the toast
    // behind the dialog. The dialog itself is portalled outside this element
    // (main.jsx), and `inert` is dropped in the same commit that closes it,
    // before Radix returns focus to the knowledge button inside.
    <div inert={knowledgeOpen}>
      {/* A named landmark: the transcript and the alerts sit outside the host
          page's <main>, and axe's `region` rule wants all content in one. */}
      <aside className="agent-app" aria-label="AI presenter">
        {/* First, above the controls, in a box of fixed height from the press
            that starts a session: new lines never move the card (Transcript.jsx). */}
        <Transcript
          entries={transcript}
          reserve={status === 'connecting' || status === 'open' || status === 'reconnecting'}
        />
        {/* Animates outside React: its frames render nothing, and a card render
            (a transcript line) skips it, since its props are unchanged (VolumeOrb.jsx). */}
        <VolumeOrb active={status === 'open'} outputLevel={outputLevel} micLevel={micLevel} />
        {/* Pending while connecting: a spinner, and the label says what a
            press does now (Cancel). The status line says Connecting…. */}
        <button
          ref={primaryRef}
          className="agent-app__primary"
          data-pending={status === 'connecting' ? 'true' : undefined}
          onClick={action.onClick}
        >
          {action.label}
        </button>
        {/* The knowledge button, which opens the dialog (portalled into the
            shadow root) and takes focus back when it closes. */}
        <KnowledgeModal
          portalContainer={portalContainer}
          open={knowledgeOpen}
          onOpenChange={setKnowledgeOpen}
        />
        <span className="agent-app__status" role="status" data-status={status}>
          {statusText(status, details)}
        </span>
        {/* The failure's reason, for as long as the failure lasts. While the
            toast is open it says the reason, so the card's copy is held: its
            space kept (styles.css hides it), so Retry doesn't move when the
            toast closes, and hidden from assistive technology too. Plain
            text: the toast is what announces it, once, so a role="alert"
            here would make a screen reader say it twice. */}
        {failureReason && (
          <p
            className="agent-app__error"
            data-held={toastOpen ? 'true' : undefined}
            aria-hidden={toastOpen ? true : undefined}
          >
            {failureReason}
          </p>
        )}
        {/* role="alert", not "status": the guidance asks the user to act, so
            it is announced at once. There is no toast for these: they aren't
            a connection failing but something on this side to fix first.
            Keyed by the connect attempt: the same message after another
            press is a new node, so it is announced again. */}
        {micError && (
          <div key={connectCount} className="agent-app__mic-error" role="alert">
            {micErrorText(micError)}
          </div>
        )}
      </aside>
      <FailureToast
        failureId={failureCount}
        reason={failureReason}
        open={toastOpen}
        onClose={() => setToastClosedFor(failureCount)}
        actionLabel={action.label}
        returnFocusTo={primaryRef}
        announcerContainer={portalContainer}
      />
    </div>
  );
}
