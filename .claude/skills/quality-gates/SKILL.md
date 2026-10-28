---
name: quality-gates
description: The definition of done for every project built with this kit - the gate commands, test rules, review layers and metrics budgets. Read before writing a plan, before saying any work is complete, and before finishing a milestone.
---

# Quality gates

Work is done only when every gate below passes on the current code. "It should pass" is not
a pass: run the command and read the output.

## Gates

| Gate | Command | When |
|---|---|---|
| Format, lint, types, unit tests, build | `npm run check` | before every task's commit; in full at the end of every milestone |
| Browser tests (recorded, console errors fail them) | `npm run e2e` | end of every milestone |
| Code review (spec + quality) | Superpowers task reviewer, then the milestone review | every task; every milestone |
| UI/UX review | the `ui-reviewer` agent | every milestone that changes UI |
| Metrics within budget | the `observer` agent (`metrics` skill) | every milestone |

A project with a separate API (`server/`) has the same `check` and `test` scripts there, and
the root `check` runs both.

## Rules

- **Test first where it pays:** logic, data access, validation and Server Actions or routes
  get tests written before the code (Superpowers TDD). Client components get Testing
  Library tests of behaviour, not markup. Each user flow in the milestone's acceptance
  criteria gets a Playwright test in `e2e/`.
- **Plans name their tests.** A task that adds behaviour names the test that proves it.
- **Browser tests:** role- and label-based locators; with Next.js Cache Components the
  previous page stays mounted but hidden after a client navigation, so use exact names
  (`{ exact: true }`) or scope to `page.getByRole('main')`. Browser and unit tests use their
  own database (file, schema, or name prefix) and clean up; they never touch the app's data.
- **Never bypass a gate.** No `--no-verify`, no skipped or deleted tests, no loosened lint,
  TypeScript or framework settings, no `eslint-disable` to get past an error. Changing a
  gate's configuration needs the user's explicit approval.
- **A red gate you cannot fix in two attempts is a stop:** use
  `superpowers:systematic-debugging`; if still red, report what fails and why.
- **Report honestly.** State which commands ran and their result. Never describe a gate as
  passing unless you saw it pass in this session.
