import { describe, expect, it } from 'vitest';
import { createLoopGuard, actionSignature } from '../loopGuard.js';

describe('loopGuard', () => {
  it('does not trip before the threshold is exceeded', () => {
    const guard = createLoopGuard(3);
    expect(guard.check('click:a')).toBe(false);
    expect(guard.check('click:a')).toBe(false);
    expect(guard.check('click:a')).toBe(false);
  });

  it('trips once the same signature repeats past the threshold', () => {
    const guard = createLoopGuard(3);
    guard.check('click:a');
    guard.check('click:a');
    guard.check('click:a');
    expect(guard.check('click:a')).toBe(true);
  });

  it('resets the count when the signature changes', () => {
    const guard = createLoopGuard(3);
    guard.check('click:a');
    guard.check('click:a');
    guard.check('click:a');
    expect(guard.check('click:b')).toBe(false);
    expect(guard.check('click:b')).toBe(false);
  });

  it('explicit reset() clears the streak for the same signature', () => {
    const guard = createLoopGuard(3);
    guard.check('click:a');
    guard.check('click:a');
    guard.check('click:a');
    guard.reset();
    expect(guard.check('click:a')).toBe(false);
  });

  it('actionSignature builds a stable signature from name + args', () => {
    expect(actionSignature('click', { selector: 'save-button' })).toBe(
      actionSignature('click', { selector: 'save-button' }),
    );
    expect(actionSignature('click', { selector: 'a' })).not.toBe(actionSignature('click', { selector: 'b' }));
  });
});
