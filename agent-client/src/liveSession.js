// Explicit /web subpath, not the bare package: the bare entry's "browser"
// condition wasn't picked up by this build and pulled in the Node build
// instead, which references `process` and crashes in the browser.
import { GoogleGenAI, Modality } from '@google/genai/web';
import { CHANGE_EVENT, buildContextMessage } from './knowledgeStore.js';
import { TOOL_DECLARATIONS, toPositionalArgs } from './actionTools.js';
import { createDomSnapshotContext, formatSnapshotMessage } from './domSnapshotContext.js';
import { createLoopGuard, actionSignature } from './loopGuard.js';

const MODEL = 'gemini-3.8-live';

// Immediate, 1s, 3s, 7s, 15s, 30s — matches the backoff documented for the
// original build (docs/project-knowledge-handoff.md §3.3).
const RECONNECT_DELAYS = [0, 1000, 3000, 7000, 15000, 30000];

// How long to wait for bridge.js to reply to a dispatched action before
// giving up and reporting failure back to the model — an unresponsive page
// (or a stale bridge from before a navigation) shouldn't hang the turn
// forever (docs/code-review-notes.md's own history flags a case where a
// missing ds-action-result reply left the client waiting the full timeout).
const ACTION_TIMEOUT_MS = 4000;

// Expanded per docs/code-review-notes.md B4 now that tools exist: role,
// the selector constraint, and the act -> observe -> narrate loop.
const SYSTEM_INSTRUCTION =
  'You are a voice-controlled presenter agent embedded in a demo web app. You ' +
  'see the page through periodic snapshots of its interactive elements, and act ' +
  'on it using the click, scroll, fill, and navigate tools. Only ever use a ' +
  'selector that was given to you in a snapshot — never invent or guess one. ' +
  'Speak concisely: briefly say what you are about to do just before you do it, ' +
  'act, then confirm the result once you see it reflected in the next snapshot. ' +
  'If a tool call fails or a page does not change as expected, say so honestly ' +
  'and try a different approach rather than repeating the same action.';

// Wraps ai.live.connect: owns the WebSocket lifecycle, reconnect + session
// resumption. Deliberately knows nothing about the microphone — reconnects
// never touch audio capture, which is what caused the old build's reconnect
// bug (docs/code-review-notes.md B2: mic pipeline duplicated on every retry).
// Mic frames arrive continuously from the moment Connect is clicked, but
// ai.live.connect() takes a beat to resolve — bound how much audio queues up
// for that gap so "hears you" doesn't depend on speaking after a fixed delay.
const MAX_PENDING_FRAMES = 20; // ~5s of 4096-sample/16kHz frames

