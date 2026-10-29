// Run from the repo root (`npm run lint` does `cd ..`): ESLint 10 ignores files outside the
// base path, and this config also lints the files that have no ESLint of their own: the
// unbundled sandbox and target-app scripts, and the root Playwright suite (e2e/ and
// playwright.config.js). Patterns are therefore relative to the repo root.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  { ignores: ['agent-client/dist/'] },
  {
    files: ['agent-client/**/*.{js,jsx}', 'sandbox/**/*.js', 'target-app/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ['agent-client/src/**/*.{js,jsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // The React Compiler memoizes for us (CLAUDE.md), so manual memoization is an error.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              importNames: ['useMemo', 'useCallback', 'memo'],
              message: 'The React Compiler memoizes; do not memoize by hand (CLAUDE.md).',
            },
          ],
        },
      ],
    },
  },
  {
    // Classic scripts loaded with <script defer>, not modules.
    files: ['sandbox/**/*.js', 'target-app/**/*.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['agent-client/vite.config.js', 'agent-client/eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Node test code, plus browser globals for the callbacks it hands to page.evaluate,
    // page.addInitScript and evaluateAll, which run in the page.
    files: ['e2e/**/*.js', 'playwright.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
]);
