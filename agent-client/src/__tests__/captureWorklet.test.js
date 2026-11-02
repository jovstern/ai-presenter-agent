import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// public/capture-worklet.js runs in an AudioWorkletGlobalScope. Here that
// scope is stubbed: AudioWorkletProcessor gives each instance a port that
// records what it posts, registerProcessor captures the class, and
// `sampleRate` is set per test before an instance is built (the processor
// reads it in its constructor, as the real scope's is fixed per context).

const FRAME_SAMPLES = 1280;
const QUANTUM = 128; // samples per process() call, as in the browser

/** @type {new () => { port: { posted: { message: ArrayBuffer, transfer: ArrayBuffer[] }[] }, process: (inputs: Float32Array[][]) => boolean }} */
let Processor;

beforeAll(async () => {
  class AudioWorkletProcessor {
    constructor() {
      const posted = [];
      this.port = {
        posted,
        postMessage: (message, transfer) => posted.push({ message, transfer }),
      };
    }
  }
  vi.stubGlobal('AudioWorkletProcessor', AudioWorkletProcessor);
  vi.stubGlobal('registerProcessor', (name, ctor) => {
    expect(name).toBe('capture-processor');
    Processor = ctor;
  });
  vi.stubGlobal('sampleRate', 48000);
  await import('../../public/capture-worklet.js');
});

afterEach(() => {
  vi.stubGlobal('sampleRate', 48000);
});

/** A processor at `rate`, fed `seconds` of `signal(t)` in 128-sample quanta. */
function run(rate, seconds, signal) {
  vi.stubGlobal('sampleRate', rate);
  const processor = new Processor();
  const total = Math.round(rate * seconds);
  for (let start = 0; start < total; start += QUANTUM) {
    const block = new Float32Array(Math.min(QUANTUM, total - start));
    for (let i = 0; i < block.length; i++) block[i] = signal((start + i) / rate);
    expect(processor.process([[block]])).toBe(true);
  }
  const frames = processor.port.posted.map(({ message, transfer }) => {
    expect(transfer).toEqual([message]); // the buffer is transferred, not copied
    return new Int16Array(message);
  });
  return frames;
}

/** Peak amplitude (as a Float32 fraction) over the frames, skipping the first. */
function peak(frames) {
  let max = 0;
  for (const frame of frames.slice(1)) for (const s of frame) max = Math.max(max, Math.abs(s));
  return max / 0x7fff;
}

const tone = (hz, amplitude) => (t) => amplitude * Math.sin(2 * Math.PI * hz * t);

describe('capture worklet', () => {
  it('at 16 kHz passes samples straight through as Int16 frames of 1280', () => {
    const frames = run(16000, 0.25, (t) => (Math.round(t * 16000) % 2 ? 0.5 : -0.5));

    // 4000 samples: three full frames, the rest waits for more input.
    expect(frames).toHaveLength(3);
    frames.forEach((frame) => expect(frame).toHaveLength(FRAME_SAMPLES));
    expect(Array.from(frames[0].slice(0, 4))).toEqual([-16384, 16383, -16384, 16383]);
  });

  it('clamps out-of-range input instead of wrapping', () => {
    const frames = run(16000, FRAME_SAMPLES / 16000, (t) => (t === 0 ? 2 : -2));
    expect(frames[0][0]).toBe(0x7fff);
    expect(frames[0][1]).toBe(-0x8000);
  });

  it.each([48000, 44100])('emits 16 kHz from %i Hz: 1 s in, 16000 samples out', (rate) => {
    const frames = run(rate, 1, tone(440, 0.5));
    // 12 full frames (15360 samples); the 640 left wait for the next frame.
    expect(frames).toHaveLength(12);
    frames.forEach((frame) => expect(frame).toHaveLength(FRAME_SAMPLES));
  });

  it.each([48000, 44100])('keeps a 1 kHz tone at %i Hz at its level and pitch', (rate) => {
    const frames = run(rate, 1, tone(1000, 0.5));
    expect(peak(frames)).toBeGreaterThan(0.48);
    expect(peak(frames)).toBeLessThan(0.52);

    // 1 kHz at 16 kHz is 16 samples a cycle: two zero crossings per 16.
    const samples = frames.slice(1).flatMap((frame) => Array.from(frame));
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i] < 0 !== samples[i - 1] < 0) crossings++;
    }
    expect(crossings / samples.length).toBeCloseTo(2 / 16, 2);
  });

  it.each([48000, 44100])(
    'filters a 12 kHz tone at %i Hz out instead of aliasing it into the voice band',
    (rate) => {
      // Dropping or interpolating samples without a low-pass would fold this
      // to 4 kHz at nearly full level.
      const frames = run(rate, 1, tone(12000, 0.5));
      expect(peak(frames)).toBeLessThan(0.005); // better than -40 dB
    },
  );

  it('waits quietly through a quantum with no input channel', () => {
    vi.stubGlobal('sampleRate', 48000);
    const processor = new Processor();
    expect(processor.process([[]])).toBe(true);
    expect(processor.process([])).toBe(true);
    expect(processor.port.posted).toHaveLength(0);
  });
});
