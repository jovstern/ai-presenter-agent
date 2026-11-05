// The client's model (agent-client/src/liveModel.json), shared like
// target-app/routes.json so the token's constraint can't drift from it.
import LIVE_MODEL from '../agent-client/src/liveModel.json' with { type: 'json' };

/** @import { GoogleGenAI } from '@google/genai' */
/** @import { MintToken } from './app.js' */

/**
 * The real Gemini mint behind /api/live-token. Takes the client rather than
 * the key so the token config is tested without the network
 * (__tests__/geminiMint.test.js).
 * @param {Pick<GoogleGenAI, 'authTokens'>} ai A v1alpha client: ephemeral tokens are v1alpha only.
 * @returns {MintToken}
 */
export function createGeminiMint(ai) {
  return async ({ expiresAt }) => {
    const token = await ai.authTokens.create({
      config: {
        // One new session per token; resuming a session doesn't count as a
        // use, and the client mints a fresh token for every attempt anyway.
        uses: 1,
        newSessionExpireTime: expiresAt.toISOString(),
        // expireTime is left at Google's default (30 min after the mint): past
        // it Gemini may close the socket, and the client resumes on a fresh token.
        // Locked to the client's model only (docs/code-review-notes.md M7,
        // docs/adr/0004-live-token-constraints.md). `lockAdditionalFields: []`
        // is what makes it model-only: with constraints set and the field left
        // out, Gemini locks every LiveConnectConfig field to the token's
        // (empty) config and silently ignores the client's tools, system
        // instruction and resumption handle.
        liveConnectConstraints: { model: LIVE_MODEL.model },
        lockAdditionalFields: [],
      },
    });
    if (!token.name) throw new Error('Gemini returned an auth token without a name');
    return token.name;
  };
}
