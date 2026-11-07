import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_NAME, createLiveSession } from '../liveSession.js';
import { SdkLoadError, loadLiveSdk } from '../liveSdk.js';
import { setRules } from '../knowledgeStore.js';
import LIVE_MODEL from '../liveModel.json' with { type: 'json' };
import { defined } from './defined.js';

/** @import { Mock } from 'vitest' */
/** @import { MockInstance } from 'vitest' */
/** @import { FunctionCall, GoogleGenAIOptions, LiveConnectConfig, LiveConnectParameters, LiveServerMessage, LiveServerContent } from '@google/genai/web' */
/** @import { ActionResult, Snapshot, SnapshotNode } from '../bridgeProtocol.js' */
/** @import { BridgeChannel } from '../bridgeChannel.js' */
/** @import { LiveSession, SessionStatus, StatusDetails, TranscriptFragment } from '../liveSession.js' */
/** @typedef {ReturnType<typeof fakeBridge>} FakeBridge */

/**
 * The session liveSession gets from the fake live.connect: only the methods it
 * calls, each typed as liveSession calls it (string turns, one function
 * response per call), narrower than the SDK's unions, so a test reads back
 * what was sent without narrowing it first.
 * @typedef {object} FakeSession
 * @property {Mock<() => void>} close
 * @property {Mock<(params: { audio: { data: string, mimeType: string } }) => void>} sendRealtimeInput
 * @property {Mock<(params: { turns: string, turnComplete: boolean }) => void>} sendClientContent
 * @property {Mock<(params: { functionResponses: { id?: string, name?: string, response: ActionResult & { page?: string } } }) => void>} sendToolResponse
 */
/**
 * A plain object standing in for the SDK's LiveServerMessage class: its `data`
 * getter (the turn's audio, which liveSession reads) is a plain field here, and
 * its `text` getter, which liveSession never reads, is left out.
 * @typedef {Omit<LiveServerMessage, 'text' | 'data'> & { data?: string }} FakeServerMessage
 */
/**
 * The callbacks liveSession hands live.connect, as the tests call them: its
 * onerror ignores its argument, and its onclose reads only `code` and `reason`.
 * @typedef {object} ConnectCallbacks
 * @property {(message: FakeServerMessage) => void} onmessage
 * @property {(error: unknown) => void} onerror
 * @property {(event: Partial<CloseEvent>) => void} onclose
 */
/**
 * One recorded live.connect: what it was given, its fake session, and the
 * handles a test uses to make the connect land or fail.
 * @typedef {object} ConnectCall
 * @property {GoogleGenAIOptions} options
 * @property {Omit<LiveConnectParameters, 'callbacks' | 'config'> & { config: LiveConnectConfig, callbacks: ConnectCallbacks }} params
 *   liveSession always passes a config.
 * @property {FakeSession} session
 * @property {() => void} resolve
 * @property {(error: unknown) => void} reject
 */

// A fake Gemini Live client: every live.connect() is recorded with its
// callbacks and a fake session, and stays pending until the test resolves or
// rejects it — so tests control exactly when a connect "lands".
const live = vi.hoisted(() => {
  /** @type {{ calls: ConnectCall[] }} */
  const recorded = { calls: [] };
  return recorded;
});

vi.mock('@google/genai/web', () => {
  class GoogleGenAI {
    /** @param {GoogleGenAIOptions} options */
    constructor(options) {
      this.live = {
        connect: (/** @type {ConnectCall['params']} */ params) =>
          new Promise((resolve, reject) => {
            /** @type {FakeSession} */
            const session = {
              close: vi.fn(),
              sendRealtimeInput: vi.fn(),
              sendClientContent: vi.fn(),
              sendToolResponse: vi.fn(),
            };
            live.calls.push({ options, params, session, resolve: () => resolve(session), reject });
          }),
      };
    }
  }
  return { GoogleGenAI, Modality: { AUDIO: 'AUDIO' }, Behavior: { BLOCKING: 'BLOCKING' } };
});

// The real loader (it imports the mock above), wrapped so a test can make
// one load fail the way a chunk that didn't arrive does.
vi.mock('../liveSdk.js', async (importOriginal) => {
  /** @type {typeof import('../liveSdk.js')} */
  const original = await importOriginal();
  return { ...original, loadLiveSdk: vi.fn(original.loadLiveSdk) };
});

const MAX_ATTEMPTS = 6;
// What a loop refusal (not the budget's) says: the action repeats the last few.
const LOOP_REFUSAL = /repeats your last few actions/i;

/**
 * @param {number} status
 * @param {unknown} body
 */
function tokenResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const okToken = () => tokenResponse(200, { token: 'ephemeral-token' });
// The server's one error shape (server/app.js).
const apiError = (/** @type {string} */ code, /** @type {string} */ message) => ({
  error: { code, message },
});

const fetchMock = vi.fn();

function fakeBridge() {
  const unsubscribeSnapshot = vi.fn();
  const unsubscribeNavigated = vi.fn();
  // Each fake typed as the channel's own method, so a test's
  // mockImplementation is held to the real signature.
  /** @type {BridgeChannel['dispatchAction']} */
  const dispatchAction = async () => ({ success: true });
  /** @type {BridgeChannel['onSnapshot']} */
  const onSnapshot = () => unsubscribeSnapshot;
  /** @type {BridgeChannel['onNavigated']} */
  const onNavigated = () => unsubscribeNavigated;
  const bridge = {
    dispatchAction: vi.fn(dispatchAction),
    requestSnapshot: vi.fn(),
    // Lets a test play the bridge pushing a snapshot over the channel.
    emitSnapshot: (/** @type {Snapshot} */ snapshot) =>
      bridge.onSnapshot.mock.calls.forEach(([listener]) => listener(snapshot)),
    onSnapshot: vi.fn(onSnapshot),
    onNavigated: vi.fn(onNavigated),
    close: vi.fn(),
    unsubscribeSnapshot,
    unsubscribeNavigated,
  };
  return bridge;
}

/** @type {LiveSession[]} */
let created = [];

function setup() {
  const bridge = fakeBridge();
  /** @type {({ status: SessionStatus } & Partial<StatusDetails>)[]} */
  const statuses = [];
  const liveSession = createLiveSession({
    bridge,
    nonce: 'page-nonce',
    onStatusChange: (status, details) => statuses.push({ status, ...details }),
  });
  created.push(liveSession);
  return { bridge, statuses, liveSession, statusNames: () => statuses.map((s) => s.status) };
}

// Runs due timers and drains the promise chains (fetch → live.connect) they start.
const flush = () => vi.advanceTimersByTimeAsync(0);

// A healthy session: connect() resolves (the socket is open), the server confirms setup.
/** @param {ConnectCall} call */
async function establish(call) {
  call.resolve();
  await flush();
  call.params.callbacks.onmessage({ setupComplete: {} });
}

// The real SDK's order (@google/genai 2.32.0, live.connect): setupComplete
// and anything queued behind it reach onmessage *before* connect() resolves,
// while the session object isn't ours yet.
/**
 * @param {ConnectCall} call
 * @param {FakeServerMessage[]} [queued]
 */
async function establishInRealOrder(call, queued = []) {
  call.params.callbacks.onmessage({ setupComplete: {} });
  queued.forEach((message) => call.params.callbacks.onmessage(message));
  call.resolve();
  await flush();
}

// What Live typically does on a network drop: both callbacks, back to back.
/** @param {ConnectCall} call */
function drop(call) {
  call.params.callbacks.onerror(new Error('socket dropped'));
  call.params.callbacks.onclose({ code: 1006 });
}

/** @param {LiveSession} liveSession */
async function connectAndEstablish(liveSession) {
  liveSession.connect();
  await flush();
  const call = defined(live.calls.at(-1), 'a live.connect call');
  await establish(call);
  return call;
}

const greetings = (/** @type {FakeSession} */ session) =>
  session.sendClientContent.mock.calls.filter(([arg]) => arg.turnComplete === true);

