---
name: pr-demo
description: Record a demo GIF of the current milestone's main user flow and publish it for its pull request. Use after the milestone's gates pass and before the PR is opened, or when a PR is missing its demo.
---

# PR demo

Every milestone PR shows what was built. Its `## Demo` section shows `m<NN>/demo.gif` from
the `pr-media` branch; this skill puts the file there. CI fails a PR without an image.

1. **The flow:** the one the plan names for this milestone. Keep it under about 20 seconds.
   If the milestone is mainly visual, also record it at phone width: a second test with a
   390×844 viewport, published as milestone `<N>.1` (it lands in `m<NN>.1/demo.gif`).
2. **A Playwright test drives it** in `e2e/`. If none does, write one: it is both the demo and
   a regression test. Make it readable: `await page.waitForTimeout(1000)` after each visible
   result (a page appearing, an error, a row added), so a viewer can follow the GIF.
3. **Record:** `npx playwright test e2e/<file>.spec.ts` (recording is always on); the video is
   `test-results/<test-name>/video.webm`.
4. **Publish:** `bash .claude/skills/pr-demo/make-demo.sh <milestone-number> <video>` converts
   it to a GIF, pushes it to `pr-media`, and prints the image URL.
5. **Look at it:** read the GIF and confirm it shows the flow working. A blank or error page
   is a failed demo: fix and re-record.

If the PR is already open without the image, add the `## Demo` section with
`gh pr edit <number> --body-file <file>`.
