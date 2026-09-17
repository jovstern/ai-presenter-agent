import { useCallback, useRef, useState } from 'react';
import { createLiveSession } from './liveSession.js';
import { startCapture, createPlayer } from './audioIO.js';
import { decodeOutputChunk } from './pcm.js';

// Glue: wires liveSession + audioIO into React state. The session is created
// once and reused across connect/disconnect cycles; capture and playback are
// recreated fresh on every connect() and torn down on every disconnect().
export function useLiveAgent() {
  const [status, setStatus] = useState('idle');
  const [transcript, setTranscript] = useState([]);
  const [micError, setMicError] = useState(null);
  const sessionRef = useRef(null);
  const captureRef = useRef(null);
  const playerRef = useRef(null);

  const getSession = useCallback(() => {
    if (!sessionRef.current) {
      sessionRef.current = createLiveSession({
        onStatusChange: setStatus,
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
  }, []);

  const connect = useCallback(async () => {
    setMicError(null);
    const session = getSession();
    playerRef.current = createPlayer();
    captureRef.current = startCapture({
      onFrame: (frame) => session.sendAudioFrame(frame),
      onError: (err) => setMicError(err.message || String(err)),
    });
    await session.connect();
  }, [getSession]);

  const disconnect = useCallback(() => {
    sessionRef.current?.disconnect();
    captureRef.current?.stop();
    captureRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
  }, []);

  return { status, transcript, micError, connect, disconnect };
}