beforeEach(() => {
  vi.useFakeTimers();
  live.calls = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => okToken());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  created.forEach((liveSession) => liveSession.dispose());
  created = [];
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createLiveSession', () => {
  it('collapses onerror + onclose from one drop into exactly one reconnect (B2)', async () => {
    const { liveSession } = setup();
    const first = await connectAndEstablish(liveSession);

    drop(first);
    // Long, but under SETUP_TIMEOUT_MS, which would fail the still-pending retry.
    await vi.advanceTimersByTimeAsync(9_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(live.calls).toHaveLength(2);
    expect(first.session.close).toHaveBeenCalled();
  });

  it('closes and ignores a session whose connect() was superseded during live.connect', async () => {
    const { liveSession, statusNames } = setup();
    liveSession.connect();
    await flush();
    liveSession.connect();
    await flush();
    const [stale, current] = live.calls;

    stale.resolve();
    await flush();

    expect(stale.session.close).toHaveBeenCalled();
    expect(stale.session.sendClientContent).not.toHaveBeenCalled();
    expect(statusNames()).not.toContain('open');

    // Late callbacks from the stale socket don't schedule anything either.
    stale.params.callbacks.onclose({});
    await vi.advanceTimersByTimeAsync(9_000); // under SETUP_TIMEOUT_MS: `current` is still pending
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await establish(current);
    expect(statusNames().at(-1)).toBe('open');
    expect(greetings(current.session)).toHaveLength(1);
  });

  it('ignores a token that arrives after its connect() was superseded', async () => {
    /** @type {(response: ReturnType<typeof okToken>) => void} */
    let releaseFirstToken = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => (releaseFirstToken = resolve)));
    const { liveSession } = setup();

    liveSession.connect();
    await flush();
    liveSession.connect();
    await flush();
    releaseFirstToken(okToken());
    await flush();

    expect(live.calls).toHaveLength(1);
  });

  it('dispatches a [navigate, click] batch in order, the click only after navigate resolves (H4)', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);
    /** @type {(result: ActionResult) => void} */
    let finishNavigate = () => {};
    bridge.dispatchAction.mockImplementationOnce(
      () => new Promise((resolve) => (finishNavigate = resolve)),
    );

    call.params.callbacks.onmessage({
      toolCall: {
        functionCalls: [
          { id: 'nav', name: 'navigate', args: { route: '/pricing.html' } },
          { id: 'buy', name: 'click', args: { selector: '#buy' } },
        ],
      },
    });
    await flush();

    expect(bridge.dispatchAction).toHaveBeenCalledTimes(1);
    expect(bridge.dispatchAction).toHaveBeenLastCalledWith('navigate', ['/pricing.html']);
    expect(call.session.sendToolResponse).not.toHaveBeenCalled();

    finishNavigate({ success: true });
    await flush();

    expect(bridge.dispatchAction).toHaveBeenCalledTimes(2);
    expect(bridge.dispatchAction).toHaveBeenLastCalledWith('click', ['#buy']);
    const responseIds = call.session.sendToolResponse.mock.calls.map(
      ([arg]) => arg.functionResponses.id,
    );
    expect(responseIds).toEqual(['nav', 'buy']);
  });

  it('sends no stale tool response when the session is replaced mid-batch', async () => {
    const { liveSession, bridge } = setup();
    const first = await connectAndEstablish(liveSession);
    /** @type {(result: ActionResult) => void} */
    let finishNavigate = () => {};
    bridge.dispatchAction.mockImplementationOnce(
      () => new Promise((resolve) => (finishNavigate = resolve)),
    );

    first.params.callbacks.onmessage({
      toolCall: {
        functionCalls: [
          { id: 'nav', name: 'navigate', args: { route: '/pricing.html' } },
          { id: 'buy', name: 'click', args: { selector: '#buy' } },
        ],
      },
    });
    await flush();

    drop(first);
    await flush();
    const second = live.calls[1];
    await establish(second);

    finishNavigate({ success: true });
    await flush();

    expect(first.session.sendToolResponse).not.toHaveBeenCalled();
    expect(second.session.sendToolResponse).not.toHaveBeenCalled();
    expect(bridge.dispatchAction).toHaveBeenCalledTimes(1); // the rest of the stale batch is dropped
  });

  describe('a snapshot held by a batch whose session is replaced', () => {
    /** @type {(selector: string, label: string) => SnapshotNode} */
    const node = (selector, label) => ({
      selector,
      tag: 'button',
      label,
      disabled: false,
      hidden: false,
    });
    const page = [node('a', 'A'), node('b', 'B'), node('c', 'C')];

    // Starts a navigate that stays in flight, with a snapshot held behind it.
    /**
     * @param {LiveSession} liveSession
     * @param {FakeBridge} bridge
     */
    async function holdASnapshotMidBatch(liveSession, bridge) {
      const first = await connectAndEstablish(liveSession);
      bridge.emitSnapshot({ full: page, changed: page, removed: [] });
      /** @type {(result: ActionResult) => void} */
      let finishNavigate = () => {};
      bridge.dispatchAction.mockImplementationOnce(
        () => new Promise((resolve) => (finishNavigate = resolve)),
      );
      first.params.callbacks.onmessage({
        toolCall: { functionCalls: [{ id: 'nav', name: 'navigate', args: { route: 'settings' } }] },
      });
      await flush();
      bridge.emitSnapshot({ full: page, changed: [node('a', 'A1')], removed: [] }); // held
      return { first, finishNavigate: () => finishNavigate({ success: true }) };
    }

    /** @param {ConnectCall} call */
    async function firstToolResponseOn(call) {
      call.params.callbacks.onmessage({
        toolCall: { functionCalls: [{ id: 'tap', name: 'click', args: { selector: 'b' } }] },
      });
      await flush();
      return call.session.sendToolResponse.mock.calls[0][0].functionResponses;
    }

    it('after a drop: the old session gets no response and the new one no stale page', async () => {
      const { liveSession, bridge } = setup();
      const { first, finishNavigate } = await holdASnapshotMidBatch(liveSession, bridge);

      drop(first);
      await flush();
      const second = live.calls[1];
      await establish(second);
      finishNavigate();
      await flush();

      expect(first.session.sendToolResponse).not.toHaveBeenCalled();
      expect(second.session.sendToolResponse).not.toHaveBeenCalled();
      expect(await firstToolResponseOn(second)).toEqual({
        id: 'tap',
        name: 'click',
        response: { success: true },
      });
    });

    it('after disconnect() and connect(): the same', async () => {
      const { liveSession, bridge } = setup();
      const { first, finishNavigate } = await holdASnapshotMidBatch(liveSession, bridge);

      liveSession.disconnect();
      const second = await connectAndEstablish(liveSession);
      finishNavigate();
      await flush();

      expect(first.session.sendToolResponse).not.toHaveBeenCalled();
      expect(second.session.sendToolResponse).not.toHaveBeenCalled();
      expect(await firstToolResponseOn(second)).toEqual({
        id: 'tap',
        name: 'click',
        response: { success: true },
      });
    });

    it('a snapshot that arrives after the reconnect, during a new batch, does ride along', async () => {
      const { liveSession, bridge } = setup();
      const { first, finishNavigate } = await holdASnapshotMidBatch(liveSession, bridge);
      drop(first);
      await flush();
      const second = live.calls[1];
      await establish(second);
      bridge.emitSnapshot({ full: page, changed: page, removed: [] }); // the reconnect's keyframe
      /** @type {(result: ActionResult) => void} */
      let finishClick = () => {};
      bridge.dispatchAction.mockImplementationOnce(
        () => new Promise((resolve) => (finishClick = resolve)),
      );

      second.params.callbacks.onmessage({
        toolCall: { functionCalls: [{ id: 'tap', name: 'click', args: { selector: 'b' } }] },
      });
      await flush();
      finishNavigate(); // the old batch ends while the new one is still running
      await flush();
      bridge.emitSnapshot({ full: page, changed: [node('b', 'B1')], removed: [] });
      finishClick({ success: true });
      await flush();

      expect(second.session.sendToolResponse.mock.calls).toHaveLength(1);
      expect(second.session.sendToolResponse.mock.calls[0][0].functionResponses).toEqual({
        id: 'tap',
        name: 'click',
        response: { success: true, page: expect.stringMatching(/^Page snapshot \(delta\)/) },
      });
      expect(
        second.session.sendToolResponse.mock.calls[0][0].functionResponses.response.page,
      ).toMatch(/B1/);
    });
  });

  it('connects on v1alpha with the fetched token and the model the token is locked to (M7)', async () => {
    const { liveSession } = setup();
    const call = await connectAndEstablish(liveSession);

    expect(call.options).toEqual({
      apiKey: 'ephemeral-token',
      httpOptions: { apiVersion: 'v1alpha' },
    });
    // server/geminiMint.js constrains the token to this same file's model.
    expect(call.params.model).toBe(LIVE_MODEL.model);
  });

  // Issue #29: the voice is pinned, and every action is a blocking call, so
  // the model waits for its result instead of talking on and answering again
  // once the result lands.
  it('pins the voice and declares every action as a blocking call (#29)', async () => {
    const { liveSession } = setup();
    const call = await connectAndEstablish(liveSession);
    const { config } = call.params;

    expect(config.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } },
    });
    const declarations = defined(config.tools).flatMap((tool) =>
      'functionDeclarations' in tool ? (tool.functionDeclarations ?? []) : [],
    );
    expect(declarations.map((d) => d.name)).toEqual(['click', 'scroll', 'fill', 'navigate']);
    declarations.forEach((declaration) => expect(declaration.behavior).toBe('BLOCKING'));
  });

  it('pins the same voice on a resumed reconnect', async () => {
    const { liveSession } = setup();
    const first = await connectAndEstablish(liveSession);
    first.params.callbacks.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
    });
    drop(first);
    await flush();
    const second = defined(live.calls.at(-1));

    expect(second.params.config.sessionResumption).toEqual({ handle: 'handle-1' });
    expect(second.params.config.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } },
    });
  });

  // `scheduling` applies to NON_BLOCKING calls only (the SDK's
  // FunctionResponse), so a blocking call's response carries none.
  it('answers a blocking call with no scheduling', async () => {
    const { liveSession } = setup();
    const call = await connectAndEstablish(liveSession);
    call.params.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: 'c1', name: 'click', args: { selector: 'x' } }] },
    });
    await flush();

    const [[{ functionResponses }]] = call.session.sendToolResponse.mock.calls;
    expect(functionResponses).not.toHaveProperty('scheduling');
  });

  it('resumes with the stored handle on reconnect and does not greet again', async () => {
    const { liveSession } = setup();
    const first = await connectAndEstablish(liveSession);
    expect(first.params.config.sessionResumption).toEqual({});
    expect(greetings(first.session)).toHaveLength(1);

    first.params.callbacks.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
    });
    drop(first);
    await flush();
    const second = live.calls[1];
    await establish(second);

    expect(second.params.config.sessionResumption).toEqual({ handle: 'handle-1' });
    expect(greetings(second.session)).toHaveLength(0);
  });

  it('reports connecting → open → reconnecting → open, then failed once every attempt is used', async () => {
    const { liveSession, statuses, statusNames } = setup();
    const first = await connectAndEstablish(liveSession);
    drop(first);
    await flush();
    await establish(live.calls[1]);
    await vi.advanceTimersByTimeAsync(5_000); // stable for STABLE_SESSION_MS: the backoff resets

    expect(statusNames()).toEqual(['connecting', 'open', 'reconnecting', 'open']);
    expect(statuses[2]).toMatchObject({ attempt: 1, maxAttempts: MAX_ATTEMPTS });

    // Now every token request fails with a retryable 503.
    fetchMock.mockImplementation(async () =>
      tokenResponse(503, apiError('internal', 'unavailable')),
    );
    drop(live.calls[1]);
    await vi.advanceTimersByTimeAsync(120_000);

    const afterSecondDrop = statuses.slice(4);
    expect(afterSecondDrop.map((s) => s.status)).toEqual([
      ...Array(MAX_ATTEMPTS).fill('reconnecting'),
      'failed',
    ]);
    expect(afterSecondDrop.slice(0, MAX_ATTEMPTS).map((s) => s.attempt)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(statusNames().filter((s) => s === 'failed')).toHaveLength(1);
    expect(defined(statuses.at(-1)).fatal).toBeFalsy(); // exhausted retries can still be retried by hand
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows reconnecting, not failed, while a retry is scheduled after an error', async () => {
    fetchMock.mockImplementationOnce(async () =>
      tokenResponse(503, apiError('internal', 'unavailable')),
    );
    const { liveSession, statusNames } = setup();

    liveSession.connect();
    await flush();

    expect(statusNames()).toEqual(['connecting', 'reconnecting']);
    expect(statusNames()).not.toContain('failed');
  });

  it('blocks the 4th identical call with the loop guard: no dispatch, a failure response', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);
    const sameClick = (/** @type {string} */ id) => ({
      id,
      name: 'click',
      args: { selector: '#buy' },
    });

    call.params.callbacks.onmessage({
      toolCall: { functionCalls: [sameClick('1'), sameClick('2'), sameClick('3'), sameClick('4')] },
    });
    await flush();

    expect(bridge.dispatchAction).toHaveBeenCalledTimes(3);
    const responses = call.session.sendToolResponse.mock.calls.map(
      ([arg]) => arg.functionResponses,
    );
    expect(responses).toHaveLength(4);
    expect(responses[3]).toMatchObject({ id: '4', response: { success: false } });
    expect(responses[3].response.error).toMatch(LOOP_REFUSAL);
  });

  it('a manual connect() after failed resets the attempts and really retries', async () => {
    fetchMock.mockImplementation(async () =>
      tokenResponse(503, apiError('internal', 'unavailable')),
    );
    const { liveSession, statuses, statusNames } = setup();
    liveSession.connect();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(statusNames().at(-1)).toBe('failed');
    const fetchesBeforeRetry = fetchMock.mock.calls.length;
    const statusesBeforeRetry = statuses.length;

    liveSession.connect();
    await flush(); // the manual fetch fails, and so does retry 1 (it runs at 0 ms)

    expect(fetchMock).toHaveBeenCalledTimes(fetchesBeforeRetry + 2);
    expect(statuses.slice(statusesBeforeRetry)).toMatchObject([
      { status: 'connecting' },
      { status: 'reconnecting', attempt: 1 },
      { status: 'reconnecting', attempt: 2 },
    ]);

    fetchMock.mockImplementation(async () => okToken());
    await vi.advanceTimersByTimeAsync(1_000);
    await establish(defined(live.calls.at(-1)));
    expect(statusNames().at(-1)).toBe('open');
  });

  // Decision (case 9): `attempt` resets on the first server message of a
  // session, not on onopen. A socket that opens and closes without the server
  // ever answering must keep climbing the backoff instead of retrying at 0 ms.
  it('does not loop at delay 0 when sockets open and close before any server message', async () => {
    const { liveSession, statuses } = setup();
    liveSession.connect();
    await flush();

    const openThenClose = async () => {
      const call = defined(live.calls.at(-1));
      call.resolve();
      await flush();
      call.params.callbacks.onclose({ code: 1011 });
    };

    await openThenClose(); // → retry 1 at 0 ms
    await flush();
    await openThenClose(); // → retry 2 at 1 s
    await vi.advanceTimersByTimeAsync(999);
    expect(live.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(live.calls).toHaveLength(3);

    const reconnectAttempts = statuses
      .filter((s) => s.status === 'reconnecting')
      .map((s) => s.attempt);
    expect(reconnectAttempts).toEqual([1, 2]);
    expect(statuses.map((s) => s.status)).not.toContain('open'); // the server never answered
  });

  // M6 T6 (the M6 T3 deferral): setupComplete alone no longer resets the
  // backoff. A server that completes setup and then closes every session
  // used to retry at 0 ms forever (bounded only by the token rate limit).
  describe('backoff reset (STABLE_SESSION_MS)', () => {
    const reconnectAttempts = (/** @type {ReturnType<typeof setup>['statuses']} */ statuses) =>
      statuses.filter((s) => s.status === 'reconnecting').map((s) => s.attempt);

    it('keeps climbing when sessions complete setup and then close', async () => {
      const { liveSession, statuses } = setup();
      const setupThenClose = async (/** @type {ConnectCall} */ call) => {
        await establish(call);
        call.params.callbacks.onclose({ code: 1011 });
      };
      await setupThenClose(await connectAndEstablish(liveSession)); // → retry 1 at 0 ms
      await flush();
      await setupThenClose(live.calls[1]); // → retry 2 at 1 s
      await vi.advanceTimersByTimeAsync(999);
      expect(live.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await setupThenClose(live.calls[2]); // → retry 3 at 3 s
      await vi.advanceTimersByTimeAsync(2_999);
      expect(live.calls).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);

      expect(live.calls).toHaveLength(4);
      expect(reconnectAttempts(statuses)).toEqual([1, 2, 3]);
    });

    it('resets once a session has stayed open for STABLE_SESSION_MS, so the next drop retries immediately', async () => {
      const { liveSession, statuses } = setup();
      drop(await connectAndEstablish(liveSession));
      await flush();
      const second = live.calls[1];
      await establish(second);

      await vi.advanceTimersByTimeAsync(5_000);
      drop(second);
      await flush();

      expect(live.calls).toHaveLength(3);
      expect(reconnectAttempts(statuses)).toEqual([1, 1]);
    });

    it('resets on the first real server content, before STABLE_SESSION_MS', async () => {
      const { liveSession, statuses } = setup();
      drop(await connectAndEstablish(liveSession));
      await flush();
      const second = live.calls[1];
      await establish(second);
      second.params.callbacks.onmessage({
        serverContent: { outputTranscription: { text: 'Welcome back.' } },
      });

      drop(second);
      await flush();

      expect(live.calls).toHaveLength(3);
      expect(reconnectAttempts(statuses)).toEqual([1, 1]);
    });

    it('does not reset on a session that drops before STABLE_SESSION_MS with no content', async () => {
      const { liveSession, statuses } = setup();
      drop(await connectAndEstablish(liveSession));
      await flush();
      const second = live.calls[1];
      await establish(second);
      second.params.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
      });

      await vi.advanceTimersByTimeAsync(4_999);
      drop(second);
      await flush();

      expect(reconnectAttempts(statuses)).toEqual([1, 2]);
    });
  });

  // M6 T6 (M4 re-review): live.connect resolves only on setupComplete, so a
  // socket that opens and then hears nothing would sit at `connecting` forever.
  describe('setup timeout (SETUP_TIMEOUT_MS)', () => {
    it('retries an attempt whose server never completes setup, and closes it if it answers late', async () => {
      const { liveSession, statuses, statusNames } = setup();
      liveSession.connect();
      await flush();
      const silent = live.calls[0];

      await vi.advanceTimersByTimeAsync(9_999);
      expect(statusNames()).toEqual(['connecting']);
      await vi.advanceTimersByTimeAsync(1);

      expect(statuses.at(-1)).toMatchObject({ status: 'reconnecting', attempt: 1 });
      expect(defined(statuses.at(-1)).reason).toMatch(/did not answer/i);
      // Retry 1 runs at 0 ms; fake timers run a 0 ms timer set inside another
      // timer's callback 1 ms later.
      await vi.advanceTimersByTimeAsync(1);
      expect(live.calls).toHaveLength(2);

      // The abandoned attempt is a retired generation: closed if it lands late,
      // and its callbacks are ignored.
      silent.resolve();
      await flush();
      expect(silent.session.close).toHaveBeenCalled();
      silent.params.callbacks.onclose({ code: 1006 });
      expect(live.calls).toHaveLength(2);
      await establish(live.calls[1]);
      expect(statusNames().at(-1)).toBe('open');
    });

    it('is cleared once setup completes', async () => {
      const { liveSession, statusNames } = setup();
      await connectAndEstablish(liveSession);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(statusNames()).toEqual(['connecting', 'open']);
      expect(live.calls).toHaveLength(1);
    });

    it('is cleared by a disconnect', async () => {
      const { liveSession, statusNames } = setup();
      liveSession.connect();
      await flush();
      liveSession.disconnect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(statusNames()).toEqual(['connecting', 'closed']);
      expect(live.calls).toHaveLength(1);
    });
  });

  it("echoes the page nonce on the token request, and reports the server's error message", async () => {
    fetchMock.mockImplementationOnce(async () =>
      tokenResponse(503, apiError('internal', 'Internal server error')),
    );
    const { liveSession, statuses } = setup();

    liveSession.connect();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/live-token?nonce=page-nonce');
    expect(defined(statuses.find((s) => s.status === 'reconnecting')).reason).toBe(
      'Internal server error',
    );
  });

  it('fails immediately on a 4xx token response, tells the user to reload, and schedules no retry', async () => {
    fetchMock.mockImplementation(async () =>
      tokenResponse(403, apiError('invalid_nonce', 'Unknown or expired nonce')),
    );
    const { liveSession, statuses, statusNames } = setup();

    liveSession.connect();
    await flush();

    expect(statusNames()).toEqual(['connecting', 'failed']);
    expect(defined(statuses.at(-1)).reason).toMatch(/reload/i);
    expect(defined(statuses.at(-1)).fatal).toBe('token'); // a reload gets a fresh nonce
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries 5xx and network errors', async () => {
    fetchMock
      .mockImplementationOnce(async () =>
        tokenResponse(500, apiError('internal', 'Internal server error')),
      )
      .mockImplementationOnce(async () => {
        throw new TypeError('Failed to fetch');
      });
    const { liveSession, statusNames } = setup();

    liveSession.connect();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(statusNames()).toEqual(['connecting', 'reconnecting', 'reconnecting']);
    expect(live.calls).toHaveLength(1);
  });

  // server/app.js answers a mint the voice service didn't answer (a 5xx,
  // quota, network) with 502 upstream_error: worth retrying.
  it('retries a 502 upstream_error token response', async () => {
    fetchMock.mockImplementationOnce(async () =>
      tokenResponse(502, apiError('upstream_error', 'The voice service did not answer')),
    );
    const { liveSession, statuses, statusNames } = setup();

    liveSession.connect();
    await flush();

    expect(statusNames()).toEqual(['connecting', 'reconnecting']);
    expect(defined(statuses.at(-1)).fatal).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await establish(live.calls[0]);
    expect(statusNames().at(-1)).toBe('open');
  });

  // Found by the checkJs pass: the token went unchecked into `new GoogleGenAI`,
  // which sits outside openSession's try, so a throw there left the status at
  // `connecting` with an unhandled rejection instead of retrying.
  it('treats a 200 token response without a token as a retryable failure', async () => {
    fetchMock.mockImplementationOnce(async () => tokenResponse(200, {}));
    const { liveSession, statuses, statusNames } = setup();

    liveSession.connect();
    await flush();

    expect(statusNames()).toEqual(['connecting', 'reconnecting']);
    expect(defined(statuses.at(-1)).reason).toBe('The token response had no token.');
    // Only the immediate retry, with a real token, reached live.connect.
    expect(live.calls.map((call) => call.options.apiKey)).toEqual(['ephemeral-token']);
  });

  it('dispose() unsubscribes everything and closes the session, but never the bridge channel', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);
    setRules('Be brief.');
    const contextSendsBefore = call.session.sendClientContent.mock.calls.length;

    liveSession.dispose();
    setRules('Be very brief.');

    expect(bridge.unsubscribeSnapshot).toHaveBeenCalledTimes(1);
    expect(bridge.unsubscribeNavigated).toHaveBeenCalledTimes(1);
    expect(call.session.close).toHaveBeenCalled();
    expect(call.session.sendClientContent).toHaveBeenCalledTimes(contextSendsBefore);
    expect(bridge.close).not.toHaveBeenCalled();
  });
  // The SDK is a chunk of its own, loaded on Talk (liveSdk.js). A chunk that
  // didn't arrive (the network, a page older than the deploy) fails the
  // attempt at once: the backoff is for the voice socket, and spending a
  // minute of retries on a missing file would only hide it.
  it('fails at once with a Retry when the SDK chunk does not load, and loads it on the next connect()', async () => {
    vi.mocked(loadLiveSdk).mockRejectedValueOnce(
      new SdkLoadError(new TypeError('Failed to fetch')),
    );
    const { liveSession, statuses, statusNames } = setup();

    liveSession.connect();
    await flush();

    expect(statusNames()).toEqual(['connecting', 'failed']);
    expect(statuses.at(-1)).toMatchObject({
      reason:
        "The voice client couldn't load. Check your connection, then retry or reload the page.",
      fatal: 'sdk', // not a reload: Retry imports the chunk again
    });
    expect(live.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    liveSession.connect();
    await flush();
    await establish(live.calls[0]);
    expect(statusNames().at(-1)).toBe('open');
  });

  it('asks for the token while the SDK chunk is still loading, not after it', async () => {
    /** @type {(sdk: import('../liveSdk.js').LiveSdk) => void} */
    let finishLoad = () => {};
    const realLoad = defined(vi.mocked(loadLiveSdk).getMockImplementation(), 'the real loader');
    vi.mocked(loadLiveSdk).mockImplementationOnce(
      () => new Promise((resolve) => (finishLoad = resolve)),
    );
    const { liveSession, statusNames } = setup();

    liveSession.connect();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(live.calls).toHaveLength(0);

    finishLoad(await realLoad());
    await flush();
    await establish(live.calls[0]);
    expect(statusNames()).toEqual(['connecting', 'open']);
  });

  it('treats a not_configured server error as a fatal config failure, with a contact-the-owner reason', async () => {
    fetchMock.mockImplementation(async () =>
      tokenResponse(500, apiError('not_configured', "The server isn't configured to connect")),
    );
    const { liveSession, statuses, statusNames } = setup();

    liveSession.connect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(statusNames()).toEqual(['connecting', 'failed']);
    expect(statuses.at(-1)).toMatchObject({
      // A server restart (often how the key gets fixed) wipes its nonces, so
      // Try again may turn into Reload page: the reason says so.
      reason:
        "The server isn't configured to connect. Contact the site owner, then try again (you may need to reload the page).",
      fatal: 'config', // a reload can't help; asking the server again can, once it's fixed
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports open on the first server message, not when the socket opens', async () => {
    const { liveSession, statusNames } = setup();
    liveSession.connect();
    await flush();
    const call = live.calls[0];

    call.resolve();
    await flush();
    expect(statusNames()).toEqual(['connecting']);

    call.params.callbacks.onmessage({ setupComplete: {} });
    call.params.callbacks.onmessage({ serverContent: {} });
    expect(statusNames()).toEqual(['connecting', 'open']);
  });

  it('a manual disconnect() followed by a late onclose does not reconnect and stays closed', async () => {
    const { liveSession, statusNames } = setup();
    const call = await connectAndEstablish(liveSession);

    liveSession.disconnect();
    drop(call);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(statusNames().at(-1)).toBe('closed');
    expect(statusNames()).not.toContain('reconnecting');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(live.calls).toHaveLength(1);
  });

  it('asks the bridge for a snapshot on every (re)connect and sends the next one as a keyframe', async () => {
    const { liveSession, bridge } = setup();
    /** @type {SnapshotNode[]} */
    const page = [1, 2, 3, 4, 5].map((n) => ({
      selector: `n${n}`,
      tag: 'button',
      label: `${n}`,
      disabled: false,
      hidden: false,
    }));
    const smallDelta = { full: page, changed: [page[0]], removed: [] };
    const snapshotTexts = (/** @type {FakeSession} */ session) =>
      session.sendClientContent.mock.calls
        .map(([arg]) => arg.turns)
        .filter((t) => t.startsWith('Page snapshot'));

    const first = await connectAndEstablish(liveSession);
    expect(bridge.requestSnapshot).toHaveBeenCalledTimes(1);
    bridge.emitSnapshot({ full: page, changed: page, removed: [] });
    bridge.emitSnapshot(smallDelta);
    expect(snapshotTexts(first.session)).toEqual([
      expect.stringMatching(/^Page snapshot \(full\)/),
      expect.stringMatching(/^Page snapshot \(delta\)/),
    ]);

    drop(first);
    await flush();
    const second = live.calls[1];
    await establish(second);
    expect(bridge.requestSnapshot).toHaveBeenCalledTimes(2);

    bridge.emitSnapshot(smallDelta); // a small delta, but the reconnect forces a keyframe
    expect(snapshotTexts(second.session)).toEqual([
      expect.stringMatching(/^Page snapshot \(full\)/),
    ]);
  });

  it('buffers audio sent while connecting and flushes the newest 20 frames once connected', async () => {
    const { liveSession } = setup();
    liveSession.connect();
    await flush();
    const frames = Array.from({ length: 25 }, (_, i) => `frame-${i}`);
    frames.forEach((frame) => liveSession.sendAudioFrame(frame));

    const call = live.calls[0];
    expect(call.session.sendRealtimeInput).not.toHaveBeenCalled();
    call.resolve();
    await flush();

    const sent = call.session.sendRealtimeInput.mock.calls.map(([arg]) => arg.audio.data);
    expect(sent).toEqual(frames.slice(5));
  });

  it('resets the loop guard on a manual connect()', async () => {
    const { liveSession, bridge } = setup();
    const sameClick = (/** @type {string} */ id) => ({
      id,
      name: 'click',
      args: { selector: '#buy' },
    });
    const first = await connectAndEstablish(liveSession);
    first.params.callbacks.onmessage({
      toolCall: { functionCalls: [sameClick('1'), sameClick('2'), sameClick('3')] },
    });
    await flush();
    expect(bridge.dispatchAction).toHaveBeenCalledTimes(3);

    liveSession.disconnect();
    const second = await connectAndEstablish(liveSession);
    second.params.callbacks.onmessage({ toolCall: { functionCalls: [sameClick('4')] } });
    await flush();

    expect(bridge.dispatchAction).toHaveBeenCalledTimes(4);
    expect(second.session.sendToolResponse.mock.calls[0][0].functionResponses.response).toEqual({
      success: true,
    });
  });

  it('drops the resumption handle when a resumed attempt closes before the server answers', async () => {
    const { liveSession } = setup();
    const first = await connectAndEstablish(liveSession);
    first.params.callbacks.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: 'stale-handle' },
    });
    drop(first);
    await flush();

    const resumed = live.calls[1];
    expect(resumed.params.config.sessionResumption).toEqual({ handle: 'stale-handle' });
    resumed.resolve();
    await flush();
    resumed.params.callbacks.onclose({ code: 1008 }); // the server rejected the handle

    await vi.advanceTimersByTimeAsync(1_000);
    const fresh = live.calls[2];
    expect(fresh.params.config.sessionResumption).toEqual({});
    await establish(fresh);
    expect(greetings(fresh.session)).toHaveLength(1);
  });

  // M6 T6 (M4 re-review): only the server rejecting the handle clears it. A
  // resumed attempt that fails on the network says nothing about the handle.
  describe('a resumed attempt that fails on the network keeps the handle', () => {
    async function resumedAttempt() {
      const { liveSession } = setup();
      const first = await connectAndEstablish(liveSession);
      first.params.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
      });
      drop(first);
      await flush();
      const resumed = live.calls[1];
      expect(resumed.params.config.sessionResumption).toEqual({ handle: 'handle-1' });
      return resumed;
    }

    it.each([
      [
        'a socket error and an abnormal close (1006)',
        (/** @type {ConnectCall} */ call) => drop(call),
      ],
      [
        'live.connect rejecting',
        (/** @type {ConnectCall} */ call) => call.reject(new TypeError('network')),
      ],
      [
        'a going-away close (1001)',
        (/** @type {ConnectCall} */ call) => call.params.callbacks.onclose({ code: 1001 }),
      ],
      // m4: Gemini's internal error says nothing against the handle either.
      [
        'an internal-error close (1011)',
        (/** @type {ConnectCall} */ call) => call.params.callbacks.onclose({ code: 1011 }),
      ],
    ])('%s', async (_name, fail) => {
      const resumed = await resumedAttempt();
      fail(resumed);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(live.calls[2].params.config.sessionResumption).toEqual({ handle: 'handle-1' });
    });

    it('the setup timeout', async () => {
      await resumedAttempt();
      await vi.advanceTimersByTimeAsync(10_000 + 1_000);
      expect(live.calls[2].params.config.sessionResumption).toEqual({ handle: 'handle-1' });
    });
  });

  it('keeps the resumption handle when the server refuses a resume because the old client is still attached', async () => {
    const { liveSession } = setup();
    const first = await connectAndEstablish(liveSession);
    first.params.callbacks.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
    });
    drop(first);
    await flush();

    const early = live.calls[1];
    early.resolve();
    await flush();
    // What Gemini answers an immediate resume with (seen in the live e2e).
    early.params.callbacks.onclose({
      code: 1008,
      reason: 'BidiGenerateContent session is already connected to an existing client',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const retried = live.calls[2];
    expect(retried.params.config.sessionResumption).toEqual({ handle: 'handle-1' });
    await establish(retried);
    expect(greetings(retried.session)).toHaveLength(0);
  });

  // M6 T5: the generic 1 s backoff made a two-attempt recovery 2.8–3.4 s in
  // the live e2e; a still-attached refusal retries after 400 ms, then 800 ms…
  it('retries a still-attached refusal after 400 ms, then 800 ms, and any other close on the usual backoff', async () => {
    const { liveSession } = setup();
    const first = await connectAndEstablish(liveSession);
    first.params.callbacks.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
    });
    drop(first);
    await flush();
    const refuse = async (/** @type {ConnectCall} */ call) => {
      call.resolve();
      await flush();
      call.params.callbacks.onclose({
        code: 1008,
        reason: 'BidiGenerateContent session is already connected to an existing client',
      });
    };

    await refuse(live.calls[1]);
    await vi.advanceTimersByTimeAsync(399);
    expect(live.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(live.calls).toHaveLength(3);

    await refuse(live.calls[2]);
    await vi.advanceTimersByTimeAsync(799);
    expect(live.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(live.calls).toHaveLength(4);
    expect(live.calls[3].params.config.sessionResumption).toEqual({ handle: 'handle-1' });

    // A plain failure on the next attempt waits the usual 7 s (attempt 4).
    live.calls[3].reject(new Error('network'));
    await vi.advanceTimersByTimeAsync(6_999);
    expect(live.calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(live.calls).toHaveLength(5);
  });

  // m4: only a resume can be refused for a still-attached client; on a fresh
  // attempt the text means nothing, and the usual backoff applies.
  it('treats a still-attached close of a fresh (not resumed) attempt as a plain failure', async () => {
    fetchMock.mockImplementationOnce(async () =>
      tokenResponse(503, apiError('internal', 'unavailable')),
    );
    const { liveSession } = setup();
    liveSession.connect();
    await flush(); // attempt 1 fails at once; its retry is immediate
    const fresh = live.calls[0];
    expect(fresh.params.config.sessionResumption).toEqual({});
    fresh.resolve();
    await flush();
    fresh.params.callbacks.onclose({
      code: 1008,
      reason: 'BidiGenerateContent session is already connected to an existing client',
    });

    await vi.advanceTimersByTimeAsync(400);
    expect(live.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(live.calls).toHaveLength(2);
  });

  describe('knowledge on a reconnect (M9)', () => {
    const knowledgeSends = (/** @type {FakeSession} */ session) =>
      session.sendClientContent.mock.calls.filter(([arg]) =>
        String(arg.turns).startsWith('STRICT RULES'),
      );

    /**
     * @param {ConnectCall} first
     * @param {{ handle?: boolean }} [options]
     */
    async function dropAndReconnect(first, { handle = true } = {}) {
      if (handle) {
        first.params.callbacks.onmessage({
          sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
        });
      }
      drop(first);
      // The backoff hasn't reset (no STABLE_SESSION_MS, no content), so a
      // second drop's retry waits 1 s.
      await vi.advanceTimersByTimeAsync(1_000);
      const second = defined(live.calls.at(-1));
      await establish(second);
      return second;
    }

    it('sends it on a fresh session, and not again on a resumed one', async () => {
      setRules('Be brief.');
      const { liveSession } = setup();
      const first = await connectAndEstablish(liveSession);
      expect(knowledgeSends(first.session)).toHaveLength(1);

      const resumed = await dropAndReconnect(first);
      expect(resumed.params.config.sessionResumption).toEqual({ handle: 'handle-1' });
      expect(knowledgeSends(resumed.session)).toHaveLength(0);
    });

    it('sends it on a reconnect that starts a fresh session (no handle)', async () => {
      setRules('Be brief.');
      const { liveSession } = setup();
      const first = await connectAndEstablish(liveSession);
      const fresh = await dropAndReconnect(first, { handle: false });
      expect(knowledgeSends(fresh.session)).toHaveLength(1);
    });

    it('sends it on a resumed session when it changed while no session was up', async () => {
      setRules('Be brief.');
      const { liveSession } = setup();
      const first = await connectAndEstablish(liveSession);
      first.params.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
      });
      drop(first);
      setRules('Be very brief.');
      await flush();
      const resumed = defined(live.calls.at(-1));
      await establish(resumed);
      expect(knowledgeSends(resumed.session).map(([arg]) => arg.turns)).toEqual([
        'STRICT RULES (must always follow):\nBe very brief.',
      ]);

      // Sent once: the next resume has nothing new to send.
      const again = await dropAndReconnect(resumed);
      expect(knowledgeSends(again.session)).toHaveLength(0);
    });

    // m3: a handle restores the session as it was when the handle was issued,
    // so knowledge sent after that isn't in the resumed session.
    it('resends it on a resume when it changed after the handle in use was issued', async () => {
      setRules('Be brief.');
      const { liveSession } = setup();
      const first = await connectAndEstablish(liveSession);
      first.params.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
      });
      setRules('Be very brief.'); // sent into the live session, after handle-1
      expect(knowledgeSends(first.session)).toHaveLength(2);

      const resumed = await dropAndReconnect(first, { handle: false });
      expect(resumed.params.config.sessionResumption).toEqual({ handle: 'handle-1' });
      expect(knowledgeSends(resumed.session).map(([arg]) => arg.turns)).toEqual([
        'STRICT RULES (must always follow):\nBe very brief.',
      ]);
    });

    it('does not resend it when a newer handle was issued after the change', async () => {
      setRules('Be brief.');
      const { liveSession } = setup();
      const first = await connectAndEstablish(liveSession);
      first.params.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
      });
      setRules('Be very brief.');
      const resumed = await dropAndReconnect(first); // handle-1 reissued after the change
      expect(knowledgeSends(resumed.session)).toHaveLength(0);
    });
  });

  it('drops the resumption handle when a close that is not 1008 carries the still-attached text', async () => {
    const { liveSession } = setup();
    const first = await connectAndEstablish(liveSession);
    first.params.callbacks.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
    });
    drop(first);
    await flush();

    const early = live.calls[1];
    early.resolve();
    await flush();
    early.params.callbacks.onclose({
      code: 1007,
      reason: 'BidiGenerateContent session is already connected to an existing client',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(live.calls[2].params.config.sessionResumption).toEqual({});
  });

  it('sends a snapshot that arrives mid-batch inside the next tool response, as a keyframe when several were held', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);
    /** @type {(selector: string, label: string) => SnapshotNode} */
    const node = (selector, label) => ({
      selector,
      tag: 'button',
      label,
      disabled: false,
      hidden: false,
    });
    const page = [node('a', 'A'), node('b', 'B'), node('c', 'C'), node('d', 'D')];
    bridge.emitSnapshot({ full: page, changed: page, removed: [] }); // the first keyframe
    const snapshotMessages = () =>
      call.session.sendClientContent.mock.calls.filter(([arg]) =>
        arg.turns.startsWith('Page snapshot'),
      );
    expect(snapshotMessages()).toHaveLength(1);
    /** @type {((result: ActionResult) => void)[]} */
    const finishers = [];
    bridge.dispatchAction.mockImplementation(
      () => new Promise((resolve) => finishers.push(resolve)),
    );

    call.params.callbacks.onmessage({
      toolCall: {
        functionCalls: [
          { id: 'nav', name: 'navigate', args: { route: 'settings' } },
          { id: 'tap', name: 'click', args: { selector: 'a' } },
        ],
      },
    });
    await flush();
    // Two small deltas while the navigate is in flight: neither goes out alone.
    bridge.emitSnapshot({ full: page, changed: [node('a', 'A1')], removed: [] });
    bridge.emitSnapshot({ full: page, changed: [node('b', 'B1')], removed: [] });
    finishers[0]({ success: true });
    await flush();
    // One while the click is in flight.
    bridge.emitSnapshot({ full: page, changed: [node('c', 'C1')], removed: [] });
    finishers[1]({ success: true });
    await flush();

    expect(snapshotMessages()).toHaveLength(1);
    const responses = call.session.sendToolResponse.mock.calls.map(
      ([arg]) => arg.functionResponses,
    );
    // The first carries a keyframe: a lone delta would lose what the first
    // held one changed. The second is a plain delta again.
    expect(responses).toEqual([
      {
        id: 'nav',
        name: 'navigate',
        response: {
          success: true,
          page: expect.stringMatching(/^Page snapshot \(full\)/),
        },
      },
      {
        id: 'tap',
        name: 'click',
        response: { success: true, page: expect.stringMatching(/^Page snapshot \(delta\)/) },
      },
    ]);
  });

  // bridge.js posts each successful action's settled snapshot just before its
  // result (#25): every call of a batch answers with the page it left. This
  // passed before #25 too: it guards liveSession's half of the contract (one
  // held snapshot per call, a delta each); bridge.test.js and e2e/loop.spec.js
  // prove the bridge's half, the fix itself.
  it('answers each call of a batch with its own page, a delta of what that call changed', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);
    /** @type {(value: number) => SnapshotNode} */
    const counter = (value) => ({
      selector: 'counter-value',
      tag: 'span',
      label: String(value),
      disabled: false,
      hidden: false,
    });
    /** @type {SnapshotNode} */
    const button = {
      selector: 'counter-increment',
      tag: 'button',
      label: 'Increment',
      disabled: false,
      hidden: false,
    };
    const pageAt = (/** @type {number} */ value) => [counter(value), button];
    bridge.emitSnapshot({ full: pageAt(0), changed: pageAt(0), removed: [] }); // the first keyframe
    let value = 0;
    bridge.dispatchAction.mockImplementation(async () => {
      value += 1;
      bridge.emitSnapshot({ full: pageAt(value), changed: [counter(value)], removed: [] });
      return { success: true };
    });

    const clicks = [1, 2, 3].map((n) => ({
      id: `inc-${n}`,
      name: 'click',
      args: { selector: 'counter-increment' },
    }));
    call.params.callbacks.onmessage({ toolCall: { functionCalls: clicks } });
    await flush();

    const responses = call.session.sendToolResponse.mock.calls.map(
      ([arg]) => arg.functionResponses,
    );
    expect(responses.map((r) => r.id)).toEqual(['inc-1', 'inc-2', 'inc-3']);
    expect(responses.map((r) => r.response.page)).toEqual(
      [1, 2, 3].map(
        (n) => `Page snapshot (delta) — changed:\n${JSON.stringify([counter(n)])}\nremoved:\n[]`,
      ),
    );
    // Nothing went out on its own: each snapshot rode in its call's response.
    const standalone = call.session.sendClientContent.mock.calls.filter(([arg]) =>
      arg.turns.startsWith('Page snapshot'),
    );
    expect(standalone).toHaveLength(1);
  });

  it('answers a tool call without a page when no snapshot arrived during it', async () => {
    const { liveSession } = setup();
    const call = await connectAndEstablish(liveSession);

    call.params.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: 'tap', name: 'click', args: { selector: 'a' } }] },
    });
    await flush();

    expect(call.session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: { id: 'tap', name: 'click', response: { success: true } },
    });
  });

  it('a sendToolResponse that throws on a closing socket is handled, not an unhandled rejection', async () => {
    const { liveSession, statusNames } = setup();
    const call = await connectAndEstablish(liveSession);
    call.session.sendToolResponse.mockImplementation(() => {
      throw new Error('WebSocket is already in CLOSING or CLOSED state.');
    });

    call.params.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: '1', name: 'click', args: { selector: '#buy' } }] },
    });
    await flush();

    expect(statusNames().at(-1)).toBe('reconnecting');
  });
});

