---
name: build
description: Build a project end to end, or continue an existing one, with the user in the loop - an assessment of an existing repo and its docs, discovery questions until nothing important is unknown, an architecture and tech recommendation the user decides, scaffold, spec and plan with one approval, then milestone by milestone with Superpowers subagents, each ending in a code review, UI review and metrics report, a demo GIF and a PR the user merges. Resumes where it left off.
argument-hint: "[what to build, a file, or a URL]"
disable-model-invocation: true
---

# /build

Quality first: the most stable, best-practice, clean, sharp result. Time and usage are not
constraints. The user stays in control: they answer the questions, decide the architecture,
approve the plan, and merge every milestone's PR.

Read first: `CLAUDE.md`, `.claude/skills/stack-conventions/SKILL.md`,
`.claude/skills/quality-gates/SKILL.md`, `.claude/skills/ui-craft/SKILL.md`,
`.claude/skills/metrics/SKILL.md`.

**Models:** Opus 5.5 for everything — this session, every implementer, every reviewer,
the milestone review, `ui-reviewer` and `observer`. Set `model: "opus"` explicitly on
every dispatch (an omitted model may fall back to another default). Never a smaller model.

**Branches:** the default branch is `master` (protected); every milestone merges into it.

## 0. Resume check (always first)

If `docs/superpowers/plans/plan.md` exists on any branch (`git log --all --
docs/superpowers/plans/plan.md`), this is a resumed run:
1. Read the spec, the plan (from the newest milestone branch if `master` lacks them),
   `docs/adr/`, `gh pr list --state all`, and the ledger under `.superpowers/sdd/`.
2. Work out where things stand: an open PR (check its state and comments, then wait or fix),
   a merged last milestone (start the next), or a milestone branch with tasks done (continue
   with the first task the ledger does not mark complete).
3. Tell the user in 3 lines where you are resuming, then continue.

If every milestone of that plan is merged, the plan is finished: move the spec and plan to
`docs/superpowers/archive/<YYYY-MM-DD>-<slug>/` on the next branch and start a new cycle
(an existing repo by now, so section A applies).

## A. An existing repo: assess before asking

If the repo already has code (a `package.json`, source folders, or a commit history beyond
the kit), this is an existing project. Sections 2 and 3 below shrink to "propose changes";
everything else applies. Before any question:

1. **Read the project's own knowledge:** `CLAUDE.md`, `README.md`, every file in `docs/`
   (and how the repo says docs are organised, for example `docs/agents/*.md`, `CONTEXT.md`,
   `docs/adr/`), the issue tracker (`gh issue list --state all`), open and recent PRs with
   their review comments, and `git log` for the recent direction.
2. **Read the code** enough to know its real architecture, conventions, test coverage and
   weak spots. Run what exists (install, tests, build) and record the results.
3. **Write `docs/superpowers/specs/assessment.md`:**
   - what the product is and where it stands (done / in progress / open, with the issue and
     PR numbers);
   - the architecture as it really is, with a mermaid diagram;
   - the conventions the code actually follows, and where they differ from
     `stack-conventions` (the repo's conventions win; each difference worth changing becomes
     a proposal, never a silent rewrite);
   - the quality baseline compared with `quality-gates`: which gates exist, which are
     missing (lint, format, types, unit, e2e, CI), and the risk of each gap;
   - what can and cannot be measured automatically (from `metrics`), and the app-specific
     metrics that matter (for example a realtime or AI feature: connect time, latency to
     first response, action success rate, reconnects, error rate);
   - a **docs audit** (see "Docs" below): each doc, whether it is current, stale or missing,
     and what to do about it.
4. **Then discovery (section 1)** on what is still unknown: the goal of this cycle, which
   open work to take, which proposals to accept (each gate, convention or architecture
   change as its own option with cost and benefit), and the doc changes. Recommend the
   order: usually finish or close in-flight work (an open PR) first, then the quality
   baseline the rest depends on, then features.
