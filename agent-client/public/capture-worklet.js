// @ts-check
// Mic capture on the audio rendering thread (docs/project-knowledge-handoff.md
// §3.3; replaces the deprecated ScriptProcessorNode). Loaded by audioIO.js with
// audioWorklet.addModule() from /agent-client/capture-worklet.js: a same-origin
// file, so script-src 'self' covers it and the CSP needs no blob:.
//
// It turns the context's Float32 input, at whatever rate the context runs,
// into what the Live API takes: 16 kHz mono Int16 PCM, posted to the main
// thread in fixed frames with the buffer transferred, not copied.
//
// Resampling: the context runs at the device's own rate (48 kHz or 44.1 kHz,
// typically). A 16 kHz AudioContext would let the browser resample, but
// Firefox has long refused to connect a mic stream to a context whose rate
// differs from the device's, so this file resamples itself, one path for
// every browser.
// Dropping samples (or interpolating, as pcm.js used to) folds everything
// above 8 kHz back into the band as noise, so the input is first low-passed
// with a windowed-sinc FIR, then read at 16 kHz by linear interpolation, which
// is accurate on a signal that has been band-limited well below its rate.

const TARGET_RATE = 16000;
// 80 ms at 16 kHz, about 12.5 frames a second: close to the old
// ScriptProcessor's 4096 samples at 48 kHz (85 ms), but now the same at every
// device rate.
const FRAME_SAMPLES = 1280;
// The low-pass: cut at 7 kHz, under the 8 kHz Nyquist of the output, with 63
// Blackman-windowed taps. At 48 kHz the transition is ~4 kHz wide, centred on
// the cutoff, so the ~74 dB stopband holds only above ~9.2 kHz: the response
// is -6 dB at 7 kHz, -22 dB at 8 kHz and -65 dB at 9 kHz. What gets through
// between 8 and 9 kHz aliases back into 7–8 kHz less suppressed; speech has
// little energy there.
const CUTOFF_HZ = 7000;
const TAPS = 63;

/**
 * Windowed-sinc low-pass taps, normalised to unity gain at DC.
 * @param {number} cutoff Cycles per input sample (0 to 0.5).
 * @param {number} count Odd, so the filter is symmetric about one tap.
 */
function lowPassTaps(cutoff, count) {
  const taps = new Float32Array(count);
  const middle = (count - 1) / 2;
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const x = i - middle;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const blackman =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (count - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (count - 1));
    taps[i] = sinc * blackman;
    sum += taps[i];
  }
  for (let i = 0; i < count; i++) taps[i] /= sum;
  return taps;
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is the AudioWorkletGlobalScope's: the context's rate.
    /** Input samples per output sample. */
    this.step = sampleRate / TARGET_RATE;
    // Only a rate above the target can alias; at or below it, no filter.
    this.taps = this.step > 1 ? lowPassTaps(CUTOFF_HZ / sampleRate, TAPS) : null;
    // The last TAPS inputs, twice over, so the convolution reads one
    // contiguous window without wrapping: write at i and i + TAPS.
    this.history = new Float32Array(2 * TAPS);
    this.historyIndex = 0;
    /** Index of the input sample about to arrive. */
    this.inputIndex = 0;
    /** The previous filtered sample, the left end of each interpolation. */
    this.previous = 0;
    /** Output samples emitted so far; the next one falls at input position outputIndex * step. */
    this.outputIndex = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.frameLength = 0;
  }

  /** @param {number} sample One input sample. */
  filter(sample) {
    const { taps, history } = this;
    if (!taps) return sample;
    history[this.historyIndex] = sample;
    history[this.historyIndex + TAPS] = sample;
    this.historyIndex = (this.historyIndex + 1) % TAPS;
    // history[historyIndex .. historyIndex + TAPS) is oldest to newest.
    let acc = 0;
    for (let i = 0; i < TAPS; i++) acc += taps[i] * history[this.historyIndex + i];
    return acc;
  }

  /** @param {number} value A Float32 sample, clamped to Int16. */
  emit(value) {
    const s = Math.max(-1, Math.min(1, value));
    this.frame[this.frameLength++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.frameLength === FRAME_SAMPLES) {
      const { buffer } = this.frame;
      this.port.postMessage(buffer, [buffer]); // transferred: the frame is detached here
      this.frame = new Int16Array(FRAME_SAMPLES);
      this.frameLength = 0;
    }
  }

  /**
   * @param {Float32Array[][]} inputs
   * @param {Float32Array[][]} outputs One mono output, there only so WebKit
   *   pulls this node (audioIO.js wires it to a gain of 0): always silence.
   */
  process(inputs, outputs) {
    for (const channel of outputs[0] ?? []) channel.fill(0);
    // Mono: the first channel of the first input. No input yet (the source
    // isn't connected, or the track ended) is a quantum with no channels.
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const current = this.filter(channel[i]);
      const index = this.inputIndex++;
      // Every output position in (index - 1, index] lies between the
      // previous filtered sample and this one.
      // (Computed from a count, not accumulated, so it never drifts.)
      for (
        let at = this.outputIndex * this.step;
        at <= index;
        at = ++this.outputIndex * this.step
      ) {
        const t = at - (index - 1);
        this.emit(this.previous + (current - this.previous) * t);
      }
      this.previous = current;
    }
    return true; // keep processing until the node is disconnected
  }
}

registerProcessor('capture-processor', CaptureProcessor);
