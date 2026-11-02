import { describe, expect, it } from 'vitest';
import { createExpiringMap } from '../expiringMap.js';

function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('createExpiringMap', () => {
  it('returns a value until its TTL has passed, then forgets it', () => {
    const c = clock();
    const map = createExpiringMap({ ttlMs: 100, maxSize: 10, now: c.now });
    map.set('a', 1);

    c.advance(100);
    expect(map.get('a')).toBe(1);
    c.advance(1);
    expect(map.get('a')).toBeUndefined();
  });

  it('prunes expired entries on access, so the size shrinks without a timer', () => {
    const c = clock();
    const map = createExpiringMap({ ttlMs: 100, maxSize: 1_000, now: c.now });
    for (let i = 0; i < 50; i += 1) map.set(`old-${i}`, i);
    c.advance(101);
    map.set('fresh', 1);

    expect(map.size).toBe(1);
    expect(map.get('fresh')).toBe(1);
  });

  it('evicts the oldest entry once the cap is reached', () => {
    const c = clock();
    const map = createExpiringMap({ ttlMs: 1_000, maxSize: 3, now: c.now });
    map.set('a', 1);
    map.set('b', 2);
    map.set('c', 3);
    map.set('d', 4);

    expect(map.size).toBe(3);
    expect(map.get('a')).toBeUndefined();
    expect(map.get('d')).toBe(4);
  });

  it('re-setting a key restarts its TTL and moves it to the back of the eviction order', () => {
    const c = clock();
    const map = createExpiringMap({ ttlMs: 100, maxSize: 2, now: c.now });
    map.set('a', 1);
    c.advance(60);
    map.set('b', 2);
    map.set('a', 3); // restarted at t+60, now newer than b
    c.advance(60); // the original 'a' entry would have expired here

    expect(map.get('a')).toBe(3);
    map.set('c', 4); // evicts b, the oldest
    expect(map.get('b')).toBeUndefined();
    expect(map.get('a')).toBe(3);
  });
});
