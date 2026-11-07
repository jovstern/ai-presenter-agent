import { describe, expect, it } from 'vitest';
import { createDomSnapshotContext, formatSnapshotMessage } from '../domSnapshotContext.js';

/** @import { Snapshot, SnapshotNode } from '../bridgeProtocol.js' */

/**
 * A visible, enabled span per selector, the shape bridge.js reports.
 * @param {...string} selectors
 * @returns {SnapshotNode[]}
 */
function nodes(...selectors) {
  return selectors.map((selector) => ({
    selector,
    tag: 'span',
    label: selector,
    disabled: false,
    hidden: false,
  }));
}

/**
 * A snapshot from selectors: `full` and `changed` become nodes, `removed` stays selectors.
 * @param {{ full?: string[], changed?: string[], removed?: string[], omitted?: number }} [selectors]
 * @returns {Snapshot}
 */
function snapshot({ full = [], changed = [], removed = [], omitted = 0 } = {}) {
  /** @type {Snapshot} */
  const result = { full: nodes(...full), changed: nodes(...changed), removed };
  if (omitted > 0) result.omitted = omitted;
  return result;
}

describe('domSnapshotContext', () => {
  it('sends a keyframe the first time, regardless of delta size', () => {
    const ctx = createDomSnapshotContext();
    const decision = ctx.decide(snapshot({ full: ['a', 'b', 'c'], changed: [], removed: [] }));
    expect(decision).toEqual({ type: 'keyframe', nodes: nodes('a', 'b', 'c'), omitted: 0 });
  });

  it('sends a compact delta when the change is small relative to the page', () => {
    const ctx = createDomSnapshotContext();
    ctx.decide(snapshot({ full: ['a', 'b', 'c', 'd', 'e'] }));
    const decision = ctx.decide(
      snapshot({ full: ['a', 'b', 'c', 'd', 'e'], changed: ['a'], removed: [] }),
    );
    expect(decision).toEqual({ type: 'delta', changed: nodes('a'), removed: [] });
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
    expect(decision).toEqual({ type: 'keyframe', nodes: nodes('x', 'y'), omitted: 0 });
  });

  it('only forces one keyframe per markNavigated() call', () => {
    const ctx = createDomSnapshotContext();
    ctx.decide(snapshot({ full: ['a', 'b', 'c', 'd', 'e'] }));
    ctx.markNavigated();
    ctx.decide(snapshot({ full: ['a', 'b', 'c', 'd', 'e'] }));
    const decision = ctx.decide(
      snapshot({ full: ['a', 'b', 'c', 'd', 'e'], changed: ['a'], removed: [] }),
    );
    expect(decision.type).toBe('delta');
  });

  it('formats a keyframe message', () => {
    const message = formatSnapshotMessage({ type: 'keyframe', nodes: nodes('a'), omitted: 0 });
    expect(message).toBe(
      'Page snapshot (full):\n[{"selector":"a","tag":"span","label":"a","disabled":false,"hidden":false}]',
    );
  });

  // Issue #22: a page over the bridge's cap.
  describe('on a page over the bridge’s cap', () => {
    const FULL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

    it('tells the model in a keyframe how many elements were left out, and how to reach them', () => {
      const ctx = createDomSnapshotContext();
      const decision = ctx.decide(snapshot({ full: FULL, omitted: 109 }));

      expect(decision).toEqual({ type: 'keyframe', nodes: nodes(...FULL), omitted: 109 });
      expect(formatSnapshotMessage(decision)).toMatch(
        /\nThe page has 109 more elements not listed: off screen or hidden\. To reach one off screen, scroll to the listed element nearest it/,
      );
    });

    it('still sends a small change with no removal as a delta', () => {
      const ctx = createDomSnapshotContext();
      ctx.decide(snapshot({ full: FULL, omitted: 109 }));

      const decision = ctx.decide(snapshot({ full: FULL, changed: ['c', 'd'], omitted: 109 }));

      expect(decision).toEqual({ type: 'delta', changed: nodes('c', 'd'), removed: [] });
    });

    // A scroll moves nodes out of the snapshot that are still on the page; a
    // delta's `removed` would say they are gone.
    it('sends a keyframe for any removal, however small', () => {
      const ctx = createDomSnapshotContext();
      ctx.decide(snapshot({ full: FULL, omitted: 109 }));
      const scrolled = [...FULL.slice(1), 'k'];

      const decision = ctx.decide(
        snapshot({ full: scrolled, changed: ['k'], removed: ['a'], omitted: 109 }),
      );

      expect(decision).toEqual({ type: 'keyframe', nodes: nodes(...scrolled), omitted: 109 });
    });

    it('keeps a removal on a page under the cap a delta', () => {
      const ctx = createDomSnapshotContext();
      ctx.decide(snapshot({ full: FULL }));

      const decision = ctx.decide(snapshot({ full: FULL.slice(1), removed: ['a'] }));

      expect(decision).toEqual({ type: 'delta', changed: [], removed: ['a'] });
    });
  });

  it('formats a delta message with changed and removed', () => {
    const message = formatSnapshotMessage({ type: 'delta', changed: nodes('a'), removed: ['b'] });
    expect(message).toContain('delta');
    expect(message).toContain('"a"');
    expect(message).toContain('"b"');
  });
});
