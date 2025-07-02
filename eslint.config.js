import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  eslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        // Bun runtime globals
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        ReadableStream: 'readonly',
        Bun: 'readonly',
        URLSearchParams: 'readonly',
        TextDecoder: 'readonly',
        // Browser/Node globals
        URL: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        DOMException: 'readonly',
        RequestInit: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // TypeScript-specific rules (start lenient for CI setup)
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      
      // General rules
      'no-console': 'off', // CLI tool needs console output
      'no-unused-vars': 'off', // Use TypeScript version instead
      'prefer-const': 'warn', // Warn instead of error for now
      'no-undef': 'warn', // Should be handled by TypeScript
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'scripts/**',
      '**/*.js.map',
      '.ji/**',
    ],
  },
];