import { useState, useSyncExternalStore } from 'react';
import { useLiveAgent } from './useLiveAgent.js';
import { KnowledgeModal } from './KnowledgeModal.jsx';
import * as knowledgeStore from './knowledgeStore.js';

// Minimal status wording from the spec's Screens table; the designed card
// (orb, Talk/End, toast) is M7.
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
function micErrorText(error) {
  if (error.name === 'NotAllowedError') {
    return 'Microphone blocked — allow it in the address bar, then press Connect.';
  }
  return `Microphone unavailable: ${error.message || String(error)}`;
}

export function AgentApp({ bridge, portalContainer }) {
  const agent = useLiveAgent(bridge);
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
      <button
        className={`agent-app__knowledge-btn${hasContent ? '' : ' agent-app__knowledge-btn--empty'}`}
        aria-label={`Knowledge files (${fileCount})`}
        onClick={() => setKnowledgeOpen(true)}
      >
        <span aria-hidden="true">📄</span> {fileCount}
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
      <KnowledgeModal open={knowledgeOpen} onOpenChange={setKnowledgeOpen} portalContainer={portalContainer} />
    </div>
  );
}
