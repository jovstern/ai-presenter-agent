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

// One primary button whose job follows the status. While `reconnecting` the
// session is already retrying on its own, so the button is shown as Retry but
// disabled until the retries either succeed or run out.
function primaryAction(status, { connect, disconnect, retry }) {
  switch (status) {
    case 'connecting':
    case 'open':
      return { label: 'Disconnect', onClick: disconnect, disabled: false };
    case 'reconnecting':
      return { label: 'Retry', onClick: retry, disabled: true };
    case 'failed':
      return { label: 'Retry', onClick: retry, disabled: false };
    default: // idle, closed
      return { label: 'Connect', onClick: connect, disabled: false };
  }
}

export function AgentApp({ bridge, portalContainer }) {
  const agent = useLiveAgent(bridge);
  const { status, details, transcript, micError } = agent;
  const action = primaryAction(status, agent);

  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  // Read straight from the store rather than mirroring it into local state —
  // knowledgeStore.subscribe/fileCount/hasContent are the source of truth.
  const fileCount = useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.fileCount);
  const hasContent = useSyncExternalStore(knowledgeStore.subscribe, knowledgeStore.hasContent);

  return (
    <div className="agent-app">
      <button onClick={action.onClick} disabled={action.disabled}>
        {action.label}
      </button>
      <button
        className={`agent-app__knowledge-btn${hasContent ? '' : ' agent-app__knowledge-btn--empty'}`}
        onClick={() => setKnowledgeOpen(true)}
      >
        📄 {fileCount}
      </button>
      <span className="agent-app__status" role="status">
        {statusText(status, details)}
      </span>
      {/* role="alert", not "status": the reason is an error that ends the
          session and asks the user to act (Retry or reload), so it should be
          announced at once rather than queued politely like progress text. */}
      {status === 'failed' && details?.reason && (
        <div className="agent-app__error" role="alert">
          {details.reason}
        </div>
      )}
      {micError && <div className="agent-app__mic-error">Mic error: {micError}</div>}
      <ul className="agent-app__transcript">
        {transcript.map((entry, i) => (
          <li key={i} className={`agent-app__line agent-app__line--${entry.role}`}>
            {entry.text}
          </li>
        ))}
      </ul>
      <KnowledgeModal open={knowledgeOpen} onOpenChange={setKnowledgeOpen} portalContainer={portalContainer} />
    </div>
  );
}
