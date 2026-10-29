import { useState, useSyncExternalStore } from 'react';
import { useLiveAgent } from './useLiveAgent.js';
import { KnowledgeModal } from './KnowledgeModal.jsx';
import * as knowledgeStore from './knowledgeStore.js';

/** @import { BridgeChannel } from './bridgeChannel.js' */
/** @import { StatusDetails } from './liveSession.js' */
/** @import { AgentStatus, LiveAgent } from './useLiveAgent.js' */

// Minimal status wording from the spec's Screens table; the designed card
// (orb, Talk/End, toast) is M7.
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
      return 'Connection lost';
    default: // idle, closed
      return 'Not connected';
  }
}

// One primary button whose job follows the status. It is never disabled: a
// disabled button drops keyboard focus, and the viewer should always be able
// to hang up, including during a reconnect's backoff. A fatal failure (the
// page's token is rejected, or the server is misconfigured) can't be fixed by
// Retry, so it offers a reload instead.
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
      return details?.fatal
        ? { label: 'Reload page', onClick: () => location.reload() }
        : { label: 'Retry', onClick: retry };
    default: // idle, closed
      return { label: 'Connect', onClick: connect };
  }
}

// getUserMedia rejects with NotAllowedError when the permission is blocked,
// which the viewer can fix; anything else (no device, device busy) can't be
// fixed from here, so it is reported as it is.
/** @param {Error} error */
function micErrorText(error) {
  if (error.name === 'NotAllowedError') {
    return 'Microphone blocked — allow it in the address bar, then press Connect.';
  }
  return `Microphone unavailable: ${error.message || String(error)}`;
}

/**
 * @param {{ bridge: BridgeChannel, nonce: string, portalContainer: HTMLElement }} props
 *   `nonce` is the page nonce for the token request; `portalContainer` keeps
 *   Radix portals inside the shadow root (both from main.jsx).
 */
export function AgentApp({ bridge, nonce, portalContainer }) {
  const agent = useLiveAgent(bridge, nonce);
  const { status, details, transcript, micError } = agent;
  const action = primaryAction(status, details, agent);

  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  // Read straight from the store rather than mirroring it into local state —
  // knowledgeStore.subscribe/fileCount/hasContent are the source of truth.
  const fileCount = useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.fileCount);
  const hasContent = useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.hasContent);

  return (
    <div className="agent-app">
      <button onClick={action.onClick}>{action.label}</button>
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
          session and asks the user to act (Retry or Reload page), so it should be
          announced at once rather than queued politely like progress text. */}
      {status === 'failed' && details?.reason && (
        <div className="agent-app__error" role="alert">
          {details.reason}
        </div>
      )}
      {micError && (
        <div className="agent-app__mic-error" role="alert">
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
    </div>
  );
}
