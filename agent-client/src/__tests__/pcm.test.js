import { describe, expect, it } from 'vitest';
import { bytesToInt16, decodeOutputChunk, encodeInputFrame, levelOf } from '../pcm.js';

/**
 * Little-endian bytes of the given Int16 samples.
 * @param {...number} samples
 */
function le16(...samples) {
  return new Uint8Array(new Int16Array(samples).buffer);
}

describe('pcm', () => {
  it('round-trips Int16 samples through encode -> decode', () => {
    const samples = new Int16Array([0, 1, -1, 0x7fff, -0x8000, 1234, -4321]);
    const decoded = decodeOutputChunk(encodeInputFrame(samples));

    expect(decoded).toHaveLength(samples.length);
    expect(Array.from(decoded)).toEqual(
      Array.from(samples, (s) => Math.fround(s / (s < 0 ? 0x8000 : 0x7fff))),
    );
    expect(decoded[3]).toBe(1);
    expect(decoded[4]).toBe(-1);
  });

  it('encodes only a subarray view, not the whole buffer behind it', () => {
    const whole = new Int16Array([9, 9, 100, -200, 300, 9]);
    const view = whole.subarray(2, 5);

    expect(encodeInputFrame(view)).toBe(encodeInputFrame(new Int16Array([100, -200, 300])));
  });

  it('encodes a 1 MB frame without a stack overflow, and it decodes back intact', () => {
    const samples = new Int16Array(512 * 1024); // 1 MiB of bytes
    for (let i = 0; i < samples.length; i++) samples[i] = ((i * 7919) % 65536) - 32768;

    const encoded = encodeInputFrame(samples);
    expect(encoded).toHaveLength(Math.ceil(samples.byteLength / 3) * 4);
    const decoded = bytesToInt16(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
    // Not toEqual: its element-by-element deep equality over 512 Ki samples
    // takes about a second idle and timed out under parallel load (#26).
    expect(decoded).toHaveLength(samples.length);
    expect(decoded.findIndex((sample, i) => sample !== samples[i])).toBe(-1);
  });

  it('matches the platform base64 for a frame', () => {
    const bytes = le16(1, 256, -2);
    expect(encodeInputFrame(new Int16Array([1, 256, -2]))).toBe(
      btoa(String.fromCharCode(...bytes)),
    );
  });

  describe('bytesToInt16', () => {
    it('reads samples from a view at an odd byte offset (an aligned copy, no RangeError)', () => {
      const backing = new Uint8Array(1 + 6);
      backing.set(le16(1000, -1000, 7), 1);
      const odd = backing.subarray(1);
      expect(odd.byteOffset).toBe(1);

      expect(Array.from(bytesToInt16(odd))).toEqual([1000, -1000, 7]);
    });

    it('reads samples from an even non-zero offset in place', () => {
      const backing = new Uint8Array(2 + 4);
      backing.set(le16(-5, 5), 2);
      const view = backing.subarray(2);

      const int16 = bytesToInt16(view);
      expect(Array.from(int16)).toEqual([-5, 5]);
      expect(int16.buffer).toBe(backing.buffer); // no copy needed
    });

    it('drops a trailing half sample instead of throwing', () => {
      const bytes = new Uint8Array([...le16(42, -42), 0xff]);
      expect(Array.from(bytesToInt16(bytes))).toEqual([42, -42]);
    });

    it('drops a trailing half sample at an odd offset too', () => {
      const backing = new Uint8Array([0, ...le16(3), 0xff]);
      expect(Array.from(bytesToInt16(backing.subarray(1)))).toEqual([3]);
    });
  });

  it('decodes 24 kHz output to Float32 in [-1, 1]', () => {
    const base64 = btoa(String.fromCharCode(...le16(0x7fff, -0x8000, 0, 0x4000)));
    const decoded = decodeOutputChunk(base64);

    expect(decoded).toBeInstanceOf(Float32Array);
    expect(Array.from(decoded)).toEqual([1, -1, 0, 0x4000 / 0x7fff].map(Math.fround));
  });
});

// The orb's loudness: RMS in dBFS, -60 dB (and below) → 0, 0 dB → 1, so
// speech at a normal level (about -20 dBFS) sits two thirds of the way up.
describe('levelOf', () => {
  it('is 0 for silence and for no samples', () => {
    expect(levelOf(new Float32Array(128))).toBe(0);
    expect(levelOf(new Float32Array(0))).toBe(0);
  });

  it('is 1 at full scale, and never above', () => {
    expect(levelOf(Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 1 : -1)))).toBe(1);
    expect(levelOf(new Float32Array([2, -2]))).toBe(1);
  });

  it('maps -20 dBFS to two thirds and -60 dBFS or quieter to 0', () => {
    expect(levelOf(new Float32Array([0.1, -0.1]))).toBeCloseTo(2 / 3, 5);
    expect(levelOf(new Float32Array([0.001, -0.001]))).toBeCloseTo(0, 5);
    expect(levelOf(new Float32Array([0.0001, -0.0001]))).toBe(0);
  });

  it('reads Int16 samples against their own full scale', () => {
    expect(levelOf(new Int16Array([3277, -3277]), 0x8000)).toBeCloseTo(2 / 3, 2);
  });
});
