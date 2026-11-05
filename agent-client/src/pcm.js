// The Live API's audio formats and their base64 wire encoding. Input
// (16 kHz Int16 mono) is produced by public/capture-worklet.js, which also
// does the resampling and Float32 → Int16 conversion; this file only encodes
// those frames and decodes the 24 kHz output chunks.
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

// String.fromCharCode(...bytes) passes every byte as an argument and overflows
// the stack on a large frame; one call per char is slow at ~12 frames a second
// (docs/code-review-notes.md L1). Spreading 32 Ki bytes at a time avoids both.
const BASE64_CHUNK = 0x8000;

/**
 * @param {Int16Array} int16
 * @returns {Float32Array<ArrayBuffer>}
 */
function int16ToFloat32(int16) {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  }
  return float32;
}

/** @param {Uint8Array} bytes */
function bytesToBase64(bytes) {
  /** @type {string[]} */
  const parts = [];
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK)));
  }
  return btoa(parts.join(''));
}

/** @param {string} base64 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// An Int16Array view needs an even byte offset and whole samples: a view at an
// odd offset throws a RangeError, so it is copied into a fresh (aligned)
// buffer first, and a trailing odd byte, half a sample, is dropped
// (docs/code-review-notes.md L1).
/**
 * @param {Uint8Array} bytes Little-endian 16-bit PCM.
 * @returns {Int16Array}
 */
export function bytesToInt16(bytes) {
  const length = Math.floor(bytes.byteLength / 2);
  if (bytes.byteOffset % 2 === 0) return new Int16Array(bytes.buffer, bytes.byteOffset, length);
  return new Int16Array(bytes.slice(0, length * 2).buffer);
}

// Encodes one captured 16 kHz Int16 frame for realtimeInput. Only the view's
// own bytes: a subarray's buffer holds more than the frame.
/**
 * @param {Int16Array} int16
 * @returns {string} base64
 */
export function encodeInputFrame(int16) {
  return bytesToBase64(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength));
}

// Decodes a base64 chunk of 24kHz 16-bit PCM mono (the Live API's output
// format) into a Float32Array suitable for an AudioBuffer.
/**
 * @param {string} base64
 * @returns {Float32Array<ArrayBuffer>}
 */
export function decodeOutputChunk(base64) {
  return int16ToFloat32(bytesToInt16(base64ToBytes(base64)));
}

export { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE };
