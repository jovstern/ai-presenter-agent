import { useState, useSyncExternalStore } from 'react';
import { useLiveAgent } from './useLiveAgent.js';
import { KnowledgeModal } from './KnowledgeModal.jsx';
import { VolumeOrb } from './VolumeOrb.jsx';
import * as knowledgeStore from './knowledgeStore.js';

/** @import { BridgeChannel } from './bridgeChannel.js' */
/** @import { StatusDetails } from './liveSession.js' */
/** @import { AgentStatus, LiveAgent } from './useLiveAgent.js' */

// Minimal status wording from the spec's Screens table; the rest of the
// designed card (Talk/End, toast) is M7 T4.
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

// One primary button whose job follows the status. It is never disabled: a
// disabled button drops keyboard focus, and the viewer should always be able
// to hang up, including during a reconnect's backoff. A fatal failure isn't
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
      return { label: 'Disconnect', onClick: disconnect };
    case 'failed':
      if (details?.fatal === 'token') {
        return { label: 'Reload page', onClick: () => location.reload() };
      }
      return { label: details?.fatal === 'config' ? 'Try again' : 'Retry', onClick: retry };
    default: // idle, closed
      return { label: 'Connect', onClick: connect };
  }
}

// getUserMedia rejects with NotAllowedError when the permission is blocked,
// and NotFoundError when there is no mic, both of which the viewer can fix.
// The two voiceSupportError() names and WorkletLoadError (audioIO.js) say
// what would fix them. Anything else (a busy device) can't be fixed from
// here, so it is reported as it is.
/** @param {Error} error */
function micErrorText(error) {
  if (error.name === 'NotAllowedError') {
    return 'Microphone blocked — allow it in the address bar, then press Connect.';
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
    return "Voice couldn't start. Reload the page, then press Connect.";
  }
  if (error.name === 'NotFoundError') {
    return 'No microphone found. Connect one, then press Connect.';
  }
  return `Microphone unavailable: ${error.message || String(error)}`;
}

/**
 * @param {{ bridge: BridgeChannel, nonce: string, workletUrl: string, portalContainer: HTMLElement }} props
 *   `nonce` is the page nonce for the token request; `workletUrl` is where the
 *   capture worklet is served; `portalContainer` keeps
 *   Radix portals inside the shadow root (both from main.jsx).
 */
export function AgentApp({ bridge, nonce, workletUrl, portalContainer }) {
  const agent = useLiveAgent(bridge, nonce, workletUrl);
  const { status, details, transcript, micError, connectCount, outputLevel, micLevel } = agent;
  const action = primaryAction(status, details, agent);

  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  // Read straight from the store rather than mirroring it into local state —
  // knowledgeStore.subscribe/fileCount/hasContent are the source of truth.
  const fileCount = useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.fileCount);
  const hasContent = useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.hasContent);

  return (
    // A named landmark: the transcript and the alerts sit outside the host
    // page's <main>, and axe's `region` rule wants all content in one.
    <aside className="agent-app" aria-label="AI presenter">
      {/* Animates outside React: its frames render nothing, and a card render
          (a transcript line) skips it, since its props are unchanged (VolumeOrb.jsx). */}
      <VolumeOrb active={status === 'open'} outputLevel={outputLevel} micLevel={micLevel} />
      <button className="agent-app__primary" onClick={action.onClick}>
        {action.label}
      </button>
      {/* Named by its content, not an aria-label: the visible count has to be
          part of the accessible name (WCAG 2.5.3, axe label-content-name-mismatch),
          and the emoji is decoration. The name reads "Knowledge files: 0". */}
      <button
        className={`agent-app__knowledge-btn${hasContent ? '' : ' agent-app__knowledge-btn--empty'}`}
        onClick={() => setKnowledgeOpen(true)}
      >
        <span aria-hidden="true">📄</span> <span className="visually-hidden">Knowledge files:</span>{' '}
        {fileCount}
      </button>
      <span className="agent-app__status" role="status">
        {statusText(status, details)}
      </span>
      {/* role="alert", not "status": the reason is an error that ends the
          session and asks the user to act (Retry, Try again or Reload page), so it should be
          announced at once rather than queued politely like progress text.
          Keyed by the connect attempt: the same reason after Try again is a new
          node, so it is announced again. */}
      {status === 'failed' && details?.reason && (
        <div key={connectCount} className="agent-app__error" role="alert">
          {details.reason}
        </div>
      )}
      {micError && (
        <div key={connectCount} className="agent-app__mic-error" role="alert">
          {micErrorText(micError)}
        </div>
      )}
      {transcript.length > 0 && (
        <ul className="agent-app__transcript">
          {transcript.map((entry, i) => (
            <li key={i} className={`agent-app__line agent-app__line--${entry.role}`}>
              {entry.text}
            </li>
          ))}
        </ul>
      )}
      <KnowledgeModal
        open={knowledgeOpen}
        onOpenChange={setKnowledgeOpen}
        portalContainer={portalContainer}
      />
    </aside>
  );
}