// The opt-in live e2e reads these off the page's performance timeline
// (e2e/live.spec.js, docs/metrics/README.md). Fake timers fake `performance`
// too, so the calls are read off a spy rather than the timeline.
describe('timing marks', () => {
  /** @type {MockInstance<Performance['mark']>} */
  let markSpy;
  const dsMarks = () =>
    markSpy.mock.calls
      .filter(([name]) => name.startsWith('ds:'))
      .map(([name, options]) => ({ name, detail: options?.detail }));
  const markNames = () => dsMarks().map((entry) => entry.name);

  beforeEach(() => {
    markSpy = vi.spyOn(performance, 'mark');
  });

  afterEach(() => markSpy.mockRestore());

  it('marks connect-start, open on the first server message, and only the first audio chunk', async () => {
    const { liveSession } = setup();
    liveSession.connect();
    await flush();
    expect(markNames()).toEqual(['ds:connect-start']);

    const call = defined(live.calls.at(-1));
    await establish(call);
    call.params.callbacks.onmessage({ data: 'AAAA' });
    call.params.callbacks.onmessage({ data: 'BBBB' });

    expect(markNames()).toEqual(['ds:connect-start', 'ds:open', 'ds:first-audio']);
  });

  it('marks the start and end of each tool call with its id, name and outcome', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);
    bridge.dispatchAction
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'not found' });
    markSpy.mockClear();

    call.params.callbacks.onmessage({
      toolCall: {
        functionCalls: [
          { id: 'nav', name: 'navigate', args: { route: 'settings' } },
          { id: 'tap', name: 'click', args: { selector: 'missing' } },
        ],
      },
    });
    await flush();

    expect(dsMarks()).toEqual([
      { name: 'ds:tool-start:nav', detail: { name: 'navigate' } },
      { name: 'ds:tool-end:nav', detail: { name: 'navigate', success: true } },
      { name: 'ds:tool-start:tap', detail: { name: 'click' } },
      { name: 'ds:tool-end:tap', detail: { name: 'click', success: false } },
    ]);
  });

  // Marks live in a page-lifetime buffer; a tool mark per call would grow it
  // without bound. They are cleared on disconnect(), never mid-session: the
  // live e2e reads them after its scenario, while the session is still open.
  it('clears its marks on disconnect(), and not before', async () => {
    const clearSpy = vi.spyOn(performance, 'clearMarks');
    try {
      const { liveSession } = setup();
      const call = await connectAndEstablish(liveSession);
      call.params.callbacks.onmessage({
        toolCall: { functionCalls: [{ id: 'tap', name: 'click', args: { selector: 'a' } }] },
      });
      await flush();
      expect(clearSpy).not.toHaveBeenCalled();

      liveSession.disconnect();

      const cleared = clearSpy.mock.calls.map(([name]) => name);
      expect(cleared.sort()).toEqual(
        ['ds:connect-start', 'ds:open', 'ds:tool-end:tap', 'ds:tool-start:tap'].sort(),
      );
    } finally {
      clearSpy.mockRestore();
    }
  });

  it('marks each keyframe with its UTF-8 size and node count, and no delta', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);
    /** @type {(selector: string, label: string) => SnapshotNode} */
    const node = (selector, label) => ({
      selector,
      tag: 'button',
      label,
      disabled: false,
      hidden: false,
    });
    const first = [node('a', 'Añadir'), node('b', 'B'), node('c', 'C')];
    bridge.emitSnapshot({ full: first, changed: first, removed: [] });
    const changedB = node('b', 'B2');
    bridge.emitSnapshot({ full: [first[0], changedB, first[2]], changed: [changedB], removed: [] });

    const keyframes = dsMarks().filter((entry) => entry.name === 'ds:keyframe');
    expect(keyframes).toHaveLength(1);
    const sent = defined(
      call.session.sendClientContent.mock.calls
        .map(([arg]) => arg.turns)
        .find((turns) => turns.startsWith('Page snapshot (full)')),
      'the keyframe turn',
    );
    expect(keyframes[0].detail).toEqual({
      bytes: new TextEncoder().encode(sent).length,
      nodes: 3,
    });
    // 'ñ' is two bytes: the size is bytes on the wire, not characters.
    expect(keyframes[0].detail.bytes).toBe(sent.length + 1);
  });

  it('marks every loop-guard trip with its kind, and nothing for calls it lets through', async () => {
    const { liveSession } = setup();
    const call = await connectAndEstablish(liveSession);
    const sameClick = (/** @type {string} */ id) => ({
      id,
      name: 'click',
      args: { selector: '#buy' },
    });
    call.params.callbacks.onmessage({
      toolCall: { functionCalls: [sameClick('1'), sameClick('2'), sameClick('3')] },
    });
    await flush();
    expect(markNames()).not.toContain('ds:loop-trip');

    call.params.callbacks.onmessage({ toolCall: { functionCalls: [sameClick('4')] } });
    await flush();
    const sentence = 'I will now open the settings page for you.';
    for (let turn = 0; turn < 3; turn += 1) {
      call.params.callbacks.onmessage({
        serverContent: { outputTranscription: { text: sentence } },
      });
      call.params.callbacks.onmessage({ serverContent: { turnComplete: true } });
    }

    expect(dsMarks().filter((entry) => entry.name === 'ds:loop-trip')).toEqual([
      { name: 'ds:loop-trip', detail: { kind: 'action' } },
      { name: 'ds:loop-trip', detail: { kind: 'utterance' } },
    ]);
  });

  it('marks the knowledge context it sends with its size, and nothing when there is none', async () => {
    const { liveSession } = setup();
    await connectAndEstablish(liveSession);
    expect(markNames()).not.toContain('ds:knowledge');

    setRules('Be brief.');
    const knowledge = dsMarks().filter((entry) => entry.name === 'ds:knowledge');
    expect(knowledge).toEqual([
      {
        name: 'ds:knowledge',
        detail: { bytes: 'STRICT RULES (must always follow):\nBe brief.'.length },
      },
    ]);
  });

  it('marks reconnected when a dropped session is open again, not on a first or manual connect', async () => {
    const { liveSession } = setup();
    const first = await connectAndEstablish(liveSession);
    expect(markNames()).not.toContain('ds:reconnected');

    drop(first);
    await flush();
    await establish(live.calls[1]);
    expect(markNames().filter((name) => name === 'ds:reconnected')).toHaveLength(1);
    expect(markNames().at(-1)).toBe('ds:reconnected');

    liveSession.disconnect();
    markSpy.mockClear();
    await connectAndEstablish(liveSession);
    expect(markNames()).toEqual(['ds:connect-start', 'ds:open']);
  });
});

