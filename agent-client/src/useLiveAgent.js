import { useEffect, useRef, useState } from 'react';
import { createLiveSession } from './liveSession.js';
import { startCapture, createPlayer } from './audioIO.js';
import { decodeOutputChunk } from './pcm.js';

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
export function useLiveAgent(bridge) {
  // details ({ attempt, maxAttempts, reason }) come with `reconnecting` and
  // `failed`; kept with the status so the two can never disagree.
  const [connection, setConnection] = useState({ status: 'idle', details: null });
  const [transcript, setTranscript] = useState([]);
  const [micError, setMicError] = useState(null);
  const sessionRef = useRef(null);
  const captureRef = useRef(null);
  const playerRef = useRef(null);

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

  // Idempotent: whatever pipeline a previous connect() left is stopped before
  // a new one starts, so a double press or a Retry never stacks a second mic.
  async function connect() {
    stopAudio();
    setMicError(null);
    const session = getSession();
    playerRef.current = createPlayer();
    captureRef.current = startCapture({
      onFrame: (frame) => session.sendAudioFrame(frame),
      onError: (err) => {
        setMicError(err); // AgentApp words it by err.name
        // A blocked mic means the agent can never hear the user: end the
        // session instead of showing "Live", so the card offers Connect —
        // the action its guidance names.
        if (err?.name === 'NotAllowedError') disconnect();
      },
    });
    await session.connect();
  }

  function disconnect() {
    sessionRef.current?.disconnect();
    stopAudio();
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
    connect,
    disconnect,
    retry: connect,
  };
}
