import { z } from 'zod';

// The server's env, parsed once at startup (stack-conventions node-api.md:
// config.ts, fail fast). index.js is the only caller; app.js never reads
// process.env, so tests pass options instead.

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {string | undefined} geminiApiKey Absent outside production: the
 *   token route then answers `not_configured`, and the card offers Try again.
 * @property {boolean} production
 * @property {'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'} logLevel
 * @property {number} trustProxyHops Express `trust proxy` hop count; 0 is off.
 */

/** Thrown for a bad env; its message names each bad variable and never a value. */
export class ConfigError extends Error {
  name = 'ConfigError';
}

// A blank line in .env (`PORT=`) means unset, as `Number(PORT) || 3000` did.
/** @param {z.ZodType} schema */
const optional = (schema) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const Env = z
  .object({
    PORT: optional(z.coerce.number().int().min(1).max(65535)),
    GEMINI_API_KEY: optional(z.string()),
    NODE_ENV: optional(z.enum(['development', 'production', 'test'])),
    LOG_LEVEL: optional(z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])),
    // Render puts one TLS-terminating load balancer in front of the service
    // (ADR 0003), so production trusts 1 hop. An override, not a guess to
    // edit in code, in case the deployed X-Forwarded-For shows more.
    TRUST_PROXY_HOPS: optional(z.coerce.number().int().min(0).max(10)),
  })
  // Production without a key would deploy a page whose Talk can never work;
  // failing here fails the deploy, and Render keeps the previous one. Local
  // dev (`npm run dev`) and the e2e (a dummy key) keep the M6 not_configured
  // path, which the card shows as Try again.
  .refine((env) => env.NODE_ENV !== 'production' || env.GEMINI_API_KEY !== undefined, {
    path: ['GEMINI_API_KEY'],
    message: 'is required when NODE_ENV=production',
  });

/**
 * @param {Record<string, string | undefined>} env Usually `process.env`.
 * @returns {Config}
 * @throws {ConfigError}
 */
export function loadConfig(env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // The path and Zod's message only: neither carries the input value, so
    // the key never reaches a log.
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  const { PORT, GEMINI_API_KEY, NODE_ENV, LOG_LEVEL, TRUST_PROXY_HOPS } = parsed.data;
  const production = NODE_ENV === 'production';
  return {
    port: PORT ?? 3000,
    geminiApiKey: GEMINI_API_KEY,
    production,
    logLevel: LOG_LEVEL ?? 'info',
    trustProxyHops: TRUST_PROXY_HOPS ?? (production ? 1 : 0),
  };
}