describe('createLiveSession: loop guard', () => {
  // #28: two rounds of A-B can be the request; the third is refused.
  it('dispatches home, settings, home, settings and refuses the third round', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);
    const go = (/** @type {string} */ id, /** @type {string} */ route) => ({
      id,
      name: 'navigate',
      args: { route },
    });
    const routes = ['home', 'settings', 'home', 'settings', 'home', 'settings'];

    call.params.callbacks.onmessage({
      toolCall: { functionCalls: routes.map((route, i) => go(String(i + 1), route)) },
    });
    await flush();

    expect(bridge.dispatchAction).toHaveBeenCalledTimes(5);
    const responses = call.session.sendToolResponse.mock.calls.map(
      ([arg]) => arg.functionResponses,
    );
    expect(responses.map((r) => r.response.success)).toEqual([true, true, true, true, true, false]);
    expect(responses[5]).toMatchObject({ id: '6', response: { success: false } });
    expect(responses[5].response.error).toMatch(LOOP_REFUSAL);
  });

  // #25: an action is judged on the page it was taken on (the latest full
  // snapshot), so identical clicks that move the counter on are progress.
  describe('the page an action is taken on', () => {
    /** @type {(value: number) => SnapshotNode} */
    const counter = (value) => ({
      selector: 'counter-value',
      tag: 'span',
      label: String(value),
      disabled: false,
      hidden: false,
    });
    /** @type {SnapshotNode} */
    const button = {
      selector: 'counter-increment',
      tag: 'button',
      label: 'Increment',
      disabled: false,
      hidden: false,
    };
    const pageAt = (/** @type {number} */ value) => [counter(value), button];
    const clicks = (/** @type {number} */ count) =>
      Array.from({ length: count }, (_, i) => ({
        id: `inc-${i + 1}`,
        name: 'click',
        args: { selector: 'counter-increment' },
      }));
    const responsesOf = (/** @type {ConnectCall} */ call) =>
      call.session.sendToolResponse.mock.calls.map(([arg]) => arg.functionResponses);
    /** @type {MockInstance<Performance['mark']>} */
    let markSpy;
    const loopTrips = () =>
      markSpy.mock.calls
        .filter(([name]) => name === 'ds:loop-trip')
        .map(([, options]) => options?.detail);

    beforeEach(() => {
      markSpy = vi.spyOn(performance, 'mark');
    });

    afterEach(() => markSpy.mockRestore());

    /**
     * A bridge whose click settles on the counter moved on by `step`, sent
     * before the result, as bridge.js does.
     * @param {number} step 1 for a working button, 0 for one that does nothing.
     */
    async function sessionWithCounter(step) {
      const { liveSession, bridge } = setup();
      const call = await connectAndEstablish(liveSession);
      bridge.emitSnapshot({ full: pageAt(0), changed: pageAt(0), removed: [] }); // the keyframe
      let value = 0;
      bridge.dispatchAction.mockImplementation(async () => {
        value += step;
        bridge.emitSnapshot({
          full: pageAt(value),
          changed: step ? [counter(value)] : [],
          removed: [],
        });
        return { success: true };
      });
      return { call, bridge };
    }

    it('dispatches a batch of 10 counter clicks that each move the counter on', async () => {
      const { call, bridge } = await sessionWithCounter(1);
      call.params.callbacks.onmessage({ toolCall: { functionCalls: clicks(10) } });
      await flush();

      expect(bridge.dispatchAction).toHaveBeenCalledTimes(10);
      const responses = responsesOf(call);
      expect(responses.map((r) => r.response.success)).toEqual(Array(10).fill(true));
      expect(responses.some((r) => 'error' in r.response)).toBe(false);
      expect(loopTrips()).toEqual([]);
    });

    it('refuses the 4th identical click on a page it leaves unchanged', async () => {
      const { call, bridge } = await sessionWithCounter(0);
      call.params.callbacks.onmessage({ toolCall: { functionCalls: clicks(4) } });
      await flush();

      expect(bridge.dispatchAction).toHaveBeenCalledTimes(3);
      const responses = responsesOf(call);
      expect(responses.map((r) => r.response.success)).toEqual([true, true, true, false]);
      expect(responses[3].response.error).toMatch(LOOP_REFUSAL);
    });

    it('judges the first call of a new batch on the page the last batch left', async () => {
      const { call, bridge } = await sessionWithCounter(0);
      call.params.callbacks.onmessage({ toolCall: { functionCalls: clicks(3) } });
      await flush();
      call.params.callbacks.onmessage({ toolCall: { functionCalls: clicks(1) } });
      await flush();

      expect(bridge.dispatchAction).toHaveBeenCalledTimes(3);
      expect(defined(responsesOf(call).at(-1)).response).toMatchObject({ success: false });
    });

    // #25 review: the save confirmation stays and the toggle alternates, so
    // toggle, save, toggle, save never meets the same page twice; the bare
    // actions' A-B cycle catches it. #28: two rounds ("notifications on and
    // save, then off and save") are a request; the third round is refused.
    it('dispatches on, save, off, save and refuses toggle, save on its third round', async () => {
      const { liveSession, bridge } = setup();
      const call = await connectAndEstablish(liveSession);
      const app = { checked: false, saved: false };
      const settingsPage = () => [
        {
          selector: 'notifications-toggle',
          tag: 'input',
          label: 'Enable notifications',
          disabled: false,
          hidden: false,
          checked: app.checked,
        },
        {
          selector: 'save-confirmation',
          tag: 'p',
          label: 'Saved',
          disabled: false,
          hidden: !app.saved,
        },
      ];
      bridge.emitSnapshot({ full: settingsPage(), changed: settingsPage(), removed: [] });
      bridge.dispatchAction.mockImplementation(async (_name, [selector]) => {
        if (selector === 'notifications-toggle') app.checked = !app.checked;
        else app.saved = true;
        bridge.emitSnapshot({ full: settingsPage(), changed: settingsPage(), removed: [] });
        return { success: true };
      });
      const toggle = (/** @type {string} */ id) => ({
        id,
        name: 'click',
        args: { selector: 'notifications-toggle' },
      });
      const save = (/** @type {string} */ id) => ({
        id,
        name: 'click',
        args: { selector: 'save-button' },
      });

      call.params.callbacks.onmessage({
        toolCall: { functionCalls: [toggle('1'), save('2'), toggle('3'), save('4')] },
      });
      await flush();

      expect(bridge.dispatchAction).toHaveBeenCalledTimes(4);
      expect(responsesOf(call).map((r) => r.response.success)).toEqual([true, true, true, true]);
      expect(app).toEqual({ checked: false, saved: true });
      expect(loopTrips()).toEqual([]);

      call.params.callbacks.onmessage({
        toolCall: { functionCalls: [toggle('5'), save('6'), toggle('7')] },
      });
      await flush();

      expect(bridge.dispatchAction).toHaveBeenCalledTimes(5);
      const responses = responsesOf(call);
      expect(responses.map((r) => r.response.success)).toEqual([
        true,
        true,
        true,
        true,
        true,
        false,
        false,
      ]);
      expect(responses[5].response.error).toMatch(LOOP_REFUSAL);
      expect(loopTrips()).toEqual([{ kind: 'action' }, { kind: 'action' }]);
    });

    // #28: a refusal asks the model to stop and check in with the user, as the
    // budget does, rather than to try something else on its own.
    it('words a loop refusal as stop, say what was done, and ask whether to go on', async () => {
      const { call } = await sessionWithCounter(0);
      call.params.callbacks.onmessage({ toolCall: { functionCalls: clicks(4) } });
      await flush();

      const { error } = responsesOf(call)[3].response;
      expect(error).toMatch(/not done/i);
      expect(error).toMatch(/tell the user what you have done/i);
      expect(error).toMatch(/ask the user whether to go on/i);
      expect(error).not.toMatch(/try something different/i);
    });

    it('past 50 actions in one request, tells the model to stop and ask, not that it repeated', async () => {
      const { call, bridge } = await sessionWithCounter(1);
      call.params.callbacks.onmessage({ toolCall: { functionCalls: clicks(51) } });
      await flush();

      expect(bridge.dispatchAction).toHaveBeenCalledTimes(50);
      const last = defined(responsesOf(call).at(-1));
      expect(last).toMatchObject({ id: 'inc-51', response: { success: false } });
      expect(last.response.error).toMatch(/ask the user/i);
      expect(last.response.error).toMatch(/50 actions/);
      expect(last.response.error).not.toMatch(LOOP_REFUSAL);
      expect(loopTrips()).toEqual([{ kind: 'budget' }]);

      // The user answering is a new request, with a new budget.
      call.params.callbacks.onmessage({
        serverContent: { inputTranscription: { text: 'Yes, go on.' } },
      });
      call.params.callbacks.onmessage({ toolCall: { functionCalls: clicks(1) } });
      await flush();
      expect(bridge.dispatchAction).toHaveBeenCalledTimes(51);
    });
  });

  describe('the utterance loop guard', () => {
    const LINE = 'Let me show you the settings page.';

    // One agent turn the way Live delivers it: transcription fragments, then
    // turnComplete in a message of its own.
    /**
     * @param {ConnectCall} call
     * @param {string} text
     */
    function say(call, text) {
      const words = text.split(' ');
      const half = Math.ceil(words.length / 2);
      for (const fragment of [words.slice(0, half).join(' '), ' ' + words.slice(half).join(' ')]) {
        call.params.callbacks.onmessage({
          serverContent: { outputTranscription: { text: fragment } },
        });
      }
      call.params.callbacks.onmessage({ serverContent: { turnComplete: true } });
    }

    const correctives = (/** @type {ConnectCall} */ call) =>
      call.session.sendClientContent.mock.calls.filter(
        ([arg]) => typeof arg.turns === 'string' && /repeating yourself/i.test(arg.turns),
      );

    it('sends one corrective turn when the agent says the same sentence three turns running', async () => {
      const { liveSession } = setup();
      const call = await connectAndEstablish(liveSession);

      say(call, LINE);
      say(call, LINE);
      expect(correctives(call)).toHaveLength(0);
      say(call, LINE);

      expect(correctives(call)).toHaveLength(1);
      expect(correctives(call)[0][0].turnComplete).toBe(true);
    });

    it('sends it once per episode, and again only after the user speaks', async () => {
      const { liveSession } = setup();
      const call = await connectAndEstablish(liveSession);

      for (let i = 0; i < 5; i += 1) say(call, LINE);
      expect(correctives(call)).toHaveLength(1);

      call.params.callbacks.onmessage({
        serverContent: { inputTranscription: { text: 'Why do you keep saying that?' } },
      });
      for (let i = 0; i < 3; i += 1) say(call, LINE);
      expect(correctives(call)).toHaveLength(2);
    });

    it('discards an interrupted partial turn instead of counting it', async () => {
      const { liveSession } = setup();
      const call = await connectAndEstablish(liveSession);

      say(call, LINE);
      say(call, LINE);
      call.params.callbacks.onmessage({
        serverContent: { outputTranscription: { text: 'Let me show you' } },
      });
      call.params.callbacks.onmessage({ serverContent: { interrupted: true } });
      call.params.callbacks.onmessage({
        serverContent: { outputTranscription: { text: ' the settings page.' }, turnComplete: true },
      });

      expect(correctives(call)).toHaveLength(0);
    });

    it('holds the corrective while a tool batch runs, then sends it after the last response', async () => {
      const { liveSession, bridge } = setup();
      const call = await connectAndEstablish(liveSession);
      /** @type {(result: ActionResult) => void} */
      let finishClick = () => {};
      bridge.dispatchAction.mockImplementationOnce(
        () => new Promise((resolve) => (finishClick = resolve)),
      );
      call.params.callbacks.onmessage({
        toolCall: { functionCalls: [{ id: 'c', name: 'click', args: { selector: 'b' } }] },
      });
      await flush();

      for (let i = 0; i < 3; i += 1) say(call, LINE);
      expect(correctives(call)).toHaveLength(0);

      finishClick({ success: true });
      await flush();

      expect(correctives(call)).toHaveLength(1);
      const order = call.session.sendToolResponse.mock.invocationCallOrder[0];
      const correctiveCall = call.session.sendClientContent.mock.calls.findIndex(([arg]) =>
        /repeating yourself/i.test(String(arg.turns)),
      );
      expect(
        call.session.sendClientContent.mock.invocationCallOrder[correctiveCall],
      ).toBeGreaterThan(order);
    });

    it('drops a held corrective when the user speaks before the batch is answered', async () => {
      const { liveSession, bridge } = setup();
      const call = await connectAndEstablish(liveSession);
      /** @type {(result: ActionResult) => void} */
      let finishClick = () => {};
      bridge.dispatchAction.mockImplementationOnce(
        () => new Promise((resolve) => (finishClick = resolve)),
      );
      call.params.callbacks.onmessage({
        toolCall: { functionCalls: [{ id: 'c', name: 'click', args: { selector: 'b' } }] },
      });
      await flush();
      for (let i = 0; i < 3; i += 1) say(call, LINE);

      // A new request ends the loop episode, so the nudge is no longer due.
      call.params.callbacks.onmessage({
        serverContent: { inputTranscription: { text: 'Open settings instead.' } },
      });
      finishClick({ success: true });
      await flush();

      expect(call.session.sendToolResponse).toHaveBeenCalledTimes(1);
      expect(correctives(call)).toHaveLength(0);
    });

    it('never sends a held corrective to the replacement session after a drop', async () => {
      const { liveSession, bridge } = setup();
      const first = await connectAndEstablish(liveSession);
      /** @type {(result: ActionResult) => void} */
      let finishClick = () => {};
      bridge.dispatchAction.mockImplementationOnce(
        () => new Promise((resolve) => (finishClick = resolve)),
      );
      first.params.callbacks.onmessage({
        toolCall: { functionCalls: [{ id: 'c', name: 'click', args: { selector: 'b' } }] },
      });
      await flush();
      for (let i = 0; i < 3; i += 1) say(first, LINE);

      drop(first);
      await flush();
      const second = live.calls[1];
      await establish(second);
      finishClick({ success: true });
      await flush();
      // Nor at the end of the new session's first batch.
      second.params.callbacks.onmessage({
        toolCall: { functionCalls: [{ id: 'd', name: 'click', args: { selector: 'b' } }] },
      });
      await flush();

      expect(second.session.sendToolResponse).toHaveBeenCalledTimes(1);
      expect(correctives(first)).toHaveLength(0);
      expect(correctives(second)).toHaveLength(0);
    });

    it('ignores turns from a dropped session', async () => {
      const { liveSession } = setup();
      const first = await connectAndEstablish(liveSession);
      say(first, LINE);
      say(first, LINE);

      drop(first);
      await flush();
      const second = live.calls[1];
      await establish(second);
      say(first, LINE); // a late message on the dead socket

      expect(correctives(first)).toHaveLength(0);
      expect(correctives(second)).toHaveLength(0);
    });

    it('a manual connect() starts the utterance history afresh', async () => {
      const { liveSession } = setup();
      const first = await connectAndEstablish(liveSession);
      say(first, LINE);
      say(first, LINE);

      liveSession.disconnect();
      const second = await connectAndEstablish(liveSession);
      say(second, LINE);

      expect(correctives(second)).toHaveLength(0);
    });
  });
});

