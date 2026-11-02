// A Map whose entries expire after a fixed TTL and whose size is capped, for
// the token gate's nonce and per-IP rate-limit state (app.js). Before M5 both
// were plain Maps that only grew: every page load added a nonce and every new
// IP a bucket, with nothing ever removed (deferred from M4).
//
// Pruning happens on access, so there is no timer to clear on shutdown. Every
// entry gets the same TTL and a re-set moves its key to the back, so Map
// insertion order is expiry order: expired entries are always at the front,
// and a sweep stops at the first live one (cost proportional to what it
// removes). At the cap the oldest entry is evicted, which is also the one
// closest to expiring.

/**
 * @template V
 * @typedef {object} ExpiringMap
 * @property {(key: string) => V | undefined} get The value, or undefined if absent or expired.
 * @property {(key: string, value: V) => void} set Stores the value with a fresh TTL.
 * @property {number} size Live entries only.
 */

/**
 * @template V
 * @param {{ ttlMs: number, maxSize: number, now: () => number }} options
 * @returns {ExpiringMap<V>}
 */
export function createExpiringMap({ ttlMs, maxSize, now }) {
  /** @type {Map<string, { value: V, expiresAt: number }>} */
  const entries = new Map();

  /** @param {number} t */
  function sweep(t) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt >= t) break;
      entries.delete(key);
    }
  }

  return {
    get(key) {
      sweep(now());
      return entries.get(key)?.value;
    },
    set(key, value) {
      const t = now();
      sweep(t);
      entries.delete(key);
      if (entries.size >= maxSize) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, { value, expiresAt: t + ttlMs });
    },
    get size() {
      sweep(now());
      return entries.size;
    },
  };
}
