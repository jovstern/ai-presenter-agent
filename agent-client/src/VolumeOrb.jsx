import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from 'react';

// The card's volume orb (spec Screens; goals #8 and #9). Two rings around a
// core: the outer follows the agent's voice (`--level`), the inner the mic
// (`--mic-level`); styles.css turns the two variables into scale and opacity.
//
// Render isolation: the levels are pulled from their sources once per
// animation frame and written straight to this element's style, so a frame
// renders nothing in React (renderIsolation.test.jsx). They live in the
// loop's own variables, never in state; the element is held in a ref
// (docs/code-review-notes.md L2, L8; handoff §4).
//
// The loop runs only while the session is open and the viewer has not asked
// for reduced motion: idle, a hang-up, an unmount or a change of preference
// cancels the pending frame. Without the loop the variables are removed, and
// styles.css shows the orb at rest (or, live under reduced motion, a static
// level). While the session reconnects, the loop is off and styles.css
// pulses the halo slowly instead (data-reconnecting; CSS only, none under
// reduced motion), so the orb shows something is still happening. Decorative: hidden from assistive technology, since the card's
// status line says the same thing in words (L2).

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
// A rising level shows at once; a falling one keeps this share of the last
// frame's (at 60 fps, half in about 70 ms and a tenth in about 240 ms), so the
// rings ease down between syllables, and across the mic's 80 ms frames,
// instead of flickering.
const FALL_OFF = 0.85;

/** @param {() => void} onChange */
function subscribeToReducedMotion(onChange) {
  // An old browser (or jsdom) without matchMedia: no preference to follow.
  const query = window.matchMedia?.(REDUCED_MOTION);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

function prefersReducedMotion() {
  return window.matchMedia?.(REDUCED_MOTION).matches ?? false;
}

/**
 * @param {{
 *   active: boolean,
 *   reconnecting?: boolean,
 *   outputLevel: () => number,
 *   micLevel: () => number,
 * }} props
 *   `active` is true while the session is open, `reconnecting` while it
 *   reconnects; the two sources return 0..1
 *   (useLiveAgent.js) and are read once per animation frame.
 */
export function VolumeOrb({ active, reconnecting = false, outputLevel, micLevel }) {
  const orbRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const reducedMotion = useSyncExternalStore(subscribeToReducedMotion, prefersReducedMotion);
  const animate = active && !reducedMotion;

  // The sources as of the latest render, read without being a dependency:
  // a card render (a transcript line) hands the orb new getter functions
  // whenever they aren't memoized, and that must not restart the loop, which
  // would blank the rings for a frame and drop the smoothing.
  const readLevels = useEffectEvent(() => [outputLevel(), micLevel()]);

  // Syncs the element with the audio, a source outside React, for as long as
  // it should move.
  useEffect(() => {
    const orb = orbRef.current;
    if (!animate || !orb) return;
    let level = 0;
    let mic = 0;
    // What was last written, as written: a write restyles the rings, so a
    // frame whose rounded value is unchanged (silence between turns, the
    // fall-off's tail) skips it. Two decimals are finer than a ring moves.
    let levelText = '';
    let micText = '';
    const tick = () => {
      const [output, input] = readLevels();
      level = Math.max(output, level * FALL_OFF);
      mic = Math.max(input, mic * FALL_OFF);
      const nextLevel = level.toFixed(2);
      const nextMic = mic.toFixed(2);
      if (nextLevel !== levelText) orb.style.setProperty('--level', (levelText = nextLevel));
      if (nextMic !== micText) orb.style.setProperty('--mic-level', (micText = nextMic));
      frame = requestAnimationFrame(tick);
    };
    let frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      orb.style.removeProperty('--level');
      orb.style.removeProperty('--mic-level');
    };
  }, [animate]);

  return (
    <div
      ref={orbRef}
      className="volume-orb"
      data-active={active}
      data-reconnecting={reconnecting ? 'true' : undefined}
      aria-hidden="true"
    />
  );
}
