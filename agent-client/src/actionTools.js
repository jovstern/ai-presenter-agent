/** @import { FunctionDeclaration } from '@google/genai/web' */
/** @import { ActionName } from './bridgeProtocol.js' */

// The one route list (docs/code-review-notes.md M1): route name -> page path.
// The server templates the same file into the sandbox page for bridge.js, so
// the enum the model sees and the routes the bridge accepts can't drift.
import ROUTES from '../../target-app/routes.json' with { type: 'json' };

/** @typedef {{ name: ActionName } & FunctionDeclaration} ActionDeclaration */

// Function declarations for Gemini's tool-calling. `navigate`'s enum of known
// routes structurally prevents hallucinated navigation targets — the model
// literally cannot emit a route that isn't in this list (v2 goal #4).
/** @type {ActionDeclaration[]} */
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
    description:
      'Fill a form field, identified by its data-testid selector: type text into a text input ' +
      'or textarea, or choose an option of a select by its visible text (as listed in the ' +
      "snapshot's `options`). Fails, naming the options, when a select has no such option.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'The data-testid of the field to fill.' },
        value: {
          type: 'string',
          description: "The text to type, or the visible text of the select's option to choose.",
        },
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
        route: {
          type: 'string',
          enum: Object.keys(ROUTES),
          description: 'The route to navigate to.',
        },
      },
      required: ['route'],
    },
  },
];

// Gemini's functionCall.args arrives as a named record ({selector: "..."});
// sandbox/bridge.js's action functions take positional params. This is the
// one place that translation happens.
/** @type {Record<ActionName, string[]>} */
const ARG_ORDER = {
  click: ['selector'],
  scroll: ['selector'],
  fill: ['selector', 'value'],
  navigate: ['route'],
};

/**
 * @param {string} name
 * @returns {name is ActionName}
 */
function isActionName(name) {
  return Object.hasOwn(ARG_ORDER, name);
}

/**
 * An unknown `name` gets no args; the bridge's allowlist rejects it anyway.
 * Own keys only: a model-supplied "toString" used to index the prototype and
 * throw on `.map`.
 * @param {string} name The model's function name.
 * @param {Record<string, unknown>} args The model's named arguments.
 * @returns {unknown[]}
 */
export function toPositionalArgs(name, args) {
  const order = isActionName(name) ? ARG_ORDER[name] : [];
  return order.map((key) => args[key]);
}
