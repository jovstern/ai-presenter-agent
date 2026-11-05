import { useEffect, useRef, useState } from 'react';
import { createLiveSession } from './liveSession.js';
import { startCapture, createPlayer, voiceSupportError } from './audioIO.js';
import { decodeOutputChunk } from './pcm.js';

/** @import { LiveSession, LiveSessionOptions, SessionStatus, StatusDetails, TranscriptEntry } from './liveSession.js' */

/**
 * `idle` until the first connect; then whatever the session last reported.
 * @typedef {'idle' | SessionStatus} AgentStatus
 */
/**
 * @typedef {object} LiveAgent
 * @property {AgentStatus} status
 * @property {StatusDetails | null} details Set with `reconnecting` and `failed` only.
 * @property {TranscriptEntry[]} transcript Every line so far, in order.
 * @property {Error | null} micError Why the mic couldn't start (or can't on this page), until
 *   the next connect.
 * @property {number} connectCount How many times connect() has run: a key for the alerts, so
 *   an identical alert after a new attempt is a new node, which screen readers announce.
 * @property {() => Promise<void>} connect Starts mic, playback and the session.
 * @property {() => void} disconnect
 * @property {() => Promise<void>} retry The same as connect.
 * @property {() => number} outputLevel The agent's voice right now, 0..1; 0 with no player.
 * @property {() => number} micLevel The mic's last frame, 0..1; 0 with no capture.
 */

// Glue: wires liveSession + audioIO into React state. `bridge` is the page-
// lifetime channel from main.jsx; this hook passes it on and never closes it.
// The session is created lazily on the first connect() and reused across
// connect/disconnect cycles; capture and playback are recreated on every
// connect() and torn down on disconnect(), on `failed` and on unmount, so at
// most one mic stream and one playback AudioContext are ever alive
// (docs/code-review-notes.md B2, M4).
//
// connect/disconnect are plain functions, not useCallback: the React Compiler
// covers memoization.
/**
 * @param {LiveSessionOptions['bridge']} bridge
 * @param {LiveSessionOptions['nonce']} nonce The page nonce, read once by main.jsx.
 * @param {string} workletUrl The capture worklet's URL, resolved once by main.jsx.
 * @returns {LiveAgent}
 */
export function useLiveAgent(bridge, nonce, workletUrl) {
  // details come with `reconnecting` and `failed`; kept with the status so
  // the two can never disagree.
  const [connection, setConnection] = useState(
    /** @type {{ status: AgentStatus, details: StatusDetails | null }} */ ({
      status: 'idle',
      details: null,
    }),
  );
  const [transcript, setTranscript] = useState(/** @type {TranscriptEntry[]} */ ([]));
  const [micError, setMicError] = useState(/** @type {Error | null} */ (null));
  const [connectCount, setConnectCount] = useState(0);
  const sessionRef = useRef(/** @type {LiveSession | null} */ (null));
  const captureRef = useRef(/** @type {ReturnType<typeof startCapture> | null} */ (null));
  const playerRef = useRef(/** @type {ReturnType<typeof createPlayer> | null} */ (null));

  function stopAudio() {
    captureRef.current?.stop();
    captureRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
  }

  function getSession() {
    if (!sessionRef.current) {
      sessionRef.current = createLiveSession({
        bridge,
        nonce,
        onStatusChange: (status, details) => {
          // `failed` means no more retries are coming: release the mic now
          // rather than leave it live behind a dead session. `reconnecting`
          // keeps it, since the resumed session picks the frames back up.
          if (status === 'failed') stopAudio();
          setConnection({ status, details: details ?? null });
        },
        onAudioChunk: (base64) => {
          playerRef.current?.enqueue(decodeOutputChunk(base64));
        },
        onTranscript: (entry) => {
          setTranscript((prev) => [...prev, entry]);
        },
        onInterrupted: () => {
          playerRef.current?.interrupt();
        },
      });
    }
    return sessionRef.current;
  }

  // Declared before connect(), which calls it: the React Compiler skips a
  // hook that uses a function before its declaration (docs/code-review-notes.md M10).
  function disconnect() {
    sessionRef.current?.disconnect();
    stopAudio();
  }

  // Idempotent: whatever pipeline a previous connect() left is stopped before
  // a new one starts, so a double press or a Retry never stacks a second mic.
  async function connect() {
    setConnectCount((count) => count + 1);
    stopAudio();
    // Over plain http (or without AudioWorklet) the mic can never start, so
    // no session is opened and no token minted: the card stays on Connect
    // with the reason (docs/code-review-notes.md L6).
    const unsupported = voiceSupportError();
    setMicError(unsupported);
    if (unsupported) return;
    const session = getSession();
    playerRef.current = createPlayer();
    captureRef.current = startCapture({
      workletUrl,
      onFrame: (frame) => session.sendAudioFrame(frame),
      onError: (err) => {
        setMicError(err); // AgentApp words it by err.name
        // Any capture failure (a blocked or missing mic, a worklet that
        // didn't load) means the agent can never hear the user: end the
        // session instead of showing "Live" while deaf, so the card offers
        // Connect — the action the guidance names.
        disconnect();
      },
    });
    await session.connect();
  }

  // Pull, not push: VolumeOrb reads these once per animation frame and
  // writes a CSS variable, so the levels never enter React state and a frame
  // renders nothing (spec goals #8 and #9, handoff §4). They read the refs at
  // call time, so they keep working across the player and capture that every
  // connect() replaces. Their identity doesn't matter: the orb reads them
  // through useEffectEvent.
  function outputLevel() {
    return playerRef.current?.getLevel() ?? 0;
  }

  function micLevel() {
    return captureRef.current?.getLevel() ?? 0;
  }

  // Syncs with external resources (socket, mic, AudioContexts): release them
  // on unmount. Nulling the ref lets a remount (StrictMode's mount → cleanup →
  // mount, or a real remount) create a fresh session over the same bridge;
  // dispose() only unsubscribes from the bridge, never closes it.
  useEffect(
    () => () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      stopAudio();
    },
    [],
  );

  return {
    status: connection.status,
    details: connection.details,
    transcript,
    micError,
    connectCount,
    connect,
    disconnect,
    retry: connect,
    outputLevel,
    micLevel,
  };
}
