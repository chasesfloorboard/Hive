'use strict';

// Hive desktop lint config (ESLint 9 flat config, deliberately dependency-light — built-in rules only, no
// plugins to resolve so it runs anywhere, incl. CI). Its job is narrow and high-signal, not style policing.
//
//   ERROR — bug shapes that silently corrupt behaviour and should never merge: duplicate object keys (one
//           value silently overrides the other), duplicate function args, NaN comparisons, bad typeof,
//           unsafe negation, assignment in a condition. These fail CI. The existing violations of these
//           were fixed when the linter was added (Nov 2026).
//   WARN  — real smells with a pre-existing backlog too large to clear at once, surfaced so they stop
//           growing and can be chipped away WITHOUT blocking work: silent `catch {}` (the pattern that hid
//           the lock-player bug), unused/dead vars, unreachable code and constant-condition/self-assign
//           (mostly intentional feature-disables here — review before deleting), and duplicate else-if.
//
// `no-undef` is intentionally off: the renderer leans on many preload-injected/browser globals that would
// need an exhaustive globals map to avoid false positives — not worth the noise for a single-author app.

const ERROR_RULES = {
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-unsafe-negation': 'error',
  'no-cond-assign': ['error', 'except-parens'],
};

const WARN_RULES = {
  'no-empty': ['warn', { allowEmptyCatch: false }],
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-unreachable': 'warn',
  'no-constant-binary-expression': 'warn',
  'no-self-assign': 'warn',
  'no-dupe-else-if': 'warn',
};

const RULES = { ...ERROR_RULES, ...WARN_RULES };
// Source files also get a size nudge: a file over ~900 lines is a "split me" signal (ARCHITECTURE.md
// convention #2). Warn-level, so the known monoliths (main.js/renderer.js/hive-link.js) don't block CI while
// they're being broken up, but any NEW file that balloons stands out. Tests are exempt (fixtures run long).
const SRC_RULES = { ...RULES, 'max-lines': ['warn', { max: 900, skipComments: true, skipBlankLines: true }] };

module.exports = [
  { ignores: ['node_modules/**', 'resources/**', 'dist/**', 'build/**', '**/*.min.js'] },
  {
    files: ['app/main/**/*.js', 'scripts/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs' },
    rules: SRC_RULES,
  },
  {
    files: ['app/renderer/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script' },
    rules: SRC_RULES,
  },
  {
    // Tests are mostly CommonJS (require) with a few ES modules; 'module' parses both without a syntax error.
    files: ['test/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: RULES,
  },
];
