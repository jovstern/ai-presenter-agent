import { describe, expect, it } from 'vitest';
import { toPositionalArgs } from '../actionTools.js';

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
