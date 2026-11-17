import js from '@eslint/js';

// El config anterior solo tenía `ignores`, sin reglas: `npm run eslint`
// siempre salía en verde y no revisaba nada. Se activa el conjunto recomendado
// y se mantiene `no-undef` apagado porque la arquitectura del bot se apoya en
// globales (global.db, global.plugins, conn, opts, store…) declarados en
// main.js, que ESLint no puede ver desde un archivo suelto.
const botGlobals = {
  global: 'readonly',
  opts: 'readonly',
  conn: 'readonly',
  store: 'readonly',
  db: 'readonly',
  loadDatabase: 'readonly',
  mconn: 'readonly',
  clearTmp: 'readonly',
  axios: 'readonly',
  fetch: 'readonly',
  moment: 'readonly',
  cheerio: 'readonly',
  require: 'readonly',
};

export default [
  {
    ignores: [
      'node_modules/**',
      'RikkaSession/**',
      'src/tmp/**',
      'database/**',
      'temp_videos/**',
      'package-lock.json',
    ],
  },
  {
    ...js.configs.recommended,
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: botGlobals,
    },
    rules: {
      'no-undef': 'off',
      // Limpiado el ruido heredado: variables y parámetros sin uso están a
      // error para que no vuelvan. args/caughtErrors a 'none' porque destructuring
      // parcial y `catch` sin uso son habituales en los plugins.
      // args a 'none': son firmas de callback impuestas por la API (err, data, …)
      // que no se pueden recortar sin tocar la llamada.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['tests/**/*.js'],
    rules: { 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] },
  },
];
