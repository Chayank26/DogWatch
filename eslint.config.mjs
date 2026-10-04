import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/next-env.d.ts',
      'packages/database/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
