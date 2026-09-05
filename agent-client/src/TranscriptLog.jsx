import { memo } from "react";

function TranscriptLog({ entries }) {
  return (
    <div className="ds-transcript">
      {entries.slice(-4).map((e) => (
        <p key={e.id} className={`ds-line ds-line--${e.role}`}>
          {e.text}
        </p>
      ))}
    </div>
  );
}

export default memo(TranscriptLog);
