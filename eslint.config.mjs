// ESLint flat config — loads eslint-plugin-obsidianmd's recommended ruleset
// (same rules the community-plugin auto-reviewer runs) with typed linting
// enabled. Run with `pnpm run lint` or `npx eslint src/`.

import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
