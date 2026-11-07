import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as knowledgeStore from '../knowledgeStore.js';
import { defined } from './defined.js';

/**
 * @param {string} name
 * @param {string} text
 */
function makeFile(name, text) {
  return new File([text], name, { type: 'text/plain' });
}

/**
 * The file an add stored; an add that was refused fails the test with its reason.
 * @param {Awaited<ReturnType<typeof knowledgeStore.addFile>>} result
 */
function addedFile(result) {
  if (!result.ok) throw new Error(`not added: ${result.reason}`);
  return result.file;
}

beforeEach(() => {
  localStorage.clear();
});

describe('knowledgeStore', () => {
  it('accepts .txt and .md files', async () => {
    expect((await knowledgeStore.addFile(makeFile('notes.txt', 'hello'))).ok).toBe(true);
    expect((await knowledgeStore.addFile(makeFile('readme.md', 'world'))).ok).toBe(true);
    expect(knowledgeStore.listFiles()).toHaveLength(2);
  });

  it('rejects files with an unaccepted extension', async () => {
    const result = await knowledgeStore.addFile(makeFile('doc.pdf', 'binary-ish'));
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/txt.*md/) });
    expect(knowledgeStore.listFiles()).toHaveLength(0);
  });

  it('refuses outright when a file would exceed the total size cap, without truncating', async () => {
    const big = 'a'.repeat(knowledgeStore.MAX_TOTAL_BYTES);
    await knowledgeStore.addFile(makeFile('big.txt', big));
    const result = await knowledgeStore.addFile(makeFile('more.txt', 'x'));
    expect(result.ok).toBe(false);
    expect(knowledgeStore.listFiles()).toHaveLength(1);
  });

  it('adds, lists, and removes files', async () => {
    const file = addedFile(await knowledgeStore.addFile(makeFile('a.txt', 'A')));
    expect(knowledgeStore.listFiles().map((f) => f.name)).toEqual(['a.txt']);
    knowledgeStore.removeFile(file.id);
    expect(knowledgeStore.listFiles()).toHaveLength(0);
  });

  it('adds files on an insecure page, where crypto.randomUUID does not exist (L6)', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    try {
      const first = addedFile(await knowledgeStore.addFile(makeFile('a.txt', 'A')));
      const second = addedFile(await knowledgeStore.addFile(makeFile('b.txt', 'B')));
      expect(first.id).toMatch(/^[0-9a-f]{32}$/);
      expect(second.id).not.toBe(first.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // useSyncExternalStore re-renders, and warns of an infinite loop, when two
  // reads with no change in between return different values.
  it('lists the same array until the files change, then a new one', async () => {
    const empty = knowledgeStore.listFiles();
    expect(knowledgeStore.listFiles()).toBe(empty);

    await knowledgeStore.addFile(makeFile('a.txt', 'A'));
    const one = knowledgeStore.listFiles();
    expect(one).not.toBe(empty);
    expect(one.map((f) => f.name)).toEqual(['a.txt']);
    expect(knowledgeStore.listFiles()).toBe(one);
    // A rules write leaves the file list as it was.
    knowledgeStore.setRules('be brief');
    expect(knowledgeStore.listFiles()).toBe(one);
  });

  it('reports total bytes across stored files', async () => {
    await knowledgeStore.addFile(makeFile('a.txt', 'AAAA'));
    await knowledgeStore.addFile(makeFile('b.txt', 'BB'));
    expect(knowledgeStore.totalBytes()).toBe(6);
  });

  it('fires the change event exactly once per write', async () => {
    const handler = vi.fn();
    window.addEventListener(knowledgeStore.CHANGE_EVENT, handler);
    await knowledgeStore.addFile(makeFile('a.txt', 'A'));
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(knowledgeStore.CHANGE_EVENT, handler);
  });

  it('stores and retrieves rules, capped at MAX_RULES_CHARS', () => {
    expect(knowledgeStore.setRules('be concise').ok).toBe(true);
    expect(knowledgeStore.getRules()).toBe('be concise');

    const tooLong = 'a'.repeat(knowledgeStore.MAX_RULES_CHARS + 1);
    const result = knowledgeStore.setRules(tooLong);
    expect(result.ok).toBe(false);
    expect(knowledgeStore.getRules()).toBe('be concise'); // unchanged
  });

  it('reports content presence from files OR rules, not files alone', () => {
    expect(knowledgeStore.hasContent()).toBe(false);
    knowledgeStore.setRules('always speak French');
    expect(knowledgeStore.hasContent()).toBe(true);
  });

  it('builds a context message with rules framed ahead of file context', async () => {
    knowledgeStore.setRules('never discuss pricing');
    await knowledgeStore.addFile(makeFile('a.txt', 'file content here'));
    const message = knowledgeStore.buildContextMessage();
    expect(message.indexOf('STRICT RULES')).toBeLessThan(message.indexOf('Knowledge context'));
    expect(message).toContain('never discuss pricing');
    expect(message).toContain('file content here');
  });

  it('omits sections that have no content', async () => {
    await knowledgeStore.addFile(makeFile('a.txt', 'just files'));
    const message = knowledgeStore.buildContextMessage();
    expect(message).not.toContain('STRICT RULES');
    expect(message).toContain('just files');
  });
});

// What the browser itself can refuse: storage that is full, a file that can't
// be read, storage that is blocked outright (a privacy setting, a sandboxed
// frame). Each is a failure the dialog can show, never a throw.
describe('knowledgeStore when the browser refuses', () => {
  it('fails in plain words when browser storage is full, and stores nothing', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const result = await knowledgeStore.addFile(makeFile('notes.txt', 'hello'));
    vi.restoreAllMocks();
    expect(result).toEqual({
      ok: false,
      reason: 'Browser storage is full. Remove a file to make room',
    });
    expect(knowledgeStore.listFiles()).toHaveLength(0);
  });

  it("fails in plain words when the file can't be read", async () => {
    const file = makeFile('notes.txt', 'hello');
    vi.spyOn(file, 'text').mockRejectedValue(
      new DOMException('The file could not be read.', 'NotReadableError'),
    );
    const result = await knowledgeStore.addFile(file);
    expect(result).toEqual({
      ok: false,
      reason: "The file couldn't be read. Check that it still exists, then add it again",
    });
    expect(knowledgeStore.listFiles()).toHaveLength(0);
  });

  /** Blocks localStorage (its getter throws, as a browser's does) for the run of `fn`. */
  async function withStorageBlocked(/** @type {() => unknown} */ fn) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      return await fn();
    } finally {
      Object.defineProperty(
        globalThis,
        'localStorage',
        defined(descriptor, 'the localStorage descriptor'),
      );
    }
  }

  it('fails in plain words, not a throw, when localStorage is blocked: add, remove, rules', async () => {
    const blocked = "This browser isn't letting the site save files";
    expect(await withStorageBlocked(() => knowledgeStore.addFile(makeFile('a.txt', 'A')))).toEqual({
      ok: false,
      reason: blocked,
    });
    expect(await withStorageBlocked(() => knowledgeStore.removeFile('some-id'))).toEqual({
      ok: false,
      reason: blocked,
    });
    expect(await withStorageBlocked(() => knowledgeStore.setRules('Be brief.'))).toEqual({
      ok: false,
      reason: "This browser isn't letting the site save rules",
    });
  });

  it('reports a removal that went through as ok', async () => {
    const added = addedFile(await knowledgeStore.addFile(makeFile('a.txt', 'A')));
    expect(knowledgeStore.removeFile(added.id)).toEqual({ ok: true });
  });

  it('reads as empty, not a throw, when localStorage is blocked', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(knowledgeStore.listFiles()).toEqual([]);
      expect(knowledgeStore.getRules()).toBe('');
      expect(knowledgeStore.hasContent()).toBe(false);
      expect(knowledgeStore.totalBytes()).toBe(0);
      expect(knowledgeStore.buildContextMessage()).toBe('');
    } finally {
      Object.defineProperty(
        globalThis,
        'localStorage',
        defined(descriptor, 'the localStorage descriptor'),
      );
    }
  });
});
