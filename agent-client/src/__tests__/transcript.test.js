import { describe, expect, it } from 'vitest';
import { appendFragment, endTurn, entryText, MAX_ENTRIES } from '../transcript.js';

/** @import { TranscriptEntry } from '../transcript.js' */

/**
 * Folds fragments (and `'end'` for a turn boundary) into a transcript.
 * @param {Array<{ role: 'agent' | 'user', text: string } | 'end'>} steps
 * @param {TranscriptEntry[]} [start]
 */
function play(steps, start = []) {
  return steps.reduce(
    (list, step) => (step === 'end' ? endTurn(list) : appendFragment(list, step)),
    start,
  );
}

const agent = (/** @type {string} */ text) => ({ role: /** @type {const} */ ('agent'), text });
const user = (/** @type {string} */ text) => ({ role: /** @type {const} */ ('user'), text });
const lines = (/** @type {TranscriptEntry[]} */ list) =>
  list.map((entry) => `${entry.role}: ${entryText(entry)}`);

describe('appendFragment', () => {
  it('starts an entry for the first fragment', () => {
    const list = appendFragment([], agent('Hello'));
    expect(lines(list)).toEqual(['agent: Hello']);
    expect(list[0].fragments).toEqual(['Hello']);
  });

  it('merges consecutive fragments of one speaker into one entry, verbatim within a turn', () => {
    // How Live streams a turn: later fragments carry their own leading space,
    // and a word may arrive in pieces, so nothing is added between them.
    const list = play([
      agent('Hello'),
      agent(' there!'),
      agent(' How can I'),
      agent(' he'),
      agent('lp?'),
    ]);
    expect(lines(list)).toEqual(['agent: Hello there! How can I help?']);
    expect(list[0].fragments).toEqual(['Hello', ' there!', ' How can I', ' he', 'lp?']);
  });

  it('starts a new entry when the speaker changes', () => {
    const list = play([
      agent('Hi.'),
      user('Increment the counter'),
      user(' twice.'),
      agent('On it.'),
    ]);
    expect(lines(list)).toEqual([
      'agent: Hi.',
      'user: Increment the counter twice.',
      'agent: On it.',
    ]);
  });

  it("drops a new entry's leading whitespace", () => {
    const list = play([agent('Hi.'), user(' Go to settings.')]);
    expect(list[1].fragments).toEqual(['Go to settings.']);
  });

  it('ignores a fragment that is empty, or only whitespace with no entry to space', () => {
    expect(play([agent('')])).toEqual([]);
    expect(play([agent('  ')])).toEqual([]);
    expect(lines(play([agent('Hi.'), user(' ')]))).toEqual(['agent: Hi.']);
  });

  it('never mutates the list or its entries', () => {
    const before = play([agent('Hello')]);
    const snapshot = structuredClone(before);
    const after = appendFragment(before, agent(' there'));
    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
    expect(after[0]).not.toBe(before[0]);
  });

  it('gives every entry an id that stays stable as fragments arrive and old entries drop off', () => {
    let list = play([agent('One.'), user('Two.')]);
    const ids = list.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(2);
    list = appendFragment(list, user(' More.'));
    expect(list.map((entry) => entry.id)).toEqual(ids);
  });

  it(`keeps the last ${MAX_ENTRIES} entries`, () => {
    expect(MAX_ENTRIES).toBe(20);
    /** @type {TranscriptEntry[]} */
    let list = [];
    for (let i = 1; i <= 25; i++) {
      list = appendFragment(list, i % 2 ? agent(`Agent ${i}.`) : user(`User ${i}.`));
    }
    expect(list).toHaveLength(20);
    expect(entryText(list[0])).toBe('User 6.');
    expect(entryText(list[19])).toBe('Agent 25.');
    // Ids keep counting past the bound, so a key never repeats.
    expect(new Set(list.map((entry) => entry.id)).size).toBe(20);
    expect(list[19].id).toBeGreaterThan(list[18].id);
  });
});

describe('endTurn', () => {
  it("joins the speaker's next turn to the entry with one space", () => {
    // A narrated tool sequence: each step is its own turn, and the next turn's
    // first fragment has no leading space ("a second time.I am" without this).
    const list = play([
      agent('I will increment the counter.'),
      'end',
      agent('I am navigating to settings.'),
      'end',
    ]);
    expect(lines(list)).toEqual([
      'agent: I will increment the counter. I am navigating to settings.',
    ]);
    // The space travels with the new fragment, so fragments stay append-only.
    expect(list[0].fragments).toEqual([
      'I will increment the counter.',
      ' I am navigating to settings.',
    ]);
  });

  it('adds no second space when either side already has one', () => {
    expect(entryText(play([agent('Done. '), 'end', agent('Next.')])[0])).toBe('Done. Next.');
    expect(entryText(play([agent('Done.'), 'end', agent(' Next.')])[0])).toBe('Done. Next.');
  });

  it('only spaces the first fragment of the next turn', () => {
    const list = play([agent('One.'), 'end', agent('Two'), agent('fold.')]);
    expect(entryText(list[0])).toBe('One. Twofold.');
  });

  it('does not affect a change of speaker', () => {
    const list = play([agent('Hi.'), 'end', user('Hello.')]);
    expect(lines(list)).toEqual(['agent: Hi.', 'user: Hello.']);
  });

  it('is a no-op on an empty list or an already ended turn', () => {
    expect(endTurn([])).toEqual([]);
    const once = play([agent('Hi.'), 'end']);
    expect(endTurn(once)).toBe(once);
  });
});
