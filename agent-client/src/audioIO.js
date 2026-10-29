import { encodeInputFrame, OUTPUT_SAMPLE_RATE } from './pcm.js';

// Mic capture. Uses a deprecated ScriptProcessorNode rather than an
// AudioWorklet — deliberate, for simplicity; revisit if this ever needs to
// leave a local demo (see docs/project-knowledge-handoff.md §3.3).
/**
 * @param {{ onFrame: (base64Frame: string) => void, onError?: (error: Error) => void }} callbacks
 *   `onFrame` gets 16 kHz PCM; `onError` gets why the mic couldn't start.
 * @returns {{ ready: Promise<void>, stop: () => void }}
 */
export function startCapture({ onFrame, onError }) {
  /** @type {AudioContext | undefined} */
  let audioContext;
  /** @type {MediaStream | undefined} */
  let stream;
  /** @type {MediaStreamAudioSourceNode | undefined} */
  let source;
  /** @type {ScriptProcessorNode | undefined} */
  let processor;
  /** @type {GainNode | undefined} */
  let silentGain;
  let stopped = false;

  const ready = (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // A DOMException (NotAllowedError, NotFoundError, ...) from getUserMedia,
      // or a TypeError where mediaDevices is missing (an insecure origin): an
      // Error either way, which AgentApp words by its name.
      onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    audioContext = new AudioContext();
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    // ScriptProcessorNode only fires onaudioprocess while connected to a
    // destination; route through a silent gain node to avoid audible mic feedback.
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;

    const { sampleRate } = audioContext; // fixed for the context's lifetime
    processor.onaudioprocess = (event) => {
      if (stopped) return;
      const input = event.inputBuffer.getChannelData(0);
      onFrame(encodeInputFrame(input, sampleRate));
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);
  })();

  function stop() {
    stopped = true;
    processor?.disconnect();
    source?.disconnect();
    silentGain?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    audioContext?.close();
  }

  return { ready, stop };
}

// Playback. Schedules decoded PCM chunks back-to-back on one AudioContext
// timeline, and keeps a handle to every scheduled source so a barge-in
// (serverContent.interrupted) can actually stop in-flight audio instead of
// letting it play out to the end of the buffered queue.
/** @returns {{ enqueue: (float32: Float32Array<ArrayBuffer>) => void, interrupt: () => void, close: () => void }} */
export function createPlayer() {
  const audioContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
  let nextStartTime = 0;
  /** @type {AudioBufferSourceNode[]} */
  let scheduledSources = [];

  /** @param {Float32Array<ArrayBuffer>} float32 */
  function enqueue(float32) {
    const buffer = audioContext.createBuffer(1, float32.length, audioContext.sampleRate);
    buffer.copyToChannel(float32, 0);
    const src = audioContext.createBufferSource();
    src.buffer = buffer;
    src.connect(audioContext.destination);

    const startAt = Math.max(nextStartTime, audioContext.currentTime);
    src.start(startAt);
    nextStartTime = startAt + buffer.duration;

    scheduledSources.push(src);
    src.onended = () => {
      scheduledSources = scheduledSources.filter((s) => s !== src);
    };
  }

  function interrupt() {
    scheduledSources.forEach((s) => {
      try {
        s.stop();
      } catch {
        // already ended
      }
    });
    scheduledSources = [];
    nextStartTime = 0;
  }

  function close() {
    interrupt();
    audioContext.close();
  }

  return { enqueue, interrupt, close };
}
