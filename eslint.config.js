import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'eval-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Scripts sueltos de Node en JavaScript plano: no los cubre el proyecto de
    // TypeScript, asi que hay que declararles los globales del entorno.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // El dinero nunca es number: decimal.js o string. Esta regla no lo
      // detecta sola, pero se deja constancia de la revision manual en M4.
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'Usa decimal.js para montos.' }],
    },
  },
);
