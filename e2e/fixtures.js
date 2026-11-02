import { test as base, expect } from '@playwright/test';

// Every e2e test fails on a console error, an uncaught page error or a CSP
// violation, in the page or any of its frames (the target app's iframe
// included). Console and page errors come from Playwright's own events; CSP
// violations are also reported by an init script, which runs in every frame,
// so a violation is caught even if the browser stopped logging it.

export { expect };

export const test = base.extend({
  // A test that provokes an error on purpose (a stubbed 500) lists the
  // console lines it expects, as regexes; nothing else is let through.
  allowedConsoleErrors: [/** @type {RegExp[]} */ ([]), { option: true }],

  page: async ({ page, allowedConsoleErrors }, use) => {
    /** @type {string[]} */
    const problems = [];

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (allowedConsoleErrors.some((pattern) => pattern.test(text))) return;
      problems.push(`console error in ${message.location().url}: ${text}`);
    });
    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));

    await page.exposeBinding('__e2eReportCspViolation', ({ frame }, /** @type {string} */ text) => {
      problems.push(`CSP violation in ${frame.url()}: ${text}`);
    });
    // On window, not document: an iframe's first document reuses the Window
    // of its initial about:blank, which is where the init script ran, so a
    // listener on that blank document would never hear the real page.
    await page.addInitScript(() => {
      window.addEventListener('securitypolicyviolation', (event) => {
        window.__e2eReportCspViolation(`${event.violatedDirective} blocked ${event.blockedURI}`);
      });
    });

    await use(page);

    expect(problems, 'console errors, page errors or CSP violations').toEqual([]);
  },
});
