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
// The server's one error shape (server/app.js).
const apiError = (code, message) => ({ error: { code, message } });

const fetchMock = vi.fn();

function fakeBridge() {
  const unsubscribeSnapshot = vi.fn();
  const unsubscribeNavigated = vi.fn();
  const bridge = {
    dispatchAction: vi.fn(async () => ({ success: true })),
    requestSnapshot: vi.fn(),
    // Lets a test play the bridge pushing a snapshot over the channel.
    emitSnapshot: (snapshot) =>
      bridge.onSnapshot.mock.calls.forEach(([listener]) => listener(snapshot)),
    onSnapshot: vi.fn(() => unsubscribeSnapshot),
    onNavigated: vi.fn(() => unsubscribeNavigated),
    close: vi.fn(),
    unsubscribeSnapshot,
    unsubscribeNavigated,
  };
  return bridge;
}

let created = [];

function setup() {
  const bridge = fakeBridge();
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
async function establish(call) {
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
    let finishNavigate;
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
    expect(statuses.at(-1).fatal).toBeFalsy(); // exhausted retries can still be retried by hand
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
    const sameClick = (id) => ({ id, name: 'click', args: { selector: '#buy' } });

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
    expect(responses[3].response.error).toMatch(/repeated/i);
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
    const reconnectAttempts = statuses
      .filter((s) => s.status === 'reconnecting')
      .map((s) => s.attempt);
    expect(reconnectAttempts).toEqual([1, 1]);
  });

  it("echoes the page nonce on the token request, and reports the server's error message", async () => {
    fetchMock.mockImplementationOnce(async () =>
      tokenResponse(503, apiError('internal', 'Internal server error')),
    );
    const { liveSession, statuses } = setup();

    liveSession.connect();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/live-token?nonce=page-nonce');
    expect(statuses.find((s) => s.status === 'reconnecting').reason).toBe('Internal server error');
  });

  it('fails immediately on a 4xx token response, tells the user to reload, and schedules no retry', async () => {
    fetchMock.mockImplementation(async () =>
      tokenResponse(403, apiError('invalid_nonce', 'Unknown or expired nonce')),
    );
    const { liveSession, statuses, statusNames } = setup();

    liveSession.connect();
    await flush();

    expect(statusNames()).toEqual(['connecting', 'failed']);
    expect(statuses.at(-1).reason).toMatch(/reload/i);
    expect(statuses.at(-1).fatal).toBe(true);
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
    expect(statuses.at(-1).fatal).toBeFalsy();
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
    expect(statuses.at(-1).reason).toBe('The token response had no token.');
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
  it('treats a not_configured server error as fatal, with a contact-the-owner reason', async () => {
    fetchMock.mockImplementation(async () =>
      tokenResponse(500, apiError('not_configured', "The server isn't configured to connect")),
    );
    const { liveSession, statuses, statusNames } = setup();

    liveSession.connect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(statusNames()).toEqual(['connecting', 'failed']);
    expect(statuses.at(-1)).toMatchObject({
      reason:
        "The server isn't configured to connect. Contact the site owner, then reload this page.",
      fatal: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    const page = [1, 2, 3, 4, 5].map((n) => ({ selector: `n${n}`, tag: 'button', label: `${n}` }));
    const smallDelta = { full: page, changed: [page[0]], removed: [] };
    const snapshotTexts = (session) =>
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
    const sameClick = (id) => ({ id, name: 'click', args: { selector: '#buy' } });
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

  it('sends a snapshot that arrives mid-batch inside the next tool response, as a keyframe when several were held', async () => {
    const { liveSession, bridge } = setup();
    const call = await connectAndEstablish(liveSession);
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
        response: { success: true, page: expect.stringMatching(/^Page snapshot \(full\)/) },
      },
      {
        id: 'tap',
        name: 'click',
        response: { success: true, page: expect.stringMatching(/^Page snapshot \(delta\)/) },
      },
    ]);
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

    const call = live.calls.at(-1);
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