// m1: the real SDK delivers setupComplete, and whatever the server queued
// behind it, through onmessage before live.connect() resolves.
describe('createLiveSession: the SDK order (messages before connect() resolves)', () => {
  it('goes open, greets once, and flushes the buffered audio', async () => {
    const { liveSession, statusNames } = setup();
    liveSession.connect();
    await flush();
    liveSession.sendAudioFrame('frame-0');
    const call = live.calls[0];

    await establishInRealOrder(call);

    expect(statusNames()).toEqual(['connecting', 'open']);
    expect(greetings(call.session)).toHaveLength(1);
    expect(call.session.sendRealtimeInput.mock.calls.map(([arg]) => arg.audio.data)).toEqual([
      'frame-0',
    ]);
  });

  // m2: the greeting follows whether this attempt resumed, not whether a
  // handle exists by now (one can arrive in the queue of a fresh session).
  it('greets a fresh session even when a resumption handle arrives before connect() resolves', async () => {
    const { liveSession } = setup();
    liveSession.connect();
    await flush();
    const call = live.calls[0];

    await establishInRealOrder(call, [
      { sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' } },
    ]);

    expect(greetings(call.session)).toHaveLength(1);
  });

  it('answers a tool call queued before connect() resolves instead of dropping it', async () => {
    const { liveSession, bridge } = setup();
    liveSession.connect();
    await flush();
    const call = live.calls[0];

    await establishInRealOrder(call, [
      { toolCall: { functionCalls: [{ id: 'early', name: 'click', args: { selector: 'b' } }] } },
    ]);

    expect(bridge.dispatchAction).toHaveBeenCalledWith('click', ['b']);
    expect(call.session.sendToolResponse).toHaveBeenCalledTimes(1);
    expect(call.session.sendToolResponse.mock.calls[0][0].functionResponses).toMatchObject({
      id: 'early',
      response: { success: true },
    });
  });

  // M6 re-review: a client turn between a function call and its response
  // breaks the model's turn (the M5 navigate stall). The early batch starts
  // first, and the knowledge and the greeting wait until it is answered.
  describe('client turns around an early tool batch', () => {
    const EARLY_CALL = {
      toolCall: { functionCalls: [{ id: 'early', name: 'click', args: { selector: 'b' } }] },
    };

    /** A dispatch that waits for the returned function to be called. */
    /** @param {FakeBridge} bridge */
    function holdDispatch(bridge) {
      /** @type {() => void} */
      let finish = () => {};
      bridge.dispatchAction.mockImplementationOnce(
        () => new Promise((resolve) => (finish = () => resolve({ success: true }))),
      );
      return () => finish();
    }

    const callOrder = (/** @type {Mock} */ fn, i = 0) => fn.mock.invocationCallOrder[i];
    const knowledgeTurns = (/** @type {FakeSession} */ session) =>
      session.sendClientContent.mock.calls
        .map(([arg]) => String(arg.turns))
        .filter((turns) => turns.startsWith('STRICT RULES'));

    it('on a resume with changed knowledge, sends the knowledge only after the early call is answered', async () => {
      setRules('Be brief.');
      const { liveSession, bridge } = setup();
      const first = await connectAndEstablish(liveSession);
      first.params.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
      });
      drop(first);
      setRules('Be very brief.');
      await flush();
      const resumed = defined(live.calls.at(-1));
      const finish = holdDispatch(bridge);

      await establishInRealOrder(resumed, [EARLY_CALL]);
      expect(bridge.dispatchAction).toHaveBeenCalledWith('click', ['b']);
      expect(resumed.session.sendClientContent).not.toHaveBeenCalled();

      finish();
      await flush();
      const { sendToolResponse, sendClientContent } = resumed.session;
      expect(sendClientContent.mock.calls.map(([arg]) => arg.turns)).toEqual([
        'STRICT RULES (must always follow):\nBe very brief.',
      ]);
      expect(callOrder(sendToolResponse)).toBeLessThan(callOrder(sendClientContent));
    });

    it('on a fresh session, sends the knowledge and then the greeting after the early call is answered', async () => {
      setRules('Be brief.');
      const { liveSession, bridge } = setup();
      liveSession.connect();
      await flush();
      const call = live.calls[0];
      const finish = holdDispatch(bridge);

      await establishInRealOrder(call, [EARLY_CALL]);
      expect(call.session.sendClientContent).not.toHaveBeenCalled();

      finish();
      await flush();
      const { sendToolResponse, sendClientContent } = call.session;
      expect(sendClientContent.mock.calls.map(([arg]) => arg.turns)).toEqual([
        'STRICT RULES (must always follow):\nBe brief.',
        'Greet the user with a brief hello.',
      ]);
      expect(callOrder(sendToolResponse)).toBeLessThan(callOrder(sendClientContent));
    });

    it('holds a knowledge change made while a batch runs until the batch is answered, once', async () => {
      const { liveSession, bridge } = setup();
      const call = await connectAndEstablish(liveSession);
      call.session.sendClientContent.mockClear();
      const finish = holdDispatch(bridge);
      call.params.callbacks.onmessage(EARLY_CALL);
      await flush();

      setRules('Be brief.');
      setRules('Be very brief.');
      expect(call.session.sendClientContent).not.toHaveBeenCalled();

      finish();
      await flush();
      expect(call.session.sendClientContent.mock.calls.map(([arg]) => arg.turns)).toEqual([
        'STRICT RULES (must always follow):\nBe very brief.',
      ]);
    });

    // A handle restores the session as of when it was issued: one issued
    // while a knowledge change waited behind a batch doesn't hold it, so a
    // resume with that handle sends the knowledge again.
    it('resends the knowledge on a resume whose handle was issued while the change was held', async () => {
      setRules('Be brief.');
      const { liveSession, bridge } = setup();
      const first = await connectAndEstablish(liveSession);
      const finish = holdDispatch(bridge);
      first.params.callbacks.onmessage(EARLY_CALL);
      await flush();
      setRules('Be very brief.'); // held behind the batch
      first.params.callbacks.onmessage({
        sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' },
      });
      finish();
      await flush();
      expect(knowledgeTurns(first.session).at(-1)).toBe(
        'STRICT RULES (must always follow):\nBe very brief.',
      );

      drop(first);
      await vi.advanceTimersByTimeAsync(1_000);
      const resumed = defined(live.calls.at(-1));
      await establish(resumed);
      expect(resumed.params.config.sessionResumption).toEqual({ handle: 'handle-1' });
      expect(knowledgeTurns(resumed.session)).toEqual([
        'STRICT RULES (must always follow):\nBe very brief.',
      ]);
    });

    it('sends turns of different kinds held by one batch in the order first held', async () => {
      const { liveSession, bridge } = setup();
      const call = await connectAndEstablish(liveSession);
      call.session.sendClientContent.mockClear();
      const finish = holdDispatch(bridge);
      call.params.callbacks.onmessage(EARLY_CALL);
      await flush();

      // The same sentence three turns running: a corrective, held first.
      for (let i = 0; i < 3; i += 1) {
        call.params.callbacks.onmessage({
          serverContent: { outputTranscription: { text: 'Let me show you the settings page.' } },
        });
        call.params.callbacks.onmessage({ serverContent: { turnComplete: true } });
      }
      setRules('Be brief.'); // then the knowledge,
      setRules('Be very brief.'); // replaced in its place
      expect(call.session.sendClientContent).not.toHaveBeenCalled();

      finish();
      await flush();
      const sent = call.session.sendClientContent.mock.calls.map(([arg]) => String(arg.turns));
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatch(/repeating yourself/i);
      expect(sent[1]).toBe('STRICT RULES (must always follow):\nBe very brief.');
    });

    it('never sends a held greeting into the replacement session after a drop', async () => {
      const { liveSession, bridge } = setup();
      liveSession.connect();
      await flush();
      const call = live.calls[0];
      const finish = holdDispatch(bridge);
      await establishInRealOrder(call, [EARLY_CALL]);

      drop(call);
      await flush();
      const replacement = defined(live.calls.at(-1));
      await establish(replacement);
      finish();
      await flush();

      expect(greetings(call.session)).toHaveLength(0);
      // The replacement is a fresh session (no handle) and greets for itself, once.
      expect(greetings(replacement.session)).toHaveLength(1);
    });
  });

  it('drops a queued tool call whose connect() was superseded', async () => {
    const { liveSession, bridge } = setup();
    liveSession.connect();
    await flush();
    const stale = live.calls[0];
    stale.params.callbacks.onmessage({ setupComplete: {} });
    stale.params.callbacks.onmessage({
      toolCall: { functionCalls: [{ id: 'early', name: 'click', args: { selector: 'b' } }] },
    });
    liveSession.disconnect();
    stale.resolve();
    await flush();

    expect(bridge.dispatchAction).not.toHaveBeenCalled();
    expect(stale.session.sendToolResponse).not.toHaveBeenCalled();
  });
});

