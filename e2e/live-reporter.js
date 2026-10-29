import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Collects the `live-metrics` attachment of every live e2e test
// (e2e/live.spec.js) and appends one run to .metrics/live.json (gitignored).
// A reporter runs in the main process, so the file is written once per run
// whatever the worker count. Format: docs/metrics/README.md.

const OUTPUT = fileURLToPath(new URL('../.metrics/live.json', import.meta.url));

/** @param {string} text Playwright's error text, with its terminal colours removed. */
function firstLine(text) {
  // eslint-disable-next-line no-control-regex -- the ESC (\u001b) of an ANSI colour code is the match
  return text.replace(/\u001b\[[\d;]*m/g, '').split('\n')[0];
}

/** @implements {import('@playwright/test/reporter').Reporter} */
export default class LiveMetricsReporter {
  startedAt = new Date().toISOString();
  /** @type {object[]} */
  scenarios = [];

  /**
   * @param {import('@playwright/test/reporter').TestCase} test
   * @param {import('@playwright/test/reporter').TestResult} result
   */
  onTestEnd(test, result) {
    const attachment = result.attachments.find(({ name }) => name === 'live-metrics');
    this.scenarios.push({
      project: test.parent.project()?.name ?? null,
      status: result.status,
      durationMs: result.duration,
      error: result.error?.message ? firstLine(result.error.message) : null,
      metrics: attachment?.body ? JSON.parse(attachment.body.toString()) : null,
    });
  }

  /** @param {import('@playwright/test/reporter').FullResult} result */
  onEnd(result) {
    if (this.scenarios.length === 0) return; // `--list`, or nothing matched: no run to record
    /** @type {{ runs: object[] }} */
    let file = { runs: [] };
    try {
      file = JSON.parse(readFileSync(OUTPUT, 'utf8'));
    } catch {
      // first run: no file yet
    }
    file.runs.push({ timestamp: this.startedAt, status: result.status, scenarios: this.scenarios });
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`live metrics: run ${file.runs.length} appended to .metrics/live.json`);
  }

  printsToStdio() {
    return false;
  }
}
