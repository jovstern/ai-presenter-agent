import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality } from "@google/genai";
import { TOOL_DECLARATIONS } from "./actionTools.js";
import { createLoopGuard } from "./loopGuard.js";
import { floatTo16BitPCM, int16ToBase64, base64ToInt16, int16ToFloat32 } from "./pcm.js";

// v1 gap #6: a dropped connection was silent to the user. This backoff is real (not a fixed
// interval) *and* surfaces a terminal "failed" state with a manual retry, instead of just
// giving up quietly.
const RECONNECT_DELAYS_MS = [0, 1000, 3000, 7000, 15000, 30000];
const MIC_SAMPLE_RATE = 16000;
// Gemini Live streams audio out at 24kHz mono — double check against current docs if playback
// sounds pitched/sped incorrectly, model-specific details do change.
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
        const session = sessionRef.current;
        if (!session || data.full.length === 0) return;
        const summary = data.full
          .map((n) => `${n.selector} (${n.role}): "${n.label}"${n.disabled ? " [disabled]" : ""}`)
          .join("\n");
        // turnComplete:false — this is context, not a user utterance expecting a spoken reply.
        session.sendClientContent({
          turns: [
            {
              role: "user",
              parts: [{ text: `[page context, not spoken] Now on "${data.page}". Elements:\n${summary}` }],
            },
          ],
          turnComplete: false,
        });
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
