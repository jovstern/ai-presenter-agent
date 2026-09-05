import { forwardRef, useImperativeHandle, useRef, memo } from "react";

/**
 * The v2 "go further" version of the v1 render-storm fix: the volume value never touches React
 * state. It's set imperatively via the exposed `setVolume` ref method, straight onto each bar's
 * inline style, driven by the caller's own rAF/audio-callback loop. This component re-renders
 * exactly once (mount) no matter how many times a second setVolume is called — verified by
 * agent-client/src/__tests__/renderIsolation.test.jsx.
 */
const VolumeMeter = forwardRef(function VolumeMeter(_props, ref) {
  const barRefs = [useRef(null), useRef(null), useRef(null)];

  useImperativeHandle(ref, () => ({
    setVolume(v) {
      const clamped = Math.max(0, Math.min(1, v));
      const heights = [
        6 + clamped * 26 * (0.3 + Math.random() * 0.4),
        6 + clamped * 26,
        6 + clamped * 26 * (0.3 + Math.random() * 0.4),
      ];
      barRefs.forEach((r, i) => {
        if (r.current) r.current.style.height = `${heights[i]}px`;
      });
    },
  }));

  return (
    <div className="ds-volume-meter" aria-hidden="true">
      {barRefs.map((r, i) => (
        <span key={i} ref={r} className="ds-volume-bar" />
      ))}
    </div>
  );
});

export default memo(VolumeMeter);
