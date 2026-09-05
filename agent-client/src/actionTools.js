/**
 * Gemini Live function declarations — the model's only vocabulary for acting on the page.
 *
 * The `navigate` tool's `enum` is what actually fixes v1's hallucinated-navigation bug: the
 * model isn't asked nicely to only use real pages, it *cannot emit* a page outside this list —
 * the schema itself is the guardrail. Keep this list in sync with target-app's real pages and
 * sandbox/bridge.js's KNOWN_ROUTES.
 */
export const KNOWN_ROUTES = ["index.html", "settings.html"];

export const TOOL_DECLARATIONS = [
  {
    name: "click",
    description:
      "Click an interactive element on the current page. The selector must be one you were given in a page-context message — never guess one.",
    parameters: {
      type: "OBJECT",
      properties: {
        selector: {
          type: "STRING",
          description: 'Exact selector from page context, e.g. [data-testid="deploy-widget-btn"]',
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "fill",
    description: "Type a value into a text input, identified by its selector.",
    parameters: {
      type: "OBJECT",
      properties: {
        selector: { type: "STRING" },
        value: { type: "STRING" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "scroll",
    description: "Scroll an element into view, identified by its selector.",
    parameters: {
      type: "OBJECT",
      properties: { selector: { type: "STRING" } },
      required: ["selector"],
    },
  },
  {
    name: "navigate",
    description: "Navigate to a known page. No other pages exist in this demo.",
    parameters: {
      type: "OBJECT",
      properties: {
        page: { type: "STRING", enum: KNOWN_ROUTES },
      },
      required: ["page"],
    },
  },
];
