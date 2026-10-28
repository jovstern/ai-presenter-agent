---
name: ui-craft
description: The bar for a sharp UI and a smart, simple UX - visual hierarchy, typography, spacing, states, motion, responsiveness and accessibility - and how the ui-reviewer agent checks it. Read when designing screens in the spec, building any UI task, or reviewing UI.
---

# UI craft

The goal: an interface that looks deliberate and feels effortless. Fewer elements, each
one exactly right. When in doubt, remove.

## Before building a screen

The spec gives every screen: its one main job, the primary action, what the user sees first,
its states (loading, empty, error, success, partial), and how it looks on a phone and on a
wide desktop. A design source (Figma through the `figma` MCP, a reference site, or the
spec's own design direction) is named; the tokens come from it.

## Visual

- **Hierarchy:** one focal point per screen. Size, weight and colour decide importance; not
  boxes and borders. One primary button per view.
- **Typography:** at most two families; a modular type scale (about 1.2–1.25); body 16 px+,
  line height 1.5 for text and about 1.1–1.2 for large headings; line length 45–75
  characters; `text-wrap: balance` on headings, `pretty` on paragraphs; tabular numbers for
  figures.
- **Spacing:** a consistent 4/8 px scale; more space between groups than within them;
  alignment on a grid, optical alignment for icons and text.
- **Colour:** a neutral palette plus one accent used sparingly for action and focus; status
  colours (success, warning, danger) never as the only signal. AA contrast everywhere.
- **Detail:** consistent radii and shadows from tokens; crisp 1 px borders; images with
  fixed aspect ratios; no layout shift; favicon, social preview image and page titles done.

## Interaction and UX

- **Every interactive element has** hover, `:focus-visible`, active, disabled and (if it
  loads) pending states. The hit area is at least 44×44 px on touch.
- **Feedback within 100 ms:** pending state on submit, optimistic UI when the wait is
  noticeable, skeletons that match the final layout, toasts only for things off-screen.
- **Forms:** labels always visible, inline validation after blur or submit, the error says
  how to fix it, focus moves to the first error, nothing the user typed is lost.
- **Empty states** explain and offer the next action; **errors** say what happened and offer
  a retry; **404** helps the user get back.
- **Navigation:** the user always knows where they are (active link, page title) and can go
  back; URLs are shareable; scroll position is sensible after navigation.
- **Motion:** 150–250 ms, ease-out, for state changes only (enter, exit, expand); never
  blocking; `prefers-reduced-motion` turns it off. View transitions when the framework
  supports them and they help orientation.
- **Smart defaults over settings;** progressive disclosure for the rare option.

## Responsive and accessible

- Mobile first; checked at 360, 768, 1024, 1440 px; no horizontal scroll; touch and pointer
  both work.
- Semantic landmarks, one `h1`, a logical heading order, a skip link on content sites.
- Keyboard: everything reachable in visual order, no traps, Escape closes overlays, focus
  returns where it came from. Radix primitives for dialogs, menus, tabs, tooltips.
- Screen readers: alt text that says what the image shows (empty `alt` for decoration),
  `aria-live` for async results, accessible names on icon buttons.
- Zero axe violations (the metrics agent runs axe on every page).

## How the ui-reviewer checks it

At the end of each milestone it runs the app, takes screenshots of each changed screen at
360, 768 and 1440 px (and each theme), walks every flow with the keyboard only, triggers the
loading, empty and error states, and compares against the design source. Each finding has a
screenshot, the rule above it breaks, and a concrete fix.