describe('createLiveSession: the loop guard across requests', () => {
  const userSays = (/** @type {ConnectCall} */ call, /** @type {string} */ text) =>
    call.params.callbacks.onmessage({ serverContent: { inputTranscription: { text } } });
  /** @type {(call: ConnectCall, id: string, name: string, args: Record<string, unknown>) => void} */
  const toolCall = (call, id, name, args) =>
    call.params.callbacks.onmessage({ toolCall: { functionCalls: [{ id, name, args }] } });

  // I1: a loop is the model acting without new input from the user.
  it('dispatches A, B, A, B when the user asked in between', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);

    toolCall(call, '1', 'navigate', { route: 'home' });
    await flush();
    userSays(call, 'Now settings.');
    toolCall(call, '2', 'navigate', { route: 'settings' });
    await flush();
    toolCall(call, '3', 'navigate', { route: 'home' });
    await flush();
    userSays(call, 'And settings again.');
    toolCall(call, '4', 'navigate', { route: 'settings' });
    await flush();

    expect(bridge.dispatchAction).toHaveBeenCalledTimes(4);
  });

  it('dispatches four separately spoken "click increment" requests', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);

    for (const id of ['1', '2', '3', '4']) {
      userSays(call, 'Click increment.');
      toolCall(call, id, 'click', { selector: 'counter-increment' });
      await flush();
    }

    expect(bridge.dispatchAction).toHaveBeenCalledTimes(4);
    const results = call.session.sendToolResponse.mock.calls.map(
      ([arg]) => arg.functionResponses.response.success,
    );
    expect(results).toEqual([true, true, true, true]);
  });

  // m11: narration before each step of one multi-step request.
  it('sends no corrective for the same narration between the tool calls of one request', async () => {
    const { liveSession } = setup();
    const call = await connectAndEstablish(liveSession);
    const narrate = () => {
      call.params.callbacks.onmessage({
        serverContent: { outputTranscription: { text: 'Clicking the increment button now.' } },
      });
      call.params.callbacks.onmessage({ serverContent: { turnComplete: true } });
    };

    for (const id of ['1', '2', '3']) {
      narrate();
      toolCall(call, id, 'click', { selector: 'counter-increment' });
      await flush();
    }

    const correctives = call.session.sendClientContent.mock.calls.filter(([arg]) =>
      /repeating yourself/i.test(String(arg.turns)),
    );
    expect(correctives).toHaveLength(0);
  });
});

