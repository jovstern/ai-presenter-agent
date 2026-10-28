import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveSession } from '../liveSession.js';
import { setRules } from '../knowledgeStore.js';

// A fake Gemini Live client: every live.connect() is recorded with its
// callbacks and a fake session, and stays pending until the test resolves or
// rejects it — so tests control exactly when a connect "lands".
const live = vi.hoisted(() => ({ calls: [] }));

vi.mock('@google/genai/web', () => {
  class GoogleGenAI {
    constructor(options) {
      this.live = {
        connect: (params) =>
          new Promise((resolve, reject) => {
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
  return { GoogleGenAI, Modality: { AUDIO: 'AUDIO' } };
});

const MAX_ATTEMPTS = 6;

function tokenResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const okToken = () => tokenResponse(200, { token: 'ephemeral-token' });

const fetchMock = vi.fn();

function fakeBridge() {
  const unsubscribeSnapshot = vi.fn();
  const unsubscribeNavigated = vi.fn();
  return {
    dispatchAction: vi.fn(async () => ({ success: true })),
    requestSnapshot: vi.fn(),
    onSnapshot: vi.fn(() => unsubscribeSnapshot),
    onNavigated: vi.fn(() => unsubscribeNavigated),
    close: vi.fn(),
    unsubscribeSnapshot,
    unsubscribeNavigated,
  };
}

let created = [];

function setup() {
  const bridge = fakeBridge();
  const statuses = [];
  const liveSession = createLiveSession({
    bridge,
    onStatusChange: (status, details) => statuses.push({ status, ...details }),
  });
  created.push(liveSession);
  return { bridge, statuses, liveSession, statusNames: () => statuses.map((s) => s.status) };
}

// Runs due timers and drains the promise chains (fetch → live.connect) they start.
const flush = () => vi.advanceTimersByTimeAsync(0);

// A healthy session: socket opens, connect() resolves, the server confirms setup.
async function establish(call) {
  call.params.callbacks.onopen();
  call.resolve();
  await flush();
  call.params.callbacks.onmessage({ setupComplete: {} });
}

// What Live typically does on a network drop: both callbacks, back to back.
function drop(call) {
  call.params.callbacks.onerror(new Error('socket dropped'));
  call.params.callbacks.onclose({ code: 1006 });
}

async function connectAndEstablish(liveSession) {
  liveSession.connect();
  await flush();
  const call = live.calls.at(-1);
  await establish(call);
  return call;
}

const greetings = (session) =>
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
    await vi.advanceTimersByTimeAsync(60_000);

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

    stale.params.callbacks.onopen();
    stale.resolve();
    await flush();

    expect(stale.session.close).toHaveBeenCalled();
    expect(stale.session.sendClientContent).not.toHaveBeenCalled();
    expect(statusNames()).not.toContain('open');

    // Late callbacks from the stale socket don't schedule anything either.
    stale.params.callbacks.onclose({});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await establish(current);
    expect(statusNames().at(-1)).toBe('open');
    expect(greetings(current.session)).toHaveLength(1);
  });

  it('ignores a token that arrives after its connect() was superseded', async () => {
    let releaseFirstToken;
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
    let finishNavigate;
    bridge.dispatchAction.mockImplementationOnce(() => new Promise((resolve) => (finishNavigate = resolve)));

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
    const responseIds = call.session.sendToolResponse.mock.calls.map(([arg]) => arg.functionResponses.id);
    expect(responseIds).toEqual(['nav', 'buy']);
  });

  it('sends no stale tool response when the session is replaced mid-batch', async () => {
    const { liveSession, bridge } = setup();
    const first = await connectAndEstablish(liveSession);
    let finishNavigate;
    bridge.dispatchAction.mockImplementationOnce(() => new Promise((resolve) => (finishNavigate = resolve)));

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

  it('resumes with the stored handle on reconnect and does not greet again', async () => {
    const { liveSession } = setup();
    const first = await connectAndEstablish(liveSession);
    expect(first.params.config.sessionResumption).toEqual({});
    expect(greetings(first.session)).toHaveLength(1);

    first.params.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' } });
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

    expect(statusNames()).toEqual(['connecting', 'open', 'reconnecting', 'open']);
    expect(statuses[2]).toMatchObject({ attempt: 1, maxAttempts: MAX_ATTEMPTS });

    // Now every token request fails with a retryable 503.
    fetchMock.mockImplementation(async () => tokenResponse(503, { error: 'unavailable' }));
    drop(live.calls[1]);
    await vi.advanceTimersByTimeAsync(120_000);

    const afterSecondDrop = statuses.slice(4);
    expect(afterSecondDrop.map((s) => s.status)).toEqual([...Array(MAX_ATTEMPTS).fill('reconnecting'), 'failed']);
    expect(afterSecondDrop.slice(0, MAX_ATTEMPTS).map((s) => s.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(statusNames().filter((s) => s === 'failed')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows reconnecting, not failed, while a retry is scheduled after an error', async () => {
    fetchMock.mockImplementationOnce(async () => tokenResponse(503, { error: 'unavailable' }));
    const { liveSession, statusNames } = setup();

    liveSession.connect();
    await flush();

    expect(statusNames()).toEqual(['connecting', 'reconnecting']);
    expect(statusNames()).not.toContain('failed');
  });

  it('blocks the 4th identical call with the loop guard: no dispatch, a failure response', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);
    const sameClick = (id) => ({ id, name: 'click', args: { selector: '#buy' } });

    call.params.callbacks.onmessage({
      toolCall: { functionCalls: [sameClick('1'), sameClick('2'), sameClick('3'), sameClick('4')] },
    });
    await flush();

    expect(bridge.dispatchAction).toHaveBeenCalledTimes(3);
    const responses = call.session.sendToolResponse.mock.calls.map(([arg]) => arg.functionResponses);
    expect(responses).toHaveLength(4);
    expect(responses[3]).toMatchObject({ id: '4', response: { success: false } });
    expect(responses[3].response.error).toMatch(/repeated/i);
  });

  it('a manual connect() after failed resets the attempts and really retries', async () => {
    fetchMock.mockImplementation(async () => tokenResponse(503, { error: 'unavailable' }));
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
    await establish(live.calls.at(-1));
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
      const call = live.calls.at(-1);
      call.params.callbacks.onopen();
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

    const reconnectAttempts = statuses.filter((s) => s.status === 'reconnecting').map((s) => s.attempt);
    expect(reconnectAttempts).toEqual([1, 2]);
  });

  it('resets the backoff once the server has answered, so the next drop retries immediately', async () => {
    const { liveSession, statuses } = setup();
    const first = await connectAndEstablish(liveSession);
    drop(first);
    await flush();
    const second = await (async () => {
      const call = live.calls[1];
      await establish(call); // setupComplete arrives → healthy again
      return call;
    })();

    drop(second);
    await flush();

    expect(live.calls).toHaveLength(3);
    const reconnectAttempts = statuses.filter((s) => s.status === 'reconnecting').map((s) => s.attempt);
    expect(reconnectAttempts).toEqual([1, 1]);
  });

  it('fails immediately on a 4xx token response, tells the user to reload, and schedules no retry', async () => {
    fetchMock.mockImplementation(async () => tokenResponse(403, { error: 'Invalid or expired nonce' }));
    const { liveSession, statuses, statusNames } = setup();

    liveSession.connect();
    await flush();

    expect(statusNames()).toEqual(['connecting', 'failed']);
    expect(statuses.at(-1).reason).toMatch(/reload/i);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries 5xx and network errors', async () => {
    fetchMock
      .mockImplementationOnce(async () => tokenResponse(500, { error: 'Server misconfigured' }))
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
});
