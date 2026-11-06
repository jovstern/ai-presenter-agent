import { onCLS, onINP, onLCP } from 'web-vitals';

/** @import { CLSMetric, INPMetric, LCPMetric, Metric } from 'web-vitals' */
/** @import { FatalKind, StatusDetails } from './liveSession.js' */

// The client log (spec R23): this bundle's own errors, the real-user vitals
// and each `failed` connection, sent as beacons to the server's gated
// POST /api/client-log, which validates them and logs them through pino
// (server/app.js). Best effort: a report that can't be sent is dropped, and
// nothing here ever throws into the page.
//
// The beacons ride on the page nonce (server/app.js gates the endpoint on it,
// as it does the token route), and a rejected beacon does log a console error
// ("Failed to load resource … 403"). So once the page knows its nonce is dead,
// a `token` failure, the log stops: that failure is not sent, nor is anything
// after it. A page whose nonce expired (1 h) or outlived a server restart
// loses its reports silently until then (README § Observability).

/** @typedef {{ type: 'error', message: string, source?: string, stack?: string }} ErrorReport */
/**
 * Only the metrics the spec names: importing just these three keeps
 * web-vitals' share of the bundle small (the budget, docs/metrics/).
 * @typedef {{ type: 'vital', name: 'LCP' | 'INP' | 'CLS', value: number,
 *   rating: Metric['rating'], id: string }} VitalReport
 */
/**
 * `kind` is the failure's FatalKind, or `exhausted` when the backoff ran out.
 * @typedef {{ type: 'connection', kind: FatalKind | 'exhausted', reason?: string,
 *   attempt: number }} ConnectionReport
 */
/** @typedef {ErrorReport | VitalReport | ConnectionReport} ClientReport */
/** @typedef {(url: string, body: string) => void} SendReport */

export const CLIENT_LOG_PATH = '/api/client-log';
// Per page: a loop that throws can't flood the endpoint (whose own per-IP
// limit is 60 a minute), and a page sends three vitals at most.
export const MAX_REPORTS = 20;
export const MAX_ERROR_REPORTS = 10;
// The server truncates too; these keep a report well under its 4 kB cap.
const MESSAGE_MAX = 500;
const SOURCE_MAX = 300;
const STACK_MAX = 2000;

/**
 * @param {string} text
 * @param {number} max
 */
const clip = (text, max) => text.slice(0, max);

/**
 * A report for a window `error` event, or null when the error isn't from
 * this bundle: the host page and its other scripts are not ours to report.
 * @param {ErrorEvent} event
 * @param {string} scriptUrl This bundle's URL (main.jsx).
 * @returns {ErrorReport | null}
 */
export function errorEventReport(event, scriptUrl) {
  if (!scriptUrl || event.filename !== scriptUrl) return null;
  const { error } = event;
  /** @type {ErrorReport} */
  const report = {
    type: 'error',
    message: clip(event.message || String(error), MESSAGE_MAX),
    source: clip(`${event.filename}:${event.lineno}:${event.colno}`, SOURCE_MAX),
  };
  if (error instanceof Error && error.stack) report.stack = clip(error.stack, STACK_MAX);
  return report;
}

/**
 * A report for an `unhandledrejection`, or null unless the reason is an
 * Error thrown from this bundle (its stack names the bundle's URL).
 * @param {unknown} reason
 * @param {string} scriptUrl
 * @returns {ErrorReport | null}
 */
export function rejectionReport(reason, scriptUrl) {
  if (!scriptUrl || !(reason instanceof Error) || !reason.stack?.includes(scriptUrl)) return null;
  return {
    type: 'error',
    message: clip(`Unhandled rejection: ${String(reason)}`, MESSAGE_MAX),
    stack: clip(reason.stack, STACK_MAX),
  };
}

/**
 * @param {Pick<LCPMetric | INPMetric | CLSMetric, 'name' | 'value' | 'rating' | 'id'>} metric
 * @returns {VitalReport}
 */
export function vitalReport({ name, value, rating, id }) {
  return { type: 'vital', name, value, rating, id };
}

/**
 * @param {StatusDetails} details What the session sent with `failed`.
 * @returns {ConnectionReport}
 */
export function connectionReport({ fatal, reason, attempt }) {
  /** @type {ConnectionReport} */
  const report = { type: 'connection', kind: fatal ?? 'exhausted', attempt };
  if (reason) report.reason = reason;
  return report;
}

/**
 * navigator.sendBeacon, the one transport: it outlives the page (vitals are
 * final on pagehide) and needs no response. A Blob typed application/json is
 * what the server's express.json() parses; same-origin, so CORS never applies.
 * Missing or refused (the beacon queue is full): the report is dropped. No
 * fetch fallback, whose failures would land in the console as errors.
 * @type {SendReport}
 */
function sendBeacon(url, body) {
  if (typeof navigator.sendBeacon !== 'function') return;
  try {
    navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
  } catch {
    // Dropped: reporting must never break the page.
  }
}

/**
 * The per-page reporter: caps the count, drops repeated errors, and sends
 * each report with the page nonce in the query (a beacon can't set headers).
 * `disable` stops it for the rest of the page.
 * @param {{ nonce: string, send?: SendReport }} options
 * @returns {{ report: (report: ClientReport) => void, disable: () => void }}
 */
export function createClientLog({ nonce, send = sendBeacon }) {
  const url = `${CLIENT_LOG_PATH}?nonce=${encodeURIComponent(nonce)}`;
  const seenErrors = new Set();
  let sent = 0;
  let disabled = false;
  return {
    report(report) {
      // Without a nonce the server can only answer 400.
      if (disabled || !nonce || sent >= MAX_REPORTS) return;
      if (report.type === 'error') {
        const key = `${report.message}\n${report.source ?? ''}`;
        if (seenErrors.has(key) || seenErrors.size >= MAX_ERROR_REPORTS) return;
        seenErrors.add(key);
      }
      sent += 1;
      send(url, JSON.stringify(report));
    },
    disable() {
      disabled = true;
    },
  };
}

/**
 * Starts the client log for this page: the error listeners and the vitals.
 * Called once, by main.jsx.
 * @param {{ nonce: string, scriptUrl: string, send?: SendReport }} options
 * @returns {(details: StatusDetails) => void} Reports one `failed` connection; a
 *   `token` failure (the page nonce is dead) is not sent and stops the log.
 */
export function startClientLog({ nonce, scriptUrl, send }) {
  const { report, disable } = createClientLog({ nonce, send });
  window.addEventListener('error', (event) => {
    const errorReport = errorEventReport(event, scriptUrl);
    if (errorReport) report(errorReport);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const errorReport = rejectionReport(event.reason, scriptUrl);
    if (errorReport) report(errorReport);
  });
  /** @param {LCPMetric | INPMetric | CLSMetric} metric */
  const reportVital = (metric) => report(vitalReport(metric));
  onLCP(reportVital);
  onINP(reportVital);
  onCLS(reportVital);
  return (details) => {
    // The server rejected the page nonce, which gates this log too: every
    // beacon from here on would 403 into the console. Stop instead.
    if (details.fatal === 'token') {
      disable();
      return;
    }
    report(connectionReport(details));
  };
}
