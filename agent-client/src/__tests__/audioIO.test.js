import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_RESUME_TIMEOUT_MS,
  createPlayer,
  startCapture,
  voiceSupportError,
} from '../audioIO.js';

// audioIO.js against stubbed Web Audio and getUserMedia: the secure-context
// check, and that capture releases everything it acquired (B2: no mic left
// live), whenever it is stopped. The real worklet in a real browser is
// e2e/audio.spec.js.

const WORKLET_URL = '/agent-client/capture-worklet.js';

/** Everything a capture created, so a test can check each was released. */
let made;

function fakeMediaDevices({ getUserMedia }) {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
}

function fakeStream() {
  const track = { stop: vi.fn() };
  made.tracks.push(track);
  return { getTracks: () => [track] };
}

beforeEach(() => {
  // `addModule` is what every context's audioWorklet.addModule() does, and
  // `resume` every context's resume(); a test swaps one before startCapture()
  // to hold or fail it. `events` records their order.
  made = {
    tracks: [],
    contexts: [],
    nodes: [],
    analysers: [],
    sources: [],
    events: [],
    addModule: vi.fn(async () => {
      made.events.push('addModule');
    }),
    resume: vi.fn(async () => {
      made.events.push('resume');
    }),
  };
  vi.stubGlobal('isSecureContext', true);

  class FakeAudioContext {
    constructor() {
      this.close = vi.fn(async () => {});
      this.resume = made.resume;
      this.audioWorklet = { addModule: made.addModule };
      this.source = { connect: vi.fn(), disconnect: vi.fn() };
      this.destination = { name: 'destination' };
      this.currentTime = 0;
      this.sampleRate = 24000;
      made.contexts.push(this);
    }
    createMediaStreamSource() {
      return this.source;
    }
    // The player's analyser: getFloatTimeDomainData copies `samples`, the
    // window a test sets as "what is playing now".
    createAnalyser() {
      const analyser = {
        fftSize: 2048,
        samples: new Float32Array(0),
        connect: vi.fn(),
        disconnect: vi.fn(),
        getFloatTimeDomainData: vi.fn((out) => out.set(analyser.samples.subarray(0, out.length))),
      };
      made.analysers.push(analyser);
      return analyser;
    }
    createBuffer(channels, length, rate) {
      return { duration: length / rate, copyToChannel: vi.fn() };
    }
    createBufferSource() {
      const source = { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
      made.sources.push(source);
      return source;
    }
  }
  class FakeAudioWorkletNode {
    constructor(context, name, options) {
      this.name = name;
      this.options = options;
      this.port = { onmessage: null, close: vi.fn() };
      this.disconnect = vi.fn();
      made.events.push('node');
      made.nodes.push(this);
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  fakeMediaDevices({ getUserMedia: vi.fn(async () => fakeStream()) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('voiceSupportError', () => {
  it('is null on a secure page with AudioWorklet and getUserMedia', () => {
    expect(voiceSupportError()).toBeNull();
  });

  it('names an insecure context (plain http)', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(voiceSupportError()?.name).toBe('InsecureContextError');
  });

  it('names a browser without AudioWorklet', () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    expect(voiceSupportError()?.name).toBe('AudioUnsupportedError');
  });

  it('names a browser without getUserMedia', () => {
    vi.stubGlobal('navigator', {});
    expect(voiceSupportError()?.name).toBe('AudioUnsupportedError');
  });
});

describe('startCapture', () => {
  it('loads the worklet from the given URL and feeds the mic into a sink node', async () => {
    const capture = startCapture({ workletUrl: WORKLET_URL, onFrame: vi.fn() });
    await capture.ready;

    const [context] = made.contexts;
    const [node] = made.nodes;
    expect(made.addModule).toHaveBeenCalledWith(WORKLET_URL);
    expect(node.name).toBe('capture-processor');
    expect(node.options).toMatchObject({ numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    expect(context.source.connect).toHaveBeenCalledWith(node);
  });

  // Safari starts a context created after an await (outside the click's user
  // activation) suspended, and a suspended context never runs the worklet.
  it('resumes the context once the worklet has loaded, before building the node', async () => {
    const capture = startCapture({ workletUrl: WORKLET_URL, onFrame: vi.fn() });
    await capture.ready;

    expect(made.resume).toHaveBeenCalledTimes(1);
    expect(made.events).toEqual(['addModule', 'resume', 'node']);
  });

  it('a context that refuses to resume is reported, and everything is released', async () => {
    const onError = vi.fn();
    const refused = Object.assign(new Error('not allowed to start'), { name: 'NotAllowedError' });
    made.resume.mockRejectedValueOnce(refused);
    const capture = startCapture({ workletUrl: WORKLET_URL, onFrame: vi.fn(), onError });
    await capture.ready;

    expect(onError).toHaveBeenCalledWith(refused);
    expect(made.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(made.contexts[0].close).toHaveBeenCalledTimes(1);
    expect(made.nodes).toHaveLength(0);
  });

  // Safari may leave resume() pending forever rather than reject it (M6
  // re-review): without a timeout the card would show Live while deaf.
  describe('a resume() that never settles', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      made.resume.mockImplementationOnce(() => new Promise(() => {}));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it(`is reported as an AudioResumeTimeoutError after ${AUDIO_RESUME_TIMEOUT_MS} ms, and everything is released`, async () => {
      const onError = vi.fn();
      const capture = startCapture({ workletUrl: WORKLET_URL, onFrame: vi.fn(), onError });
      await vi.advanceTimersByTimeAsync(AUDIO_RESUME_TIMEOUT_MS - 1);
      expect(onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await capture.ready;

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].name).toBe('AudioResumeTimeoutError');
      expect(made.tracks[0].stop).toHaveBeenCalledTimes(1);
      expect(made.contexts[0].close).toHaveBeenCalledTimes(1);
      expect(made.nodes).toHaveLength(0);
    });

    it('is not reported after a stop() during the wait', async () => {
      const onError = vi.fn();
      const capture = startCapture({ workletUrl: WORKLET_URL, onFrame: vi.fn(), onError });
      await vi.advanceTimersByTimeAsync(0);
      capture.stop();
      await vi.advanceTimersByTimeAsync(AUDIO_RESUME_TIMEOUT_MS);
      await capture.ready;

      expect(onError).not.toHaveBeenCalled();
      expect(made.tracks[0].stop).toHaveBeenCalledTimes(1);
      expect(made.nodes).toHaveLength(0);
    });
  });

  it('leaves no resume timer behind once the context has resumed', async () => {
    vi.useFakeTimers();
    try {
      const capture = startCapture({ workletUrl: WORKLET_URL, onFrame: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);
      await capture.ready;
      expect(made.nodes).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('base64-encodes each posted Int16 frame for the session', async () => {
    const onFrame = vi.fn();
    const capture = startCapture({ workletUrl: WORKLET_URL, onFrame });
    await capture.ready;

    made.nodes[0].port.onmessage({ data: new Int16Array([1, -1]).buffer });
    expect(onFrame).toHaveBeenCalledWith(btoa('\x01\x00\xff\xff'));
  });

  it('stop() releases the port, the nodes, the track and the context, once', async () => {
    const onFrame = vi.fn();
    const capture = startCapture({ workletUrl: WORKLET_URL, onFrame });
    await capture.ready;
    const [context] = made.contexts;
    const [node] = made.nodes;
    const { onmessage } = node.port;

    capture.stop();
    capture.stop(); // idempotent: nothing is released twice

    expect(node.port.onmessage).toBeNull();
    expect(node.port.close).toHaveBeenCalledTimes(1);
    expect(node.disconnect).toHaveBeenCalledTimes(1);
    expect(context.source.disconnect).toHaveBeenCalledTimes(1);
    expect(made.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    // A frame already in flight when stop() ran is dropped.
    onmessage({ data: new Int16Array([1]).buffer });
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('a stop() while the worklet loads releases the mic and builds no node', async () => {
    const onError = vi.fn();
    let finishLoad;
    made.addModule.mockImplementation(
      // A real addModule on a context closed mid-load rejects.
      () => new Promise((resolve, reject) => (finishLoad = () => reject(new Error('closed')))),
    );
    const capture = startCapture({ workletUrl: WORKLET_URL, onFrame: vi.fn(), onError });
    await vi.waitFor(() => expect(made.contexts).toHaveLength(1));

    capture.stop();
    finishLoad();
    await capture.ready;

    expect(made.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(made.contexts[0].close).toHaveBeenCalledTimes(1);
    expect(made.nodes).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a stop() before the mic is granted stops the track when it arrives', async () => {
    let grant;
    fakeMediaDevices({ getUserMedia: () => new Promise((resolve) => (grant = resolve)) });
    const capture = startCapture({ workletUrl: WORKLET_URL, onFrame: vi.fn() });

    capture.stop();
    grant(fakeStream());
    await capture.ready;

    expect(made.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(made.contexts).toHaveLength(0);
  });

  it('a worklet that fails to load is reported as a WorkletLoadError, and the mic and context are released', async () => {
    const onError = vi.fn();
    const loadError = Object.assign(new Error("Unable to load a worklet's module."), {
      name: 'AbortError',
    });
    made.addModule.mockRejectedValueOnce(loadError);
    const capture = startCapture({ workletUrl: WORKLET_URL, onFrame: vi.fn(), onError });
    await capture.ready;

    const [[reported]] = onError.mock.calls;
    // Its own name, so the card doesn't word it as a microphone problem.
    expect(reported.name).toBe('WorkletLoadError');
    expect(reported.cause).toBe(loadError);
    expect(made.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(made.contexts[0].close).toHaveBeenCalledTimes(1);
    expect(made.nodes).toHaveLength(0);
  });

  it('a blocked mic is reported as getUserMedia rejected it, with nothing to release', async () => {
    const onError = vi.fn();
    const blocked = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    fakeMediaDevices({ getUserMedia: vi.fn(async () => Promise.reject(blocked)) });
    const capture = startCapture({ workletUrl: WORKLET_URL, onFrame: vi.fn(), onError });
    await capture.ready;

    expect(onError).toHaveBeenCalledWith(blocked);
    expect(made.contexts).toHaveLength(0);
  });
});

// The orb's mic ring: the level of the last frame the worklet posted, read on
// demand (no event per frame into React).
describe('startCapture getLevel', () => {
  it("is 0 before the first frame, then the last frame's level, then 0 after stop()", async () => {
    const capture = startCapture({ workletUrl: WORKLET_URL, onFrame: vi.fn() });
    expect(capture.getLevel()).toBe(0);
    await capture.ready;
    expect(capture.getLevel()).toBe(0);

    // About -20 dBFS: two thirds of the way up (pcm.js levelOf).
    made.nodes[0].port.onmessage({ data: new Int16Array([3277, -3277, 3277, -3277]).buffer });
    expect(capture.getLevel()).toBeCloseTo(2 / 3, 2);
    made.nodes[0].port.onmessage({ data: new Int16Array(4).buffer });
    expect(capture.getLevel()).toBe(0);
    made.nodes[0].port.onmessage({ data: new Int16Array([3277, -3277]).buffer });

    capture.stop();
    expect(capture.getLevel()).toBe(0);
  });
});

// The orb's output rings: an AnalyserNode between the scheduled chunks and
// the speakers, read on demand.
describe('createPlayer', () => {
  it('plays every chunk through one analyser on its way to the speakers', () => {
    const player = createPlayer();
    player.enqueue(new Float32Array(240));
    player.enqueue(new Float32Array(240));

    const [context] = made.contexts;
    const [analyser] = made.analysers;
    expect(made.analysers).toHaveLength(1);
    expect(analyser.connect).toHaveBeenCalledWith(context.destination);
    expect(made.sources).toHaveLength(2);
    for (const source of made.sources) {
      expect(source.connect).toHaveBeenCalledWith(analyser);
      expect(source.connect).not.toHaveBeenCalledWith(context.destination);
    }
  });

  it('getLevel() is the level of what is playing now, 0 in silence', () => {
    const player = createPlayer();
    const [analyser] = made.analysers;
    expect(player.getLevel()).toBe(0);

    analyser.samples = Float32Array.from({ length: analyser.fftSize }, (_, i) =>
      i % 2 ? 0.1 : -0.1,
    );
    expect(player.getLevel()).toBeCloseTo(2 / 3, 5);
    // The same buffer every read: no allocation per animation frame.
    const [[first]] = analyser.getFloatTimeDomainData.mock.calls;
    expect(analyser.getFloatTimeDomainData.mock.calls.every(([out]) => out === first)).toBe(true);
  });

  it('getLevel() is 0 after close(), without reading the closed context', () => {
    const player = createPlayer();
    const [analyser] = made.analysers;
    analyser.samples = new Float32Array(analyser.fftSize).fill(0.5);
    player.close();

    analyser.getFloatTimeDomainData.mockClear();
    expect(player.getLevel()).toBe(0);
    expect(analyser.getFloatTimeDomainData).not.toHaveBeenCalled();
    expect(made.contexts[0].close).toHaveBeenCalledTimes(1);
  });
});
