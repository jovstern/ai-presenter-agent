// Narrows a value the test knows is there (a recorded mock call, a queried
// node, an optional field) so a missing one fails with a message instead of
// a TypeError, and the type checker sees it as present.
/**
 * @template T
 * @param {T} value
 * @param {string} [what]
 * @returns {NonNullable<T>}
 */
export function defined(value, what = 'value') {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be defined`);
  return value;
}

/**
 * Narrows a queried node to the element type the test expects, failing on a
 * missing node or another element instead of casting past either.
 * @template {Element} T
 * @param {Element | null | undefined} node
 * @param {{ new (): T, prototype: T }} type
 * @returns {T}
 */
export function elementOf(node, type) {
  if (!(node instanceof type)) throw new Error(`expected a ${type.name}, got ${String(node)}`);
  return node;
}
