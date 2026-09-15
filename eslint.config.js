import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Node builtins that must always be imported with the `node:` prefix.
const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'os',
  'path',
  'readline',
  'stream',
  'stream/promises',
  'string_decoder',
  'timers',
  'timers/promises',
  'url',
  'util',
  'zlib',
]

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'node_modules', 'scripts/dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.ts', '**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      // Runtime-agnostic: no Bun globals, no bun: modules, no bare builtins.
      'no-restricted-globals': [
        'error',
        { name: 'Bun', message: 'Core code must stay Node-compatible. Use node:* APIs.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message: `Import '${name}' as 'node:${name}'.`,
          })),
          patterns: [
            { group: ['bun', 'bun:*'], message: 'Core code must stay Node-compatible.' },
            {
              group: ['../*/!(index)', '../*/!(index).js'],
              message: 'Import sibling modules through their index.ts only.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='process'][property.name='versions'] > Identifier[name='bun']",
          message: 'Do not branch on the runtime.',
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // contracts/ and client/ are browser-safe: no node:* at all.
    files: ['src/contracts/**/*.ts', 'src/client/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['node:*'], message: 'contracts/ and client/ must stay browser-safe.' }],
        },
      ],
    },
  }
)
