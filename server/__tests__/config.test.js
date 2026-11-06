import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config.js';

const SECRET = 'AIza-not-a-real-key-but-secret';

/** @param {unknown} fn */
function errorOf(fn) {
  try {
    /** @type {() => unknown} */ (fn)();
  } catch (err) {
    return err;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('defaults an empty env to local development: port 3000, info logs, no key, no proxy', () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      geminiApiKey: undefined,
      production: false,
      logLevel: 'info',
      trustProxyHops: 0,
    });
  });

  it('reads every variable index.js uses', () => {
    expect(
      loadConfig({
        PORT: '10000',
        GEMINI_API_KEY: SECRET,
        NODE_ENV: 'production',
        LOG_LEVEL: 'warn',
      }),
    ).toEqual({
      port: 10000,
      geminiApiKey: SECRET,
      production: true,
      logLevel: 'warn',
      // Render's TLS-terminating load balancer (ADR 0003).
      trustProxyHops: 1,
    });
  });

  it('treats empty strings as unset (a blank line in .env)', () => {
    expect(loadConfig({ PORT: '', GEMINI_API_KEY: '', LOG_LEVEL: '' })).toMatchObject({
      port: 3000,
      geminiApiKey: undefined,
      logLevel: 'info',
    });
  });

  it('keeps a missing key a warning outside production (npm run dev, the e2e dummy key)', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).geminiApiKey).toBeUndefined();
    expect(loadConfig({ GEMINI_API_KEY: 'e2e-dummy' }).geminiApiKey).toBe('e2e-dummy');
  });

  it('fails fast in production without a key, naming the variable', () => {
    const err = errorOf(() => loadConfig({ NODE_ENV: 'production' }));

    expect(err).toBeInstanceOf(ConfigError);
    expect(/** @type {Error} */ (err).message).toMatch(/GEMINI_API_KEY/);
    expect(/** @type {Error} */ (err).message).toMatch(/production/);
  });

  it.each([
    ['PORT', { PORT: 'abc' }],
    ['PORT', { PORT: '70000' }],
    ['PORT', { PORT: '30.5' }],
    ['NODE_ENV', { NODE_ENV: 'prod' }],
    ['LOG_LEVEL', { LOG_LEVEL: 'verbose' }],
    ['TRUST_PROXY_HOPS', { TRUST_PROXY_HOPS: '-1' }],
  ])('rejects a bad %s with a message naming it', (name, env) => {
    const err = errorOf(() => loadConfig(env));

    expect(err).toBeInstanceOf(ConfigError);
    expect(/** @type {Error} */ (err).message).toContain(name);
  });

  it('lists every bad variable at once', () => {
    const err = /** @type {Error} */ (errorOf(() => loadConfig({ PORT: 'x', LOG_LEVEL: 'y' })));

    expect(err.message).toContain('PORT');
    expect(err.message).toContain('LOG_LEVEL');
  });

  it('never echoes a value in its message', () => {
    const err = /** @type {Error} */ (
      errorOf(() => loadConfig({ GEMINI_API_KEY: SECRET, PORT: 'secret-port', NODE_ENV: 'x' }))
    );

    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain('secret-port');
  });

  it('lets TRUST_PROXY_HOPS override the default hop count in either mode', () => {
    expect(loadConfig({ TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2);
    expect(
      loadConfig({ NODE_ENV: 'production', GEMINI_API_KEY: SECRET, TRUST_PROXY_HOPS: '0' })
        .trustProxyHops,
    ).toBe(0);
  });
});