export function createLiveSession({ onStatusChange, onAudioChunk, onTranscript, onInterrupted }) {
  let session = null;
  let generation = 0;
  let resumeHandle = null;
  let reconnectTimer = null;
  let attempt = 0;
  let manuallyClosed = false;
  let pendingFrames = [];

  function sendFrame(base64Frame) {
    session.sendRealtimeInput({ audio: { data: base64Frame, mimeType: 'audio/pcm;rate=16000' } });
  }

  // Resent on every connect() (including a resumed reconnect) and whenever
  // the knowledge store changes mid-session — a (re)connect can't fully
  // trust a resumed session's turn history is intact, so this resends fresh
  // grounding rather than assuming the model still remembers.
  function sendKnowledgeContext() {
    if (!session) return;
    const message = buildContextMessage();
    if (message) session.sendClientContent({ turns: message, turnComplete: false });
  }

  window.addEventListener(CHANGE_EVENT, sendKnowledgeContext);

  // --- DOM grounding + tool-calling ---
  const snapshotContext = createDomSnapshotContext();
  const loopGuard = createLoopGuard();

  function requestFreshSnapshot() {
    window.postMessage({ type: 'ds-request-snapshot' }, window.location.origin);
  }

  // sandbox/bridge.js broadcasts these; only 'ds-ready' and 'ds-dom-snapshot'
  // are handled here — 'ds-action-result' replies are consumed by dispatchAction's
  // own one-off listener below, not here.
  function handleBridgeBroadcast(event) {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data) return;

    if (data.type === 'ds-ready') {
      // A fresh page has nothing in common with whatever delta state the
      // last one left behind — force the next snapshot to be a keyframe.
      // Deliberately does NOT send anything else (no greeting) — that's
      // the exact class of bug docs/code-review-notes.md B3 describes.
      snapshotContext.markNavigated();
      return;
    }

    if (data.type === 'ds-dom-snapshot' && session) {
      const decision = snapshotContext.decide({ full: data.full, changed: data.changed, removed: data.removed });
      session.sendClientContent({ turns: formatSnapshotMessage(decision), turnComplete: false });
    }
  }

  window.addEventListener('message', handleBridgeBroadcast);

  function dispatchAction(name, args) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        window.removeEventListener('message', handleResult);
        resolve({ success: false, error: 'Timed out waiting for the page to respond.' });
      }, ACTION_TIMEOUT_MS);

      function handleResult(event) {
        if (event.origin !== window.location.origin) return;
        const data = event.data;
        if (data?.type !== 'ds-action-result' || data.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', handleResult);
        resolve(data);
      }

      window.addEventListener('message', handleResult);
      window.postMessage({ type: 'ds-action', id, action: name, args }, window.location.origin);
    });
  }

  // Serialized on purpose (docs/code-review-notes.md H4): dispatching a batch
  // concurrently races a navigate against a click that expects the new page,
  // and doesn't guarantee sendToolResponse ordering back to the model.
  async function handleToolCallBatch(functionCalls) {
    const batchSession = session;
    for (const fc of functionCalls) {
      const signature = actionSignature(fc.name, fc.args);
      const result = loopGuard.check(signature)
        ? { success: false, error: 'This action has repeated too many times in a row — try something different.' }
        : await dispatchAction(fc.name, toPositionalArgs(fc.name, fc.args ?? {}));

      if (session !== batchSession) return; // superseded by a reconnect mid-batch
      session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: result } });
    }
  }

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
    // Echoes the single-use nonce server/index.js embedded when it served
    // this page (docs/code-review-notes.md H1) — window.__DS_NONCE__ is set
    // by an inline script in sandbox/index.html, before this script runs.
    const nonce = window.__DS_NONCE__ ?? '';
    const res = await fetch(`/api/live-token?nonce=${encodeURIComponent(nonce)}`);
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

    if (message.toolCall?.functionCalls?.length) {
      handleToolCallBatch(message.toolCall.functionCalls); // fire-and-forget; internally serialized
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
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        },
      });

      if (gen !== generation) {
        newSession.close();
        return;
      }
      session = newSession;
      pendingFrames.forEach(sendFrame);
      pendingFrames = [];
      sendKnowledgeContext();
      // A (re)connect can't fully trust a resumed session's turn history is
      // intact (same reasoning as sendKnowledgeContext above) — force a
      // fresh keyframe rather than assuming the model still remembers the
      // page, and ask bridge.js for one right away instead of waiting for
      // the next incidental DOM mutation.
      snapshotContext.markNavigated();
      requestFreshSnapshot();
      // Greet once per fresh session, not on a resumed reconnect — otherwise
      // a mid-conversation resumption would restart the conversation with a
      // fresh "hello" (the same class of bug as docs/code-review-notes.md B3).
      if (!resumeHandle) {
        session.sendClientContent({ turns: 'Greet the user with a brief hello.', turnComplete: true });
      }
    } catch {
      if (gen !== generation) return;
      setStatus('failed');
      scheduleReconnect(gen);
    }
  }

  function sendAudioFrame(base64Frame) {
    if (session) {
      sendFrame(base64Frame);
      return;
    }
    pendingFrames.push(base64Frame);
    if (pendingFrames.length > MAX_PENDING_FRAMES) pendingFrames.shift();
  }

  function disconnect() {
    generation += 1; // invalidate any in-flight connect() too
    manuallyClosed = true;
    attempt = 0;
    resumeHandle = null;
    pendingFrames = [];
    teardown();
    setStatus('closed');
  }

  return { connect, disconnect, sendAudioFrame };
}
