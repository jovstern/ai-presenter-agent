import { describe, expect, it } from 'vitest';
import { encodeInputFrame, decodeOutputChunk } from '../pcm.js';

describe('pcm', () => {
  it('round-trips a signal through encode -> decode within quantization error', () => {
    const sourceRate = 16000; // no resampling in this case, isolates quantization error
    const samples = new Float32Array(160);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((i / samples.length) * Math.PI * 2) * 0.5;
    }

    const encoded = encodeInputFrame(samples, sourceRate);
    const decoded = decodeOutputChunk(encoded);

    expect(decoded.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i++) {
      expect(decoded[i]).toBeCloseTo(samples[i], 3);
    }
  });

  it('resamples down to 16kHz when the source rate is higher', () => {
    const sourceRate = 48000;
    const samples = new Float32Array(480).fill(0.25);

    const encoded = encodeInputFrame(samples, sourceRate);
    const decoded = decodeOutputChunk(encoded);

    // 480 samples at 48kHz -> ~160 samples at 16kHz
    expect(decoded.length).toBe(160);
  });

  it('clamps out-of-range values instead of wrapping', () => {
    const samples = new Float32Array([2, -2, 0]);
    const encoded = encodeInputFrame(samples, 16000);
    const decoded = decodeOutputChunk(encoded);

    expect(decoded[0]).toBeCloseTo(1, 3);
    expect(decoded[1]).toBeCloseTo(-1, 3);
    expect(decoded[2]).toBeCloseTo(0, 3);
  });
});