describe('createLiveSession: transcription', () => {
  it('forwards each fragment with its role, then a turn end on turnComplete and on interrupted', async () => {
    /** @type {(TranscriptFragment | 'end')[]} */
    const events = [];
    const liveSession = createLiveSession({
      bridge: fakeBridge(),
      nonce: 'page-nonce',
      onTranscript: (fragment) => events.push(fragment),
      onTurnEnd: () => events.push('end'),
    });
    created.push(liveSession);
    const call = await connectAndEstablish(liveSession);
    const send = (/** @type {LiveServerContent} */ serverContent) =>
      call.params.callbacks.onmessage({ serverContent });

    send({ inputTranscription: { text: 'Go to settings.' } });
    send({ outputTranscription: { text: 'Navigating' } });
    // A fragment and the turn's end in one message: the fragment comes first.
    send({ outputTranscription: { text: ' now.' }, turnComplete: true });
    send({ outputTranscription: { text: 'Next I' } });
    send({ interrupted: true });
    // No turn end for content that ends nothing.
    send({ modelTurn: { parts: [] } });

    expect(events).toEqual([
      { role: 'user', text: 'Go to settings.' },
      { role: 'agent', text: 'Navigating' },
      { role: 'agent', text: ' now.' },
      'end',
      { role: 'agent', text: 'Next I' },
      'end',
    ]);
  });
});
