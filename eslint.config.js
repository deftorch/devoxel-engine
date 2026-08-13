import js from '@eslint/js';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  js.configs.recommended,

  // Browser-side source: game, editor, and the core framework itself.
  {
    files: ['src/**/*.js'],
    ignores: ['src/test/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.worker, // src/*/*.worker.js run in a Worker global scope
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // this project logs plugin lifecycle events intentionally
      eqeqeq: ['warn', 'smart'],
    },
  },

  // Node-side: build/CI scripts.
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Regression scripts (scripts/regression-check*.mjs): run under Node but
  // load the real editor.html into jsdom and simulate a browser DOM, so
  // both global sets are needed here - same reasoning as src/test/** below.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Test suite: some tests run under `node --test` (PluginRegistry, VoxelEngine),
  // others (raytrace.test.js) are browser/WebGPU tests only meant to run via
  // test_runner.html — so both global sets are needed here.
  {
    files: ['src/test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        GPUBufferUsage: 'readonly',
        GPUTextureUsage: 'readonly',
        GPUShaderStage: 'readonly',
        GPUMapMode: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Turn off stylistic rules that would conflict with Prettier's output —
  // Prettier handles formatting, ESLint handles correctness.
  eslintConfigPrettier,

  {
    ignores: ['node_modules/**', 'docs/**'],
  },
];
