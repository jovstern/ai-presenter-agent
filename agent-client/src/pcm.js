const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

function resampleTo(float32, fromRate, toRate) {
  if (fromRate === toRate) return float32;
  const ratio = fromRate / toRate;
  const outLength = Math.round(float32.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const lo = Math.floor(srcIndex);
    const hi = Math.min(lo + 1, float32.length - 1);
    const frac = srcIndex - lo;
    out[i] = float32[lo] + (float32[hi] - float32[lo]) * frac;
  }
  return out;
}

function float32ToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function int16ToFloat32(int16) {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
  }
  return float32;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Encodes a Float32 audio frame (captured at `sourceSampleRate`) down to the
// 16kHz 16-bit PCM mono the Live API expects for realtime audio input.
export function encodeInputFrame(float32, sourceSampleRate) {
  const resampled = resampleTo(float32, sourceSampleRate, INPUT_SAMPLE_RATE);
  const int16 = float32ToInt16(resampled);
  return bytesToBase64(new Uint8Array(int16.buffer));
}

// Decodes a base64 chunk of 24kHz 16-bit PCM mono (the Live API's output
// format) into a Float32Array suitable for an AudioBuffer.
export function decodeOutputChunk(base64) {
  const bytes = base64ToBytes(base64);
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  return int16ToFloat32(int16);
}

export { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE };
