import { useRef } from "react";
import { useLiveAgent } from "./useLiveAgent.js";
import VolumeMeter from "./VolumeMeter.jsx";
import TranscriptLog from "./TranscriptLog.jsx";

const STATUS_LABEL = {
  connecting: "Connecting…",
  ready: "Live",
  reconnecting: "Reconnecting…",
  failed: "Disconnected",
};

export default function AgentApp() {
  const volumeMeterRef = useRef(null);
  const { status, transcript, retryNow } = useLiveAgent({ volumeMeterRef });

  return (
    <div className="ds-card">
      <div className="ds-header">
        <span className={`ds-status ds-status--${status}`}>{STATUS_LABEL[status] || status}</span>
      </div>
      <VolumeMeter ref={volumeMeterRef} />
      <TranscriptLog entries={transcript} />
      {status === "failed" && (
        <button className="ds-retry" onClick={retryNow}>
          Reconnect
        </button>
      )}
    </div>
  );
}
