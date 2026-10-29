// Mirrors sandbox/bridge.js's KNOWN_ROUTES. The two can't literally share an
// import (bridge.js is a plain unbundled script, this is bundled separately)
// — kept as a hand-duplicated pair rather than a shared module, matching the
// tradeoff already flagged as open in docs/code-review-notes.md M1. If they
// ever drift, `navigate` calls for the missing route fail closed (bridge.js
// rejects unknown routes), not open.
export const KNOWN_ROUTES = ['home', 'settings'];

// Function declarations for Gemini's tool-calling. `navigate`'s enum of known
// routes structurally prevents hallucinated navigation targets — the model
// literally cannot emit a route that isn't in this list (v2 goal #4).
export const TOOL_DECLARATIONS = [
  {
    name: 'click',
    description: 'Click an element on the page, identified by its data-testid selector.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'The data-testid of the element to click.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll an element on the page into view, identified by its data-testid selector.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'The data-testid of the element to scroll to.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'fill',
    description: 'Type a value into a text input, identified by its data-testid selector.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'The data-testid of the input to fill.' },
        value: { type: 'string', description: 'The text to type into the input.' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the page to a known route.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', enum: KNOWN_ROUTES, description: 'The route to navigate to.' },
      },
      required: ['route'],
    },
  },
];

// Gemini's functionCall.args arrives as a named record ({selector: "..."});
// sandbox/bridge.js's action functions take positional params. This is the
// one place that translation happens.
const ARG_ORDER = {
  click: ['selector'],
  scroll: ['selector'],
  fill: ['selector', 'value'],
  navigate: ['route'],
};

export function toPositionalArgs(name, args) {
  return (ARG_ORDER[name] ?? []).map((key) => args[key]);
}
