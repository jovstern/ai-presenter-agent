import { describe, expect, it, vi } from 'vitest';
import { createGeminiMint } from '../geminiMint.js';
import LIVE_MODEL from '../../agent-client/src/liveModel.json' with { type: 'json' };

/** @param {{ name?: string }} token What the fake authTokens.create resolves to. */
function fakeClient(token) {
  return { authTokens: { create: vi.fn(async () => token) } };
}

describe('createGeminiMint', () => {
  it('mints a single-use token locked to the client model only (M7, ADR 0004)', async () => {
    const ai = fakeClient({ name: 'auth_tokens/abc' });
    const expiresAt = new Date('2026-11-02T12:00:00.000Z');

    await expect(createGeminiMint(ai)({ expiresAt })).resolves.toBe('auth_tokens/abc');

    expect(ai.authTokens.create).toHaveBeenCalledWith({
      config: {
        uses: 1,
        newSessionExpireTime: '2026-11-02T12:00:00.000Z',
        liveConnectConstraints: { model: LIVE_MODEL.model },
        // Without it Gemini locks the whole config and drops the client's
        // tools and system instruction (seen in a real run, M6 T4).
        lockAdditionalFields: [],
      },
    });
  });

  it('rejects a token with no name instead of handing the page an empty one', async () => {
    const mint = createGeminiMint(fakeClient({}));

    await expect(mint({ expiresAt: new Date() })).rejects.toThrow('without a name');
  });
});
