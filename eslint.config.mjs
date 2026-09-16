import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// House style, enforced by the linter rather than by review.
//
// Prettier owns *formatting* (quotes, width, indentation) and is layered last so it wins any
// overlap. What lives here is the part Prettier has no opinion about: whether a body gets braces,
// and where blank lines go. Prettier preserves single blank lines rather than inserting or removing
// them, so the padding rules below are its complement, not its competitor.
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.nx/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Prettier's config sits *before* the house rules, not after. It disables `curly` wholesale —
  // it has to, because `curly: 'multi-line'` and friends can genuinely disagree with Prettier's
  // output — but `curly: 'all'` cannot: ESLint adds the braces, Prettier then formats the braced
  // version happily. Layering it last would have silently switched off the main rule we want.
  prettier,

  {
    files: ['**/*.ts', '**/*.mts', '**/*.js', '**/*.mjs'],
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      // Braces always — no bracketless `if`/`else`, `for`, `while`, `do`.
      curly: ['error', 'all'],

      // No expression-bodied arrows. `(err) => (err ? reject(err) : resolve())` returns a value
      // with no `return` keyword; a block body forces the intent to be written down.
      'arrow-body-style': ['error', 'always'],

      // The @stylistic variants of these two, not the ESLint core ones: core doesn't know about
      // TypeScript statement types, so `interface` and `type` wouldn't be matchable below.
      '@stylistic/padding-line-between-statements': [
        'error',

        // A blank line before every return.
        { blankLine: 'always', prev: '*', next: 'return' },

        // Declaration blocks stand apart from the code around them.
        {
          blankLine: 'always',
          prev: '*',
          next: ['function', 'class', 'interface', 'type'],
        },
        {
          blankLine: 'always',
          prev: ['function', 'class', 'interface', 'type'],
          next: '*',
        },

        // So do block-like statements (if / for / while / try / switch).
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'always', prev: '*', next: 'block-like' },
      ],

      '@stylistic/lines-between-class-members': [
        'error',
        'always',
        { exceptAfterSingleLine: false },
      ],
    },
  },
);
