import { useLiveAgent } from './useLiveAgent.js';

export function AgentApp() {
  const { status, transcript, connect, disconnect } = useLiveAgent();
  const isConnected = status === 'open' || status === 'connecting';

  return (
    <div className="agent-app">
      <button onClick={isConnected ? disconnect : connect}>
        {isConnected ? 'Disconnect' : 'Connect'}
      </button>
      <span className="agent-app__status">{status}</span>
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
