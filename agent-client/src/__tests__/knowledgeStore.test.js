import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as knowledgeStore from '../knowledgeStore.js';

function makeFile(name, text) {
  return new File([text], name, { type: 'text/plain' });
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
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/txt.*md/);
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
    const { file } = await knowledgeStore.addFile(makeFile('a.txt', 'A'));
    expect(knowledgeStore.listFiles().map((f) => f.name)).toEqual(['a.txt']);
    knowledgeStore.removeFile(file.id);
    expect(knowledgeStore.listFiles()).toHaveLength(0);
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