5. **Architecture changes** are options the user decides, recorded as ADRs (section 2).
   Decisions already made in the project's docs are not reopened unless the user asks;
   when an ADR folder exists or the docs keep a decisions log, back-fill the important past
   decisions as ADRs only if the user agrees.
6. **Older branches:** before continuing a branch or PR created before the kit was added,
   merge `master` into it (so the kit's files are present on it) and push.
7. **No scaffold:** the starters are for new projects. Missing gates (lint, format, e2e, CI,
   `protect-master.sh`) are added by plan tasks once the user accepts them, matching the
   existing tooling (JavaScript stays JavaScript unless a TypeScript migration is accepted).

## Docs: keep the project's knowledge true

The planner owns the project's documentation as much as its code. Docs that drift make every
later plan worse.
- **Follow the repo's documentation conventions** (its `CLAUDE.md`, `docs/agents/*.md`): for
  example a living review checklist updated in place, a glossary in `CONTEXT.md`, decisions
  in `docs/adr/`, GitHub issues as the task list. Never start a second tracking surface for
  something that already has one.
- **In the plan:** every milestone lists the docs it changes. A task that changes behaviour,
  architecture, setup or a decision updates the affected docs in the same commit (README run
  steps, CLAUDE.md, the architecture doc, the review checklist's checkboxes, the glossary).
  Gaps the assessment found (a missing glossary, stale status, undocumented setup) become
  tasks of their own, proposed to the user like any other work.
- **New docs** only when they will be read again: an ADR for a decision with alternatives, a
  glossary entry for a term the code uses, a how-to for a setup step. Not summaries of the
  code.
- **At each milestone review** the code reviewer also checks docs drift: anything in the
  docs that this milestone made untrue is an Important finding.
- **Issue tracker:** if the project tracks work as GitHub issues, each milestone maps to an
  issue (create or update it with the plan's scope); its PR says `Closes #<n>`.

## 1. Discovery: ask until nothing important is unknown

Use `superpowers:brainstorming` for the conversation, with these overrides: questions go
through `AskUserQuestion` in batches of up to 4 related questions (recommended option first,
each option with its trade-off), as many rounds as needed; stop asking when no remaining
answer would change what gets built. Never ask what the code, the docs or a sensible
default can answer: decide it and list it as an assumption.

Cover, in this order, skipping what `$ARGUMENTS` already answers:
1. **Product:** who it is for, the one thing they must be able to do, what success looks
   like, the must-haves versus later.
2. **Content and features:** every screen and flow; what data exists and where it comes from.
3. **Design:** the source (Figma through the `figma` MCP — read only the frames you need; a
   reference site; or a direction such as "minimal, editorial, dark") and brand constraints.
   Propose a design direction (type pairing, palette, layout idea) when there is none.
4. **Constraints:** auth, languages, SEO, analytics, accessibility level, devices.
5. **Delivery:** hosting and domain, the GitHub repo name and visibility, preview deploys.

## 2. Architecture and tech: recommend, the user decides

(An existing repo: only for the changes the assessment proposes; the current architecture
is the starting point, and its record goes in `assessment.md`.)

1. Verify before recommending: current stable versions (`npm view <pkg> version`), and the
   docs of anything you are unsure about (context7 MCP, or the package's docs). Prefer what
   `stack-conventions` lists; anything else needs a reason.
2. Present **2–3 coherent options** (not a menu of parts) as a table: stack (framework,
   rendering, data, styling, hosting, observability), why it fits this product, trade-offs,
   risks, and your recommendation with the reason. Then a mermaid diagram of the
   recommended architecture.
3. Ask with `AskUserQuestion`: the option, then any open part choices (styling: Tailwind or
   CSS Modules; database; hosting). Their answer is final; record it as
   `docs/adr/0001-architecture.md` (context, options, decision, consequences). Later
   decisions of the same weight get their own ADR.

## 3. Scaffold and repository

(An existing repo skips the scaffold; missing gates arrive through plan tasks.)

- **Repo** (if there is no remote yet): `gh repo create jovstern/<name> --<visibility>
  --source . --push`, then `bash .claude/skills/pr-demo/protect-master.sh jovstern/<name>`.
  Add `.claude/` and `CLAUDE.md` in the first commit.
- **App** (if there is no `package.json`): from the repo root,
  - Next.js: `bash .claude/starters/nextjs/scaffold.sh <name> <tailwind|css-modules>`
  - React + Vite: `bash .claude/starters/vite-react/scaffold.sh <name> <tailwind|css-modules>`
  - anything else (a `server/` API, a database): the plan's first tasks, following the stack
    files.
  Both scripts end by running the gates; they must pass. Delete the starter's example
  feature in M1 once a real one exists (keep the pattern in `stack-conventions/reference/`).
- **Preview deploys:** if hosting is Vercel, ask the user to import the repo at
  vercel.com/new (one click) so every PR gets a preview URL; the PR body links it.

## 4. Spec and plan: one approval

Use `superpowers:writing-plans`, with these overrides:
- **Spec** `docs/superpowers/specs/design.md`: goal and audience; requirements checklist;
  assumptions; the stack (naming which `stack-conventions` files apply); data model; routes
  and screens — for each screen its job, primary action, states, data read and write path,
  and phone/desktop layout; design tokens; performance budgets (from `metrics`, tightened if
  needed); observability in production; the docs this cycle changes (from the docs
  audit); what is out of scope; and a short **Time
  estimate** section (the total from the plan, the assumptions behind it, the biggest risks
  to it).
- **Plan** `docs/superpowers/plans/plan.md`, split into **milestones**. M1 is the thinnest
  end-to-end slice of the core flow, deployed if hosting is set. Each milestone has at most
  6 tasks, ends with the app working, names its demo flow, and names its acceptance tests.
  The last milestone is launch polish: SEO and social previews, error and 404 pages,
  analytics and monitoring, README.
- **Time estimate** in the plan: a table with one row per milestone — tasks, estimated
  agent time (build + reviews + fixes + demo), estimated user time (answering, reviewing the
  PR, merging), and the total in wall-clock time, plus a range (best / likely / worst) and
  what would push it to the worst case. Estimate each task from its size and risk using the
  calibration below, then add the milestone overhead. Below the table, an empty
  **Time log** (milestone, estimated, actual, why it differed) that each milestone fills in.

  Calibration (measured on this kit's earlier runs; update it from the time log after each
  project): a small task (one component or function with tests) about 4–6 min; a medium task
  (a screen, a data layer, a form with validation) about 8–12 min; a large or risky task
  (new integration, auth, unfamiliar API) about 15–25 min. Per milestone, add about 20–35
  min for the three reviews, the fix wave, the gates and the demo, and about 10–15 min of the
  user's review. The first milestone also carries scaffold and setup (about 10–15 min).
  After M1, re-scale the remaining estimates by M1's
  actual/estimated ratio and say so in its PR.
- **Global Constraints** repeat the rules that matter for this stack. Any `useReducer`,
  Route Handler, context, Zustand, TanStack Query or extra dependency has a line naming
  where and why.
- **Before showing the user:** dispatch a fresh Opus reviewer (general-purpose) on the spec
  and plan against the requirements, `stack-conventions`, `ui-craft`, `metrics`,
  `quality-gates` and (existing repo) the assessment and the project's docs: gaps, wrong
  order, risky tasks, missing states or tests, docs left stale. Fix what it
  finds.
- Show the user a summary (requirements → milestones with each one's time estimate, the
  total time range, key decisions, assumptions, budgets)
  and the file paths for the full text. Apply their changes; ask again only if a change is
  large. Then create `m1-<slug>` and commit the spec, plan and ADRs on it.

## 5. Build, one milestone at a time

Use `superpowers:subagent-driven-development`, with these overrides:
- **One milestone per run:** hand it only the current milestone's tasks, on the branch
  `mN-<slug>` created from an up-to-date `master`. No worktrees. One commit per task.
- **Test-driven:** implementers follow `superpowers:test-driven-development` for logic,
  data, validation and server code.
- **Every implementer and reviewer brief carries, verbatim:** "Follow
  `.claude/skills/stack-conventions/SKILL.md` and the stack files the spec names,
  `.claude/skills/ui-craft/SKILL.md` for any UI, and `.claude/skills/quality-gates/SKILL.md`.
  Server data is never copied into client state; view state lives in the URL; data is read
  and written through the layer the spec names. Any `any`, unjustified dependency, missing
  state (loading, empty, error), missing keyboard or focus support, or leftover log or dead
  code is an Important finding."
- **Progress:** note the time when the milestone starts. After each task, one line:
  `M<N> task <k>/<total> done — <what>; <elapsed> of ~<estimate> min`.

### End of each milestone: three reviews, fix, demo, PR, wait

1. **Reviews, in parallel:**
   - the milestone's whole-diff code review on Opus (`requesting-code-review`'s
     `code-reviewer.md`, on `git merge-base master HEAD..HEAD`, pointed at the ledger's
     deferred minors and at docs drift);
   - the `ui-reviewer` agent on the screens this milestone changed (skip if no UI changed);
   - the `observer` agent on the routes this milestone touched.
2. **Fix wave:** one implementer dispatch for every Critical/Important code finding, every
   Must fix from the UI review and every budget miss; then scoped re-reviews by the same
   reviewers until clean (at most 3 rounds; anything left is reported to the user).
3. **Gates:** `npm run check` and `npm run e2e` green.
4. **Demo:** the `pr-demo` skill with the milestone number.
5. **PR:** push and `gh pr create --base master --title "M<N>: <name>" --body-file <tmp>`:
   ```
   Closes #<issue>             <when the milestone maps to an issue>
   ## What you can do now      <3–5 user-facing bullets; preview URL if any>
   ## Demo                     ![M<N> demo](<URL from make-demo.sh>)
   ## Code review              <verdict; each finding and its fix; minors left>
   ## UI review                <verdict; Must/Should fixes made; ideas left>
   ## Metrics                  <the observer's table; misses and their resolution>
   ## Decisions                <every "Ruling:" and ADR from this milestone>
   ## Docs                     <docs added or updated, and why>
   ## Manual checks for you    <from the reviewers: what could not be automated, with steps>
   ## Checks                   <commands run and results>
   ## Time                     <estimated vs actual for this milestone, why it differed,
                               and the re-scaled estimate for the rest of the plan>
   ## Requirements covered     <spec checklist items>
   ```
6. **Stop and wait.** Post: the PR link, what to look at (GIF, preview URL or
   `localhost`), the headline metrics, time (this milestone estimated vs actual, and the
   remaining estimate), what is next, and: "Merge it and reply **merged**, or
   leave PR comments. For the cleanest context, you can `/clear` and run `/build` after
   merging; it resumes from the plan." Change nothing while waiting.
7. **On the reply:** `gh pr view <N> --json state,reviews,comments`. Comments → fix on the
   branch, rerun gates, push, answer each comment, wait again. `MERGED` → `git switch master
   && git pull --ff-only`, fill in this milestone's row of the plan's Time log (commit it on
   the next milestone's branch), and start the next milestone.

## 6. Launch and finish

(An existing repo whose cycle is not a launch: the last milestone instead closes the cycle
— docs brought fully up to date, the assessment's open items either done or filed as
issues, and the final report below.)

The last milestone ships the launch checklist: metadata and Open Graph images per page,
`sitemap` and `robots`, favicon and manifest, 404 and error pages, analytics and error
monitoring live, security headers, final observer report against production if deployed,
and `README.md` (what it is, live URL, how to run and test, architecture and decisions with
links to the ADRs, metrics, demo GIFs, what's next).

After the last merge: the requirements checklist (✅/❌), the decisions, the final metrics,
the time log (estimated vs actual per milestone and in total, and what to change in the
calibration above — propose the edit to the kit in `~/Mnt/portfolio/.claude`),
and the links to the repo, each PR and the live site.
