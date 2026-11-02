import { describe, expect, it } from 'vitest';
import ROUTES from '../../../target-app/routes.json' with { type: 'json' };
import { TOOL_DECLARATIONS, toPositionalArgs } from '../actionTools.js';

describe('TOOL_DECLARATIONS', () => {
  const declaration = (name) => TOOL_DECLARATIONS.find((tool) => tool.name === name);

  // docs/code-review-notes.md M1: one route list, target-app/routes.json.
  it('offers exactly the routes of target-app/routes.json to navigate', () => {
    expect(declaration('navigate').parametersJsonSchema.properties.route.enum).toEqual(
      Object.keys(ROUTES),
    );
  });

  it('tells the model fill picks a select’s option by its visible text', () => {
    expect(declaration('fill').description).toMatch(/select/i);
    expect(declaration('fill').description).toMatch(/visible text/i);
  });
});

describe('toPositionalArgs', () => {
  it('orders the named args the way bridge.js takes them', () => {
    expect(toPositionalArgs('fill', { value: 'hi', selector: 'name-input' })).toEqual([
      'name-input',
      'hi',
    ]);
    expect(toPositionalArgs('navigate', { route: 'settings' })).toEqual(['settings']);
  });

  it('gives an unknown action no args, so the bridge can reject it', () => {
    expect(toPositionalArgs('delete-everything', { selector: 'x' })).toEqual([]);
  });

  // Found by the checkJs pass: indexing the order table with any string reached
  // Object.prototype, and `.map` on its toString threw inside the tool batch.
  it('does not read inherited keys as actions', () => {
    expect(toPositionalArgs('toString', {})).toEqual([]);
    expect(toPositionalArgs('constructor', {})).toEqual([]);
  });
});
