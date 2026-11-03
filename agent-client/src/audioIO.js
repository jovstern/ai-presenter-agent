import { encodeInputFrame, OUTPUT_SAMPLE_RATE } from './pcm.js';

// The name public/capture-worklet.js registers its processor under.
const CAPTURE_PROCESSOR = 'capture-processor';

// Voice needs getUserMedia and AudioWorklet, and browsers expose both only to
// a secure context (https, or http://localhost). Checked before Connect does
// anything, so plain http fails with a reason instead of a TypeError from a
// missing navigator.mediaDevices (docs/code-review-notes.md L6). The error's
// name is what AgentApp words; both names are this file's own, so no browser
// DOMException is mistaken for them.
/** @returns {Error | null} Why this page can't capture voice, or null if it can. */
export function voiceSupportError() {
  if (!window.isSecureContext) {
    return Object.assign(new Error('Voice needs a secure context (https or localhost).'), {
      name: 'InsecureContextError',
    });
  }
  if (typeof AudioWorkletNode === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return Object.assign(new Error('This browser has no AudioWorklet or getUserMedia.'), {
      name: 'AudioUnsupportedError',
    });
  }
  return null;
}

// Mic capture: the mic stream into an AudioWorklet (public/capture-worklet.js)
// that resamples to 16 kHz Int16 off the main thread and posts 80 ms frames,
// each base64-encoded here for the session. Replaces the deprecated
// ScriptProcessorNode (docs/project-knowledge-handoff.md §4).
/**
 * @param {{
 *   workletUrl: string,
 *   onFrame: (base64Frame: string) => void,
 *   onError?: (error: Error) => void,
 * }} options
 *   `workletUrl` is where capture-worklet.js is served (main.jsx resolves it
 *   next to the bundle); `onFrame` gets 16 kHz PCM; `onError` gets why the mic
 *   couldn't start.
 * @returns {{ ready: Promise<void>, stop: () => void }}
 */
export function startCapture({ workletUrl, onFrame, onError }) {
  /** @type {AudioContext | undefined} */
  let audioContext;
  /** @type {MediaStream | undefined} */
  let stream;
  /** @type {MediaStreamAudioSourceNode | undefined} */
  let source;
  /** @type {AudioWorkletNode | undefined} */
  let worklet;
  let stopped = false;

  const ready = (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (stopped) return release();
      // The device's own rate: the worklet resamples (see its header for why
      // not a 16 kHz context).
      audioContext = new AudioContext();
      await audioContext.audioWorklet.addModule(workletUrl).catch((/** @type {unknown} */ err) => {
        // Named as this file's own, so the card words it as voice failing to
        // start (a reload fetches the file again), not as a microphone problem.
        const reason = err instanceof Error ? err.message : String(err);
        throw Object.assign(
          new Error(`The capture worklet failed to load: ${reason}`, { cause: err }),
          { name: 'WorkletLoadError' },
        );
      });
      if (stopped) return release();
      // Created after awaits, the context is outside the click's user
      // activation, and Safari starts such a context suspended: a suspended
      // context never runs the worklet, so no frame would ever arrive. A
      // refusal rejects, and is reported like any other capture failure.
      await audioContext.resume();
      if (stopped) return release();
      source = audioContext.createMediaStreamSource(stream);
      // No outputs: the node is a sink, so nothing reaches the speakers, and
      // the browser still runs it because its input is live.
      worklet = new AudioWorkletNode(audioContext, CAPTURE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      worklet.port.onmessage = (/** @type {MessageEvent<ArrayBuffer>} */ event) => {
        if (!stopped) onFrame(encodeInputFrame(new Int16Array(event.data)));
      };
      source.connect(worklet);
    } catch (err) {
      // A DOMException from getUserMedia (NotAllowedError, NotFoundError, ...),
      // from addModule (the worklet file failed to load) or from resume(): an Error either
      // way, which AgentApp words by its name. Whatever was acquired goes. A
      // failure caused by stop() itself (addModule on a context it closed) is
      // not reported: nobody is waiting for this capture any more.
      release();
      if (!stopped) onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  // Releases everything acquired so far, once: the port, the nodes, the mic
  // track(s) (B2: no live mic left behind) and the context.
  function release() {
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.close();
      worklet.disconnect();
      worklet = undefined;
    }
    source?.disconnect();
    source = undefined;
    stream?.getTracks().forEach((t) => t.stop());
    stream = undefined;
    // close() rejects on a context that is already closed; the ref is
    // cleared so it is only ever called once.
    audioContext?.close();
    audioContext = undefined;
  }

  // Idempotent: a second stop() finds nothing left to release. A stop()
  // during setup releases what exists now; the setup releases the rest when
  // its pending await returns.
  function stop() {
    stopped = true;
    release();
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
