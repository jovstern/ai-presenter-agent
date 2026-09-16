// Explicit /web subpath, not the bare package: the bare entry's "browser"
// condition wasn't picked up by this build and pulled in the Node build
// instead, which references `process` and crashes in the browser.
import { GoogleGenAI, Modality } from '@google/genai/web';

const MODEL = 'gemini-3.8-live';

// Immediate, 1s, 3s, 7s, 15s, 30s — matches the backoff documented for the
// original build (docs/project-knowledge-handoff.md §3.3).
const RECONNECT_DELAYS = [0, 1000, 3000, 7000, 15000, 30000];

// Scoped to what M1 actually does (voice only, no page awareness yet) —
// expand once actions land (docs/code-review-notes.md B4).
const SYSTEM_INSTRUCTION =
  'You are a voice assistant embedded in a demo page. Speak concisely and ' +
  "naturally. You cannot see or act on the page yet — if asked to do something " +
  'on it, say so honestly rather than pretending to.';

// Wraps ai.live.connect: owns the WebSocket lifecycle, reconnect + session
// resumption. Deliberately knows nothing about the microphone — reconnects
// never touch audio capture, which is what caused the old build's reconnect
// bug (docs/code-review-notes.md B2: mic pipeline duplicated on every retry).
export function createLiveSession({ onStatusChange, onAudioChunk, onTranscript, onInterrupted }) {
  let session = null;
  let generation = 0;
  let resumeHandle = null;
  let reconnectTimer = null;
  let attempt = 0;
  let manuallyClosed = false;

  function setStatus(status) {
    onStatusChange?.(status);
  }

  function teardown() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    session?.close();
    session = null;
  }

  async function fetchToken() {
    const res = await fetch('/api/live-token');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Token request failed: ${res.status}`);
    }
    const { token } = await res.json();
    return token;
  }

  function handleMessage(message) {
    if (message.serverContent?.interrupted) {
      onInterrupted?.();
    }
    if (message.data) {
      onAudioChunk?.(message.data);
    }
    const outText = message.serverContent?.outputTranscription?.text;
    if (outText) onTranscript?.({ role: 'agent', text: outText });
    const inText = message.serverContent?.inputTranscription?.text;
    if (inText) onTranscript?.({ role: 'user', text: inText });

    const resumption = message.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      resumeHandle = resumption.newHandle;
    }
  }

  // Live typically fires both onerror and onclose on the same drop; the
  // reconnectTimer guard collapses that into a single scheduled attempt
  // instead of racing two connect() calls (the other half of B2).
  function scheduleReconnect(gen) {
    if (manuallyClosed || reconnectTimer || gen !== generation) return;
    if (attempt >= RECONNECT_DELAYS.length) {
      setStatus('failed');
      return;
    }
    const delay = RECONNECT_DELAYS[attempt];
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  async function connect() {
    const gen = ++generation; // invalidates any older in-flight connect()
    manuallyClosed = false;
    teardown();
    setStatus('connecting');

    let token;
    try {
      token = await fetchToken();
    } catch {
      if (gen !== generation) return;
      setStatus('failed');
      scheduleReconnect(gen);
      return;
    }
    if (gen !== generation) return;

    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });

    try {
      const newSession = await ai.live.connect({
        model: MODEL,
        callbacks: {
          onopen: () => {
            if (gen !== generation) return;
            attempt = 0;
            setStatus('open');
          },
          onmessage: (message) => {
            if (gen !== generation) return;
            handleMessage(message);
          },
          onerror: () => {
            if (gen !== generation) return;
            scheduleReconnect(gen);
          },
          onclose: () => {
            if (gen !== generation) return;
            scheduleReconnect(gen);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          systemInstruction: SYSTEM_INSTRUCTION,
          sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
        },
      });

      if (gen !== generation) {
        newSession.close();
        return;
      }
      session = newSession;
    } catch {
      if (gen !== generation) return;
      setStatus('failed');
      scheduleReconnect(gen);
    }
  }

  function sendAudioFrame(base64Frame) {
    session?.sendRealtimeInput({ audio: { data: base64Frame, mimeType: 'audio/pcm;rate=16000' } });
  }

  function disconnect() {
    generation += 1; // invalidate any in-flight connect() too
    manuallyClosed = true;
    attempt = 0;
    resumeHandle = null;
    teardown();
    setStatus('closed');
  }

  return { connect, disconnect, sendAudioFrame };
}
