import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // `public/vendor/**` is a byte-for-byte copy of a published package, kept
    // there so the photo compressor's Web Worker loads it from US and not from
    // cdn.jsdelivr.net (round 97). It is somebody else's minified build; linting
    // it says nothing, and `tests/unit/vendored-lib.test.ts` is what guards it.
    ignores: ['.next/**', 'node_modules/**', 'public/sw.js', 'public/vendor/**', 'next-env.d.ts'],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];

export default config;
