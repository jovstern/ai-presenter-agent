import { describe, expect, it } from 'vitest';
import {
  createLoopGuard,
  actionSignature,
  normaliseUtterance,
  pageFingerprint,
  ACTION_BUDGET,
} from '../loopGuard.js';

const sig = (name, args, page) => actionSignature(name, args, page);
const increment = sig('click', { selector: 'counter-increment' });
const decrement = sig('click', { selector: 'counter-decrement' });
const goHome = sig('navigate', { route: 'home' });
const goSettings = sig('navigate', { route: 'settings' });
const fillName = sig('fill', { selector: 'name', value: 'Ada' });
const toggle = sig('click', { selector: 'notifications' });
const save = sig('click', { selector: 'save-button' });

/**
 * Feeds the sequence through a fresh guard and returns the result of each check.
 * @param {string[]} sequence
 */
function run(sequence) {
  const guard = createLoopGuard();
  return sequence.map((signature) => guard.check(signature));
}

describe('loopGuard: repeated actions', () => {
  it('does not trip on three identical calls in a row', () => {
    expect(run([increment, increment, increment])).toEqual([false, false, false]);
  });

  it('trips on the 4th identical call, and keeps tripping while it repeats', () => {
    expect(run([increment, increment, increment, increment, increment])).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it('a different call breaks the streak', () => {
    expect(run([increment, increment, increment, goSettings, increment, increment])).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('explicit reset() clears the streak for the same signature', () => {
    const guard = createLoopGuard();
    guard.check(increment);
    guard.check(increment);
    guard.check(increment);
    guard.reset();
    expect(guard.check(increment)).toBe(false);
  });
});

describe('loopGuard: cycles', () => {
  it('trips on an A-B-A-B cycle, on the call that completes it', () => {
    expect(run([goHome, goSettings, goHome, goSettings])).toEqual([false, false, false, true]);
  });

  it('keeps tripping while the A-B cycle goes on', () => {
    expect(run([increment, decrement, increment, decrement, increment])).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it('trips on a period-3 cycle (A-B-C-A-B-C) on the call that completes it', () => {
    expect(run([fillName, toggle, save, fillName, toggle, save])).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('trips on a period-3 cycle with a repeat inside it (A-A-B-A-A-B)', () => {
    expect(run([increment, increment, goSettings, increment, increment, goSettings]).at(-1)).toBe(
      true,
    );
  });

  it('reset() clears the cycle history', () => {
    const guard = createLoopGuard();
    [goHome, goSettings, goHome].forEach((s) => guard.check(s));
    guard.reset();
    expect(guard.check(goSettings)).toBe(false);
  });
});

// #25: each response now shows the page, so an action is judged on the page
// it was taken on. The same click that moves the page on (the counter at 0, 1,
// 2, …) is progress; the same click on the same page is still a loop.
describe('loopGuard: the page an action was taken on is part of its signature', () => {
  const incrementAt = (/** @type {number} */ value) =>
    sig('click', { selector: 'counter-increment' }, `counter=${value}`);

  it('passes 10 and 50 identical clicks that each move the counter on', () => {
    for (const count of [10, 50]) {
      const sequence = Array.from({ length: count }, (_, value) => incrementAt(value));
      expect(run(sequence).some(Boolean)).toBe(false);
    }
  });

  it('still trips the 4th identical click on an unchanged page', () => {
    expect(run([0, 0, 0, 0].map(incrementAt))).toEqual([false, false, false, true]);
  });

  it('still trips a toggle flipped on, off, on, off (period 2 over two states)', () => {
    const flipOn = sig('click', { selector: 'notifications-toggle' }, 'off');
    const flipOff = sig('click', { selector: 'notifications-toggle' }, 'on');
    expect(run([flipOn, flipOff, flipOn, flipOff])).toEqual([false, false, false, true]);
  });

  it('still trips home → settings → home → settings taken from the same two pages', () => {
    const toSettings = sig('navigate', { route: 'settings' }, 'home-page');
    const toHome = sig('navigate', { route: 'home' }, 'settings-page');
    expect(run([toSettings, toHome, toSettings, toHome])).toEqual([false, false, false, true]);
  });

  it('still trips a 3-step routine repeated on the same states (period 3)', () => {
    const routine = [
      sig('fill', { selector: 'name', value: 'Ada' }, 's0'),
      sig('click', { selector: 'notifications' }, 's1'),
      sig('click', { selector: 'save-button' }, 's2'),
    ];
    expect(run([...routine, ...routine]).at(-1)).toBe(true);
  });

  it('falls back to the bare action when there is no page yet', () => {
    expect(sig('click', { selector: 'counter-increment' }, undefined)).toBe(increment);
    expect(run([increment, increment, increment, increment]).at(-1)).toBe(true);
  });
});

describe('pageFingerprint', () => {
  const node = (selector, label, extra = {}) => ({
    selector,
    tag: 'span',
    label,
    disabled: false,
    hidden: false,
    ...extra,
  });

  it('is a short string, the same for the same nodes', () => {
    const page = [node('counter-value', '3'), node('counter-increment', 'Increment')];
    const again = [node('counter-value', '3'), node('counter-increment', 'Increment')];
    expect(pageFingerprint(page)).toBe(pageFingerprint(again));
    expect(pageFingerprint(page)).toMatch(/^[0-9a-z]{1,8}$/);
  });

  it('differs when a label, a checked state or a value changes', () => {
    const base = pageFingerprint([node('counter-value', '3')]);
    expect(pageFingerprint([node('counter-value', '4')])).not.toBe(base);
    expect(pageFingerprint([node('counter-value', '3', { checked: true })])).not.toBe(base);
    expect(pageFingerprint([node('counter-value', '3', { value: 'Ada' })])).not.toBe(base);
  });

  it('distinguishes an empty page from no page', () => {
    expect(pageFingerprint([])).toMatch(/^[0-9a-z]{1,8}$/);
  });
});

// A backstop for what the page signature can't see (a page with a clock makes
// every state new): one request gets ACTION_BUDGET actions, then the model is
// told to stop and ask.
describe('loopGuard: the action budget per request', () => {
  it('allows ACTION_BUDGET (50) actions, refuses the next, and resets when the user speaks', () => {
    expect(ACTION_BUDGET).toBe(50);
    const guard = createLoopGuard();
    const spent = Array.from({ length: ACTION_BUDGET + 2 }, () => guard.spendAction());
    expect(spent.slice(0, ACTION_BUDGET).some(Boolean)).toBe(false);
    expect(spent.slice(ACTION_BUDGET)).toEqual([true, true]);
    guard.userSpoke();
    expect(guard.spendAction()).toBe(false);
  });

  it('reset() restores the budget', () => {
    const guard = createLoopGuard();
    for (let i = 0; i <= ACTION_BUDGET; i += 1) guard.spendAction();
    guard.reset();
    expect(guard.spendAction()).toBe(false);
  });
});

// A loop is the model acting again and again with no new input from the user
// (I1): the user speaking starts a new request, so the window starts afresh.
describe('loopGuard: the user speaking ends the action window', () => {
  it('passes A, user speaks, B, A, user speaks, B (no A-B-A-B across requests)', () => {
    const guard = createLoopGuard();
    expect(guard.check(goHome)).toBe(false);
    guard.userSpoke();
    expect(guard.check(goSettings)).toBe(false);
    expect(guard.check(goHome)).toBe(false);
    guard.userSpoke();
    expect(guard.check(goSettings)).toBe(false);
  });

  it('passes four separate spoken "click increment" requests', () => {
    const guard = createLoopGuard();
    const results = [1, 2, 3, 4].map(() => {
      guard.userSpoke();
      return guard.check(increment);
    });
    expect(results).toEqual([false, false, false, false]);
  });

  it('still trips a loop within one request', () => {
    const guard = createLoopGuard();
    guard.userSpoke();
    expect([goHome, goSettings, goHome, goSettings].map((s) => guard.check(s))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });
});

describe('loopGuard: normal varied use passes', () => {
  const sequences = {
    'the live e2e five-step task (increment ×2, settings, toggle, save)': [
      increment,
      increment,
      goSettings,
      toggle,
      save,
    ],
    'increment ×2 then navigate': [increment, increment, goSettings],
    'fill then click save': [fillName, save],
    'home → settings → home once': [goHome, goSettings, goHome],
    'a tour: settings, fill, save, home, increment ×3, settings again': [
      goSettings,
      fillName,
      save,
      goHome,
      increment,
      increment,
      increment,
      goSettings,
    ],
    'the same action again after something else (A-B-A-C-A)': [
      increment,
      goSettings,
      increment,
      save,
      increment,
    ],
    'a fill retried with a different value, then saved': [
      fillName,
      save,
      sig('fill', { selector: 'name', value: 'Grace' }),
      save,
    ],
  };

  for (const [name, sequence] of Object.entries(sequences)) {
    it(name, () => {
      expect(run(sequence).some(Boolean)).toBe(false);
    });
  }
});

describe('loopGuard: utterances', () => {
  const line = 'Let me show you the settings page.';

  it('normalises case, punctuation and whitespace', () => {
    expect(normaliseUtterance('  Let me show you…   the SETTINGS page! ')).toBe(
      'let me show you the settings page',
    );
  });

  it('trips when the same sentence is the 3rd in the recent turns, despite case and punctuation', () => {
    const guard = createLoopGuard();
    expect(guard.checkUtterance(line)).toBe(false);
    expect(guard.checkUtterance('let me show you the settings page')).toBe(false);
    expect(guard.checkUtterance('Let me show you, the settings page!')).toBe(true);
  });

  it('counts repeats within the recent window, not only back to back', () => {
    const guard = createLoopGuard();
    expect(guard.checkUtterance(line)).toBe(false);
    expect(guard.checkUtterance('The counter is now at one.')).toBe(false);
    expect(guard.checkUtterance(line)).toBe(false);
    expect(guard.checkUtterance('The counter is now at two.')).toBe(false);
    expect(guard.checkUtterance(line)).toBe(true);
  });

  it('trips once per episode: further repeats stay quiet until a different turn re-arms it', () => {
    const guard = createLoopGuard();
    [line, line, line].forEach((t) => guard.checkUtterance(t));
    expect(guard.checkUtterance(line)).toBe(false);
    expect(guard.checkUtterance(line)).toBe(false);
    expect(guard.checkUtterance('Something else entirely, really.')).toBe(false);
    expect(guard.checkUtterance(line)).toBe(true);
  });

  it('the user speaking ends the episode and clears the recent turns', () => {
    const guard = createLoopGuard();
    [line, line, line].forEach((t) => guard.checkUtterance(t));
    guard.userSpoke();
    expect(guard.checkUtterance(line)).toBe(false);
    expect(guard.checkUtterance(line)).toBe(false);
    expect(guard.checkUtterance(line)).toBe(true);
  });

  // m11: narration of the steps of one request ("Clicking the increment
  // button now." before each click) is not talk going in circles; a repeat of
  // the action itself is the action guard's to catch.
  it('a tool call between turns ends the episode: narration of each step passes', () => {
    const guard = createLoopGuard();
    const narration = 'Clicking the increment button now.';
    const results = [1, 2, 3, 4].map(() => {
      const tripped = guard.checkUtterance(narration);
      guard.agentActed();
      return tripped;
    });
    expect(results).toEqual([false, false, false, false]);
    // With no action in between, the same line three times is a loop again.
    expect(guard.checkUtterance(narration)).toBe(false);
    expect(guard.checkUtterance(narration)).toBe(false);
    expect(guard.checkUtterance(narration)).toBe(true);
  });

  it('acting does not clear the action window', () => {
    const guard = createLoopGuard();
    expect([increment, increment, increment].map((s) => guard.check(s))).toEqual([
      false,
      false,
      false,
    ]);
    guard.agentActed();
    expect(guard.check(increment)).toBe(true);
  });

  it('ignores short acknowledgements like "Done." that a multi-step task repeats', () => {
    const guard = createLoopGuard();
    const results = ['Done.', 'Done.', 'Done.', 'Okay!', 'Okay.', 'okay'].map((t) =>
      guard.checkUtterance(t),
    );
    expect(results.some(Boolean)).toBe(false);
  });

  it('passes varied narration of a task', () => {
    const guard = createLoopGuard();
    const turns = [
      'Hi! I can walk you through this app.',
      'Sure, incrementing the counter twice.',
      'Now heading to the settings page.',
      'Notifications are on, and I saved your settings.',
      'Anything else you would like to see?',
    ];
    expect(turns.map((t) => guard.checkUtterance(t)).some(Boolean)).toBe(false);
  });

  it('reset() clears the recent turns and re-arms', () => {
    const guard = createLoopGuard();
    [line, line, line].forEach((t) => guard.checkUtterance(t));
    guard.reset();
    expect(guard.checkUtterance(line)).toBe(false);
    expect(guard.checkUtterance(line)).toBe(false);
    expect(guard.checkUtterance(line)).toBe(true);
  });
});

describe('actionSignature', () => {
  it('is stable for the same name and args, and differs for different args', () => {
    expect(sig('click', { selector: 'save-button' })).toBe(
      sig('click', { selector: 'save-button' }),
    );
    expect(sig('click', { selector: 'a' })).not.toBe(sig('click', { selector: 'b' }));
  });

  it('normalises args: key order and surrounding whitespace do not matter', () => {
    expect(sig('fill', { selector: 'name', value: ' Ada ' })).toBe(
      sig('fill', { value: 'Ada', selector: 'name' }),
    );
  });

  it('treats missing args as empty', () => {
    expect(sig('scroll')).toBe(sig('scroll', {}));
  });
});
