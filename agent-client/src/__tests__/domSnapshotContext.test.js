import { describe, expect, it } from 'vitest';
import { createDomSnapshotContext, formatSnapshotMessage } from '../domSnapshotContext.js';

function snapshot({ full = [], changed = [], removed = [] } = {}) {
  return { full, changed, removed };
}

describe('domSnapshotContext', () => {
  it('sends a keyframe the first time, regardless of delta size', () => {
    const ctx = createDomSnapshotContext();
    const decision = ctx.decide(snapshot({ full: ['a', 'b', 'c'], changed: [], removed: [] }));
    expect(decision.type).toBe('keyframe');
    expect(decision.nodes).toEqual(['a', 'b', 'c']);
  });

  it('sends a compact delta when the change is small relative to the page', () => {
    const ctx = createDomSnapshotContext();
    ctx.decide(snapshot({ full: ['a', 'b', 'c', 'd', 'e'] }));
    const decision = ctx.decide(snapshot({ full: ['a', 'b', 'c', 'd', 'e'], changed: ['a'], removed: [] }));
    expect(decision.type).toBe('delta');
    expect(decision.changed).toEqual(['a']);
  });

  it('falls back to a keyframe when the delta covers most of the page', () => {
    const ctx = createDomSnapshotContext();
    ctx.decide(snapshot({ full: ['a', 'b', 'c', 'd', 'e'] }));
    const decision = ctx.decide(
      snapshot({ full: ['a', 'b', 'c', 'd', 'e'], changed: ['a', 'b', 'c'], removed: ['d'] }),
    );
    expect(decision.type).toBe('keyframe');
  });

  it('forces a keyframe after markNavigated(), even for a small delta', () => {
    const ctx = createDomSnapshotContext();
    ctx.decide(snapshot({ full: ['a', 'b', 'c', 'd', 'e'] }));
    ctx.markNavigated();
    const decision = ctx.decide(snapshot({ full: ['x', 'y'], changed: ['x'], removed: [] }));
    expect(decision.type).toBe('keyframe');
    expect(decision.nodes).toEqual(['x', 'y']);
  });

  it('only forces one keyframe per markNavigated() call', () => {
    const ctx = createDomSnapshotContext();
    ctx.decide(snapshot({ full: ['a', 'b', 'c', 'd', 'e'] }));
    ctx.markNavigated();
    ctx.decide(snapshot({ full: ['a', 'b', 'c', 'd', 'e'] }));
    const decision = ctx.decide(snapshot({ full: ['a', 'b', 'c', 'd', 'e'], changed: ['a'], removed: [] }));
    expect(decision.type).toBe('delta');
  });

  it('formats a keyframe message', () => {
    const message = formatSnapshotMessage({ type: 'keyframe', nodes: ['a'] });
    expect(message).toContain('full');
    expect(message).toContain('"a"');
  });

  it('formats a delta message with changed and removed', () => {
    const message = formatSnapshotMessage({ type: 'delta', changed: ['a'], removed: ['b'] });
    expect(message).toContain('delta');
    expect(message).toContain('"a"');
    expect(message).toContain('"b"');
  });
});
