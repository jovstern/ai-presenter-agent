import { useEffect, useState } from 'react';
import { useLiveAgent } from './useLiveAgent.js';
import { KnowledgeModal } from './KnowledgeModal.jsx';
import * as knowledgeStore from './knowledgeStore.js';

export function AgentApp({ portalContainer }) {
  const { status, transcript, micError, connect, disconnect } = useLiveAgent();
  const isConnected = status === 'open' || status === 'connecting';

  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [fileCount, setFileCount] = useState(() => knowledgeStore.listFiles().length);
  const [hasContent, setHasContent] = useState(() => knowledgeStore.hasContent());

  useEffect(() => {
    function refresh() {
      setFileCount(knowledgeStore.listFiles().length);
      setHasContent(knowledgeStore.hasContent());
    }
    window.addEventListener(knowledgeStore.CHANGE_EVENT, refresh);
    return () => window.removeEventListener(knowledgeStore.CHANGE_EVENT, refresh);
  }, []);

  return (
    <div className="agent-app">
      <button onClick={isConnected ? disconnect : connect}>
        {isConnected ? 'Disconnect' : 'Connect'}
      </button>
      <button
        className={`agent-app__knowledge-btn${hasContent ? '' : ' agent-app__knowledge-btn--empty'}`}
        onClick={() => setKnowledgeOpen(true)}
      >
        📄 {fileCount}
      </button>
      <span className="agent-app__status">{status}</span>
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
