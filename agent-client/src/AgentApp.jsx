import { useLiveAgent } from './useLiveAgent.js';

export function AgentApp() {
  const { status, transcript, micError, connect, disconnect } = useLiveAgent();
  const isConnected = status === 'open' || status === 'connecting';

  return (
    <div className="agent-app">
      <button onClick={isConnected ? disconnect : connect}>
        {isConnected ? 'Disconnect' : 'Connect'}
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
    </div>
  );
}
