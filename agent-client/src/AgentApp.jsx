import { useEffect, useRef } from "react";
import { useLiveAgent } from "./useLiveAgent.js";
import VolumeMeter from "./VolumeMeter.jsx";
import TranscriptLog from "./TranscriptLog.jsx";
import KnowledgeModal from "./KnowledgeModal.jsx";
import { useToast } from "./Toast.jsx";

const STATUS_LABEL = {
  connecting: "Connecting…",
  ready: "Live",
  reconnecting: "Reconnecting…",
  failed: "Disconnected",
};

export default function AgentApp({ portalContainer }) {
  const volumeMeterRef = useRef(null);
  const { status, transcript, retryNow } = useLiveAgent({ volumeMeterRef });
  const notify = useToast();

  // v1 gap #6, actually fixed this time: a dropped connection surfaces a real toast, not silence.
  useEffect(() => {
    if (status === "failed") notify("Connection lost — tap Reconnect to try again.");
  }, [status, notify]);

  return (
    <div className="ds-card">
      <div className="ds-header">
        <KnowledgeModal onNotify={notify} container={portalContainer} />
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
