import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// sandbox/bridge.js is an unbundled classic script, so it can't import
// bridgeProtocol.js and carries a copy of its `#region bridge protocol`
// instead (docs/adr/0002-type-checking-with-checkjs.md). These read both files
// as text and fail the moment the copies differ.
function read(relativePath) {
  return readFileSync(path.resolve(import.meta.dirname, relativePath), 'utf8');
}

const PROTOCOL_SOURCE = read('../bridgeProtocol.js');
const BRIDGE_SOURCE = read('../../../sandbox/bridge.js');

// The region's body, without its opening line (which says which copy it is)
// and with each line's indentation dropped (bridge.js nests it in an IIFE).
function protocolRegion(source) {
  const match = source.match(/\/\/ #region bridge protocol[^\n]*\n([\s\S]*?)\/\/ #endregion/);
  if (!match) throw new Error('no `// #region bridge protocol` ... `// #endregion` block');
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

// The `type` literal of every message typedef in a region.
function messageTypes(region) {
  return [...region.matchAll(/\{ type: '([^']+)'/g)].map((match) => match[1]).sort();
}

describe('bridge protocol typedefs', () => {
  it('sandbox/bridge.js carries the same typedefs as bridgeProtocol.js', () => {
    expect(protocolRegion(BRIDGE_SOURCE)).toBe(protocolRegion(PROTOCOL_SOURCE));
  });

  it('both list the message types of the spec’s bridge protocol table', () => {
    const expected = [
      'action',
      'action-result',
      'ds-bridge-connect',
      'navigated',
      'request-snapshot',
      'snapshot',
    ];
    expect(messageTypes(protocolRegion(PROTOCOL_SOURCE))).toEqual(expected);
    expect(messageTypes(protocolRegion(BRIDGE_SOURCE))).toEqual(expected);
  });
});
