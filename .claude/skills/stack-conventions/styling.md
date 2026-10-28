# Styling

The spec chooses **Tailwind** or **CSS Modules** in the architecture step. Both follow the
same design system: tokens first, components second.

## Design tokens (both options)

- Colours, type scale, spacing scale, radii, shadows, motion durations and breakpoints are
  defined once as CSS custom properties (and, with Tailwind, exposed through `@theme`).
  Components use tokens, never raw hex values or magic numbers.
- Semantic names (`--color-surface`, `--color-text-muted`, `--color-accent`), not literal
  ones (`--blue-500`) at the component level.
- Dark mode, if the spec wants it: tokens are redefined under the theme selector; components
  do not change. Every text/background pair passes WCAG AA in each theme.
- Fluid type with `clamp()` for headings; a 4 px or 8 px spacing grid.

## Tailwind (v4)

- Utility classes in the markup; `clsx` for conditional classes. No `@apply` except in
  rare base styles. Tokens in `@theme` in `globals.css`.
- `prettier-plugin-tailwindcss` sorts classes. Long class lists are fine; repeated ones mean a
  component should be extracted, not a CSS class.
- Variants for interactive states: `hover:`, `focus-visible:`, `disabled:`,
  `aria-[current=page]:`, `data-[state=open]:` (Radix).

## CSS Modules

- One `name.module.css` next to `name.tsx`; class names in camelCase; no global selectors
  except in `globals.css` (reset, tokens, base typography).
- State through attributes, not extra classes: `[aria-current='page']`,
  `[data-state='open']`, `:focus-visible`, `:disabled`.
- `prettier-plugin-css-order` keeps properties ordered. Logical properties
  (`margin-inline`, `padding-block`) for layout.
- Media queries use the token breakpoints; mobile first (`min-width`).
