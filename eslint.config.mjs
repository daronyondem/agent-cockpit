import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const criticalTypeCheckedRules = new Set([
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/no-misused-promises',
  '@typescript-eslint/await-thenable',
  '@typescript-eslint/no-unnecessary-type-assertion'
]);

const nodeGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Blob: 'readonly',
  Buffer: 'readonly',
  clearImmediate: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  Event: 'readonly',
  exports: 'writable',
  fetch: 'readonly',
  FormData: 'readonly',
  global: 'readonly',
  Headers: 'readonly',
  module: 'readonly',
  process: 'readonly',
  Request: 'readonly',
  require: 'readonly',
  Response: 'readonly',
  setImmediate: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  WebSocket: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly'
};

const browserGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Blob: 'readonly',
  cancelAnimationFrame: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  CustomEvent: 'readonly',
  document: 'readonly',
  DOMParser: 'readonly',
  Event: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  FormData: 'readonly',
  Headers: 'readonly',
  HTMLElement: 'readonly',
  Image: 'readonly',
  KeyboardEvent: 'readonly',
  localStorage: 'readonly',
  location: 'readonly',
  MutationObserver: 'readonly',
  navigator: 'readonly',
  Notification: 'readonly',
  requestAnimationFrame: 'readonly',
  Request: 'readonly',
  ResizeObserver: 'readonly',
  Response: 'readonly',
  sessionStorage: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  WebSocket: 'readonly',
  window: 'readonly'
};

const jestGlobals = {
  afterAll: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  beforeEach: 'readonly',
  describe: 'readonly',
  expect: 'readonly',
  jest: 'readonly',
  it: 'readonly',
  test: 'readonly'
};

const typeCheckedCorrectnessRules = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error'
};

const typeCheckedRecommendedOff = Object.fromEntries(
  Object.keys(Object.assign({}, ...tseslint.configs.recommendedTypeChecked.map((config) => config.rules ?? {})))
    .filter((rule) => rule.startsWith('@typescript-eslint/') && !criticalTypeCheckedRules.has(rule))
    .map((rule) => [rule, 'off'])
);

const typeCheckedLegacyOverrides = {
  // Keep the first lint gate focused on promise correctness. The broader
  // recommended rules are noisy against current dynamic JSON/CLI protocol code.
  ...typeCheckedRecommendedOff,
  'no-var': 'off',
  'prefer-const': 'off',
  'prefer-rest-params': 'off',
  'prefer-spread': 'off'
};

const typeScriptRecommendedOff = Object.fromEntries(
  Object.keys(Object.assign({}, ...tseslint.configs.recommended.map((config) => config.rules ?? {})))
    .filter((rule) => rule.startsWith('@typescript-eslint/'))
    .map((rule) => [rule, 'off'])
);

const jsRecommendedWarningRules = Object.fromEntries(
  Object.keys(js.configs.recommended.rules).map((rule) => [rule, 'warn'])
);

const reactHooksRules = {
  'react-hooks/rules-of-hooks': 'error',
  'react-hooks/exhaustive-deps': 'warn'
};

const jsxParserOptions = {
  ecmaFeatures: {
    jsx: true
  }
};

function scopedTypeChecked(name, files, parserOptions, globals, rules = {}) {
  return [
    ...tseslint.configs.recommendedTypeChecked.map((config, index) => ({
      ...config,
      name: `${name}-${config.name ?? index}`,
      files,
      languageOptions: {
        ...config.languageOptions,
        parserOptions: {
          ...(config.languageOptions?.parserOptions ?? {}),
          ...parserOptions
        },
        globals
      }
    })),
    {
      name,
      files,
      rules: {
        ...typeCheckedLegacyOverrides,
        ...typeCheckedCorrectnessRules,
        ...rules
      }
    }
  ];
}

function scopedTypeScript(name, files, globals) {
  return [
    ...tseslint.configs.recommended.map((config, index) => ({
      ...config,
      name: `${name}-${config.name ?? index}`,
      files,
      languageOptions: {
        ...config.languageOptions,
        globals
      }
    })),
    {
      name,
      files,
      rules: {
        ...typeScriptRecommendedOff
      }
    }
  ];
}

export default [
  {
    name: 'global-ignores',
    ignores: [
      'node_modules/',
      'public/',
      'coverage/',
      'test-results/',
      'data*/',
      'docs/',
      'plans/',
      'dist/',
      'web/AgentCockpitWeb/dist/',
      'mobile/AgentCockpitPWA/node_modules/',
      'mobile/AgentCockpitPWA/dist/'
    ]
  },
  {
    name: 'unused-disable-reporting',
    linterOptions: {
      reportUnusedDisableDirectives: 'warn'
    }
  },
  {
    ...js.configs.recommended,
    name: 'tooling-js-commonjs',
    files: [
      'ecosystem.config.js',
      'jest.config.js',
      'scripts/**/*.js',
      'src/**/*.cjs'
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals
    },
    rules: {
      ...js.configs.recommended.rules,
      ...jsRecommendedWarningRules
    }
  },
  {
    ...js.configs.recommended,
    name: 'tooling-js-module',
    files: [
      'eslint.config.mjs',
      'mobile/AgentCockpitPWA/scripts/**/*.mjs'
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...nodeGlobals,
        ...browserGlobals
      }
    },
    rules: {
      ...js.configs.recommended.rules,
      ...jsRecommendedWarningRules
    }
  },
  {
    ...js.configs.recommended,
    name: 'web-js',
    files: ['web/AgentCockpitWeb/src/**/*.{js,jsx}'],
    plugins: {
      'react-hooks': reactHooks
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: jsxParserOptions,
      globals: browserGlobals
    },
    rules: {
      ...js.configs.recommended.rules,
      ...jsRecommendedWarningRules,
      ...reactHooksRules
    }
  },
  ...scopedTypeChecked(
    'server-ts',
    [
      'src/**/*.ts',
      'server.ts'
    ],
    {
      projectService: true,
      tsconfigRootDir: import.meta.dirname
    },
    nodeGlobals
  ),
  ...scopedTypeScript(
    'tooling-ts',
    [
      'scripts/*.ts',
      'playwright.config.ts'
    ],
    nodeGlobals
  ),
  ...scopedTypeChecked(
    'web-ts',
    [
      'web/AgentCockpitWeb/src/**/*.{ts,tsx}',
      'web/AgentCockpitWeb/vite.config.ts'
    ],
    {
      projectService: true,
      tsconfigRootDir: import.meta.dirname
    },
    browserGlobals,
    reactHooksRules
  ).map((config) => ({
    ...config,
    plugins: {
      ...(config.plugins ?? {}),
      'react-hooks': reactHooks
    }
  })),
  ...scopedTypeChecked(
    'mobile-ts',
    [
      'mobile/AgentCockpitPWA/src/**/*.{ts,tsx}',
      'mobile/AgentCockpitPWA/vite.config.ts'
    ],
    {
      projectService: true,
      tsconfigRootDir: import.meta.dirname
    },
    browserGlobals,
    reactHooksRules
  ).map((config) => ({
    ...config,
    plugins: {
      ...(config.plugins ?? {}),
      'react-hooks': reactHooks
    }
  })),
  ...scopedTypeChecked(
    'tests-ts',
    ['test/**/*.ts'],
    {
      projectService: true,
      tsconfigRootDir: import.meta.dirname
    },
    {
      ...nodeGlobals,
      ...jestGlobals
    },
    {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unbound-method': 'off'
    }
  )
];
