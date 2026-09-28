// @ts-check
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/', '**/dist/', '**/coverage/'] },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: {
      globals: globals.node,
      // Type-aware linting: each file is checked against the nearest tsconfig.json.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  comments.recommended,
  {
    rules: {
      // Async queue/worker code is where an un-awaited promise silently loses work.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // CLAUDE.md: no `any` without a comment explaining why, so disables must carry a `-- reason`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@eslint-community/eslint-comments/require-description': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Plain JS config files are outside every tsconfig, so skip the type-aware rules for them.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  // Last, so it switches off any stylistic rule that would fight Prettier.
  prettier,
);
