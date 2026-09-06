import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality } from "@google/genai";
import { TOOL_DECLARATIONS } from "./actionTools.js";
import { createLoopGuard } from "./loopGuard.js";
import { floatTo16BitPCM, int16ToBase64, base64ToInt16, int16ToFloat32 } from "./pcm.js";
import { buildContextText } from "./knowledgeStore.js";
import { isFullRefresh, buildFullSnapshotText, buildIncrementalText } from "./domSnapshotContext.js";

// v1 gap #6: a dropped connection was silent to the user. This backoff is real (not a fixed
// interval) *and* surfaces a terminal "failed" state with a manual retry, instead of just
// giving up quietly.
const RECONNECT_DELAYS_MS = [0, 1000, 3000, 7000, 15000, 30000];
const MIC_SAMPLE_RATE = 16000;
// Confirmed against ai.google.dev/gemini-api/docs/live-api/capabilities (Sept 2026): Live API
// input is 16kHz PCM mono (auto-resampled if you send something else), output is 24kHz PCM mono.
const PLAYBACK_SAMPLE_RATE = 24000;

export function useLiveAgent({ volumeMeterRef }) {
  const [status, setStatus] = useState("connecting");
  const [transcript, setTranscript] = useState([]);

  const sessionRef = useRef(null);
  const audioCtxRef = useRef(null);
  const micStreamRef = useRef(null);
  const attemptRef = useRef(0);
  const pendingActionsRef = useRef(new Map()); // action id -> resolve()
  const loopGuardRef = useRef(createLoopGuard());
  const playbackQueueTimeRef = useRef(0);
  // Same doc page: audio-only Live sessions hard-cap at 15 minutes, full stop, independent of
  // network reliability. Session resumption is the documented way past that ceiling — reconnect
  // with the last handle instead of starting fresh, so a 15-minute cutoff behaves like any other
  // reconnect (see scheduleReconnect) instead of losing the conversation.
  const resumeHandleRef = useRef(null);
  const lastPageRef = useRef(null); // for detecting navigation, see domSnapshotContext.js
  const lastSnapshotRef = useRef(null); // most recent {page, full} — resent on reconnect

  const appendTranscript = useCallback((role, text) => {
    setTranscript((prev) => [...prev.slice(-19), { id: crypto.randomUUID(), role, text }]);
  }, []);

  // --- outbound: ask the sandbox bridge to actually perform an action -----------------------
  const dispatchAction = useCallback((name, args) => {
    const sessionToken = document.getElementById("ds-agent")?.dataset.sessionToken || "";
    const id = crypto.randomUUID();
    const result = new Promise((resolve) => {
      pendingActionsRef.current.set(id, resolve);
      setTimeout(() => {
        if (pendingActionsRef.current.has(id)) {
          pendingActionsRef.current.delete(id);
          resolve({ success: false, detail: "bridge did not respond in time" });
        }
      }, 4000);
    });
    window.postMessage(
      { source: "ds-agent-client", type: "ds-action", id, action: name, args, sessionToken },
      window.location.origin
    );
    return result;
  }, []);

  // --- inbound: bridge results, DOM-snapshot context, ready handshake -----------------------
  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.source !== "ds-sandbox-bridge") return;

      if (data.type === "ds-action-result") {
        const resolve = pendingActionsRef.current.get(data.id);
        if (resolve) {
          pendingActionsRef.current.delete(data.id);
          resolve(data);
        }
        return;
      }

      if (data.type === "ds-dom-snapshot") {
        // Keyframe vs. delta-frame decision — see domSnapshotContext.js. Tracked regardless of
        // whether a session is currently connected, so a reconnect always has a recent full
        // snapshot on hand to resend (see connect()'s use of lastSnapshotRef below).
        const fullRefresh = isFullRefresh({
          page: data.page,
          previousPage: lastPageRef.current,
          changed: data.changed,
          removed: data.removed,
          full: data.full,
        });
        lastPageRef.current = data.page;
        lastSnapshotRef.current = { page: data.page, full: data.full };

        const session = sessionRef.current;
        if (!session) return;

        const text = fullRefresh
          ? buildFullSnapshotText({ page: data.page, full: data.full })
          : buildIncrementalText({ page: data.page, changed: data.changed, removed: data.removed });
        if (!text) return;

        // turnComplete:false — this is context, not a user utterance expecting a spoken reply.
        session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: false });
        return;
      }

      if (data.type === "ds-ready") {
        sessionRef.current?.sendClientContent({
          turns: [
            {
              role: "user",
              parts: [{ text: "[system] Greet the user briefly and ask what they'd like to see." }],
            },
          ],
          turnComplete: true,
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // --- user-provided knowledge (localStorage, see knowledgeStore.js) — not real RAG, just a
  // context dump at connect time and again whenever the user edits it mid-session -------------
  const sendKnowledgeContext = useCallback((session) => {
    const text = buildContextText();
    if (!text) return;
    session.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [{ text: `[knowledge provided in advance by the user, not spoken]\n${text}` }],
        },
      ],
      turnComplete: false,
    });
  }, []);

  useEffect(() => {
    function onKnowledgeChanged() {
      if (sessionRef.current) sendKnowledgeContext(sessionRef.current);
    }
    window.addEventListener("ds-knowledge-changed", onKnowledgeChanged);
    return () => window.removeEventListener("ds-knowledge-changed", onKnowledgeChanged);
  }, [sendKnowledgeContext]);

  // --- server -> client: narration audio/text, tool calls -----------------------------------
  const handleToolCall = useCallback(
    async (fc) => {
      const signature = `${fc.name}:${JSON.stringify(fc.args)}`;
      const isLooping = loopGuardRef.current.check(signature);
      const result = isLooping
        ? { success: false, detail: "blocked by loop guard: same action repeated too many times" }
        : await dispatchAction(fc.name, fc.args);

      sessionRef.current?.sendToolResponse({
        functionResponses: [{ id: fc.id, name: fc.name, response: { result } }],
      });
    },
    [dispatchAction]
  );

  const playAudioChunk = useCallback((base64) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const float32 = int16ToFloat32(base64ToInt16(base64));
    const buffer = ctx.createBuffer(1, float32.length, PLAYBACK_SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime, playbackQueueTimeRef.current);
    src.start(startAt);
    playbackQueueTimeRef.current = startAt + buffer.duration;
  }, []);

  const handleServerMessage = useCallback(
    (message) => {
      const parts = message.serverContent?.modelTurn?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) playAudioChunk(part.inlineData.data);
        if (part.text) appendTranscript("agent", part.text);
      }
      if (message.toolCall) {
        for (const fc of message.toolCall.functionCalls) handleToolCall(fc);
      }

      // Field names are camelCase to match every other message shape this SDK uses
      // (serverContent, toolCall.functionCalls) — not independently confirmed against a live
      // session, since that needs a real API key. If resumption silently doesn't kick in, check
      // these names first against whatever the SDK actually sends.
      const resumptionUpdate = message.sessionResumptionUpdate;
      if (resumptionUpdate?.resumable && resumptionUpdate?.newHandle) {
        resumeHandleRef.current = resumptionUpdate.newHandle;
      }
    },
    [appendTranscript, handleToolCall, playAudioChunk]
  );

  // --- mic capture: encode + stream, and drive the volume meter imperatively ----------------
  const startMicCapture = useCallback(async (session) => {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStreamRef.current = stream;

    const source = ctx.createMediaStreamSource(stream);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const meterData = new Uint8Array(analyser.frequencyBinCount);
    (function tickMeter() {
      analyser.getByteFrequencyData(meterData);
      const avg = meterData.reduce((a, b) => a + b, 0) / meterData.length / 255;
      volumeMeterRef.current?.setVolume(avg);
      requestAnimationFrame(tickMeter);
    })();

    // ScriptProcessorNode needs to be part of a graph reaching the destination to fire at all,
    // so it's routed through a zero-gain node rather than straight to speakers (which would
    // otherwise feed the mic back out as audible output).
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);

    processor.onaudioprocess = (e) => {
      const pcm16 = floatTo16BitPCM(e.inputBuffer.getChannelData(0));
      session.sendRealtimeInput({
        audio: { data: int16ToBase64(pcm16), mimeType: `audio/pcm;rate=${MIC_SAMPLE_RATE}` },
      });
    };
  }, [volumeMeterRef]);

  // --- connect / reconnect -------------------------------------------------------------------
  const scheduleReconnect = useCallback(() => {
    if (attemptRef.current >= RECONNECT_DELAYS_MS.length) {
      setStatus("failed");
      return;
    }
    const delay = RECONNECT_DELAYS_MS[attemptRef.current];
    attemptRef.current += 1;
    setStatus("reconnecting");
    setTimeout(connect, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = useCallback(async () => {
    try {
      const tokenRes = await fetch("/api/live-token");
      if (!tokenRes.ok) throw new Error("failed to fetch live token");
      const { token, model } = await tokenRes.json();

      const ai = new GoogleGenAI({ apiKey: token });
      const session = await ai.live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          // Explicit rather than relying on the model's default, since a conversational avatar
          // should always prioritize latency over deeper reasoning.
          thinkingConfig: { thinkingLevel: "minimal" },
          // Empty object = "start a resumable session." A stored handle here = "resume that
          // session" rather than starting over — used both for a plain dropped connection and
          // for the 15-minute hard session cap mentioned above.
          sessionResumption: resumeHandleRef.current ? { handle: resumeHandleRef.current } : {},
        },
        callbacks: {
          onopen: () => {
            attemptRef.current = 0;
            setStatus("ready");
          },
          onmessage: handleServerMessage,
          onerror: () => scheduleReconnect(),
          onclose: () => scheduleReconnect(),
        },
      });
      sessionRef.current = session;
      sendKnowledgeContext(session);
      // A (re)connect can't trust that the model's turn history survived intact — whether this
      // is a fresh session or a resumed one, ground it with a full keyframe of whatever DOM
      // state is already known, rather than waiting for the next bridge event (which may not
      // come at all if nothing changes on screen after reconnecting).
      if (lastSnapshotRef.current) {
        const text = buildFullSnapshotText(lastSnapshotRef.current);
        if (text) session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: false });
      }
      lastPageRef.current = null; // next bridge update, if any, should also count as a keyframe
      await startMicCapture(session);
    } catch (err) {
      console.error("[agent] connect failed", err);
      scheduleReconnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retryNow = useCallback(() => {
    attemptRef.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      sessionRef.current?.close();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, transcript, retryNow };
}
