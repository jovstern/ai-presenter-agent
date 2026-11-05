// The AudioWorkletGlobalScope names public/capture-worklet.js uses. TypeScript
// ships no lib for that scope, and these must not leak into src/ (where there
// is no `sampleRate` global), so only jsconfig.worklet.json includes this file.

/** The processor's end of its node's MessagePort, as far as the worklet uses it. */
interface AudioWorkletProcessorPort {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
}

declare class AudioWorkletProcessor {
  readonly port: AudioWorkletProcessorPort;
}

/** The context's sample rate, fixed for its lifetime. */
declare const sampleRate: number;

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][]): boolean;
  },
): void;
