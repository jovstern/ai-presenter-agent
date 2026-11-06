import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_LOG_PATH,
  MAX_ERROR_REPORTS,
  MAX_REPORTS,
  connectionReport,
  createClientLog,
  errorEventReport,
  rejectionReport,
  startClientLog,
  vitalReport,
} from '../clientLog.js';

const SCRIPT = 'http://agent.test/agent-client/agent-client.js';
const NONCE = '6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';

/** An Error thrown from `file`, as the browser would stack it. */
function errorFrom(file, message = 'x is undefined') {
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}\n    at f (${file}:1:200)`;
  return error;
}

function errorEvent(file, error = errorFrom(file)) {
  return new ErrorEvent('error', {
    message: `Uncaught ${String(error)}`,
    filename: file,
    lineno: 1,
    colno: 200,
    error,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('errorEventReport', () => {
  it('reports an error from this bundle with its message, source and stack', () => {
    expect(errorEventReport(errorEvent(SCRIPT), SCRIPT)).toEqual({
      type: 'error',
      message: 'Uncaught TypeError: x is undefined',
      source: `${SCRIPT}:1:200`,
      stack: `TypeError: x is undefined\n    at f (${SCRIPT}:1:200)`,
    });
  });

  it("ignores another script's error (the host page, the bridge, an extension)", () => {
    expect(errorEventReport(errorEvent('http://agent.test/sandbox/bridge.js'), SCRIPT)).toBeNull();
    // A cross-origin script's error reaches the page as "Script error." with no file.
    expect(errorEventReport(new ErrorEvent('error', { message: 'Script error.' }), SCRIPT)).toBe(
      null,
    );
  });

  it('reports nothing when the bundle URL is unknown', () => {
    expect(errorEventReport(errorEvent(''), '')).toBeNull();
  });

  it('leaves the stack out when the error is not an Error', () => {
    const event = new ErrorEvent('error', { message: 'boom', filename: SCRIPT, error: 'boom' });
    expect(errorEventReport(event, SCRIPT)).not.toHaveProperty('stack');
  });

  it('clips long messages and stacks', () => {
    const error = errorFrom(SCRIPT, 'm'.repeat(1000));
    error.stack = 's'.repeat(5000);
    const report = errorEventReport(errorEvent(SCRIPT, error), SCRIPT);
    expect(report?.message).toHaveLength(500);
    expect(report?.stack).toHaveLength(2000);
  });
});

describe('rejectionReport', () => {
  it('reports an Error whose stack names this bundle', () => {
    expect(rejectionReport(errorFrom(SCRIPT, 'nope'), SCRIPT)).toEqual({
      type: 'error',
      message: 'Unhandled rejection: TypeError: nope',
      stack: `TypeError: nope\n    at f (${SCRIPT}:1:200)`,
    });
  });

  it('ignores a rejection from another script, or one that is not an Error', () => {
    expect(rejectionReport(errorFrom('http://agent.test/target-app/home.js'), SCRIPT)).toBeNull();
    expect(rejectionReport('a string', SCRIPT)).toBeNull();
    expect(rejectionReport(undefined, SCRIPT)).toBeNull();
  });
});

describe('vitalReport', () => {
  it('keeps only the name, value, rating and id', () => {
    const metric = {
      name: 'LCP',
      value: 1234.5,
      rating: 'good',
      id: 'v6-1-2',
      delta: 1234.5,
      entries: [{}],
      navigationType: 'navigate',
    };
    expect(vitalReport(metric)).toEqual({
      type: 'vital',
      name: 'LCP',
      value: 1234.5,
      rating: 'good',
      id: 'v6-1-2',
    });
  });
});

describe('connectionReport', () => {
  it('names a fatal failure by its kind', () => {
    expect(
      connectionReport({ attempt: 0, maxAttempts: 6, reason: 'No key.', fatal: 'config' }),
    ).toEqual({ type: 'connection', kind: 'config', reason: 'No key.', attempt: 0 });
  });

  it('calls a failure with no fatal kind exhausted: the backoff ran out', () => {
    expect(connectionReport({ attempt: 6, maxAttempts: 6, reason: 'Gave up.' })).toEqual({
      type: 'connection',
      kind: 'exhausted',
      reason: 'Gave up.',
      attempt: 6,
    });
  });

  it('leaves out a missing reason', () => {
    expect(connectionReport({ attempt: 6, maxAttempts: 6 })).toEqual({
      type: 'connection',
      kind: 'exhausted',
      attempt: 6,
    });
  });
});

describe('createClientLog', () => {
  const VITAL = { type: 'vital', name: 'CLS', value: 0.01, rating: 'good', id: 'v6-1' };

  it('sends each report as JSON to the client-log path with the page nonce in the query', () => {
    const send = vi.fn();
    createClientLog({ nonce: NONCE, send })(VITAL);
    expect(send).toHaveBeenCalledWith(`${CLIENT_LOG_PATH}?nonce=${NONCE}`, JSON.stringify(VITAL));
  });

  it('sends nothing without a nonce (the server would only answer 400)', () => {
    const send = vi.fn();
    createClientLog({ nonce: '', send })(VITAL);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a repeated error once', () => {
    const send = vi.fn();
    const report = createClientLog({ nonce: NONCE, send });
    const error = { type: 'error', message: 'boom', source: `${SCRIPT}:1:1` };
    report(error);
    report({ ...error });
    report({ ...error, source: `${SCRIPT}:2:1` });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it(`sends at most ${MAX_ERROR_REPORTS} distinct errors per page`, () => {
    const send = vi.fn();
    const report = createClientLog({ nonce: NONCE, send });
    for (let i = 0; i < MAX_ERROR_REPORTS + 5; i += 1) report({ type: 'error', message: `e${i}` });
    expect(send).toHaveBeenCalledTimes(MAX_ERROR_REPORTS);
    // Other reports still go out.
    report(VITAL);
    expect(send).toHaveBeenCalledTimes(MAX_ERROR_REPORTS + 1);
  });

  it(`sends at most ${MAX_REPORTS} reports per page`, () => {
    const send = vi.fn();
    const report = createClientLog({ nonce: NONCE, send });
    for (let i = 0; i < MAX_REPORTS + 5; i += 1) {
      report({ type: 'connection', kind: 'exhausted', attempt: i });
    }
    expect(send).toHaveBeenCalledTimes(MAX_REPORTS);
  });

  it('sends with sendBeacon and a JSON Blob by default', async () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    createClientLog({ nonce: NONCE })(VITAL);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe(`${CLIENT_LOG_PATH}?nonce=${NONCE}`);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/json');
    expect(JSON.parse(await blob.text())).toEqual(VITAL);
  });

  it('drops the report silently when sendBeacon is missing, refuses or throws', () => {
    vi.stubGlobal('navigator', {});
    expect(() => createClientLog({ nonce: NONCE })(VITAL)).not.toThrow();
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) });
    expect(() => createClientLog({ nonce: NONCE })(VITAL)).not.toThrow();
    vi.stubGlobal('navigator', {
      sendBeacon: vi.fn(() => {
        throw new TypeError('Illegal invocation');
      }),
    });
    expect(() => createClientLog({ nonce: NONCE })(VITAL)).not.toThrow();
  });
});

describe('startClientLog', () => {
  it("reports this bundle's window errors and rejections, and returns the connection reporter", () => {
    const send = vi.fn();
    const reportFailure = startClientLog({ nonce: NONCE, scriptUrl: SCRIPT, send });

    window.dispatchEvent(errorEvent(SCRIPT));
    window.dispatchEvent(errorEvent('http://agent.test/sandbox/bridge.js'));
    const rejection = new Event('unhandledrejection');
    Object.assign(rejection, { reason: errorFrom(SCRIPT, 'rejected') });
    window.dispatchEvent(rejection);
    reportFailure({ attempt: 0, maxAttempts: 6, reason: 'No key.', fatal: 'config' });

    const bodies = send.mock.calls.map(([, body]) => JSON.parse(body));
    expect(bodies).toEqual([
      expect.objectContaining({ type: 'error', message: 'Uncaught TypeError: x is undefined' }),
      expect.objectContaining({
        type: 'error',
        message: 'Unhandled rejection: TypeError: rejected',
      }),
      { type: 'connection', kind: 'config', reason: 'No key.', attempt: 0 },
    ]);
  });
});
