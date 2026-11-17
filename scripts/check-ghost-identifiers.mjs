#!/usr/bin/env node
// Busca "identificadores fantasma": nombres a los que se asigna sin estar
// declarados en el módulo.
//
// Por qué existe esto: `isFirstConnection = true;` en main.js (asignado, jamás
// declarado) lanzaba ReferenceError en cada conexión y quedaba enterrado porque
// el handler de unhandledRejection de la época solo logueaba mensajes con 'lid'.
// En un módulo ES el código es estricto, así que escribir en un nombre no
// declarado revienta; si además cae dentro de un try/catch ancho, el bug es
// invisible para siempre.
//
// `no-undef` no se puede subir a error en este repo: la arquitectura cuelga
// estado en `global` (opts, conn, db, store, mconn, __dirname…) y esos nombres
// se leen legítimamente desde archivos que no los declaran. Por eso aquí solo
// se marcan las ESCRITURAS: leer un global que otro módulo definió es válido,
// escribir en uno sin declararlo nunca lo es.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PATTERNS = ['*.js', 'plugins/**/*.js', 'src/**/*.js'];

// Globales reales de Node/DOM que no hace falta declarar. Está suelto porque el
// filtro final solo mira escrituras; si falta alguno, simplemente no pasa nada.
const RUNTIME_GLOBALS = [
  'process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'TextDecoder', 'TextEncoder',
  'AbortController', 'AbortSignal', 'fetch', 'Response', 'Request', 'Headers', 'FormData',
  'Blob', 'File', 'structuredClone', 'crypto', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'performance', 'Intl',
  'module', 'exports', 'require', '__filename', '__dirname', 'global', 'globalThis',
].reduce((acc, name) => {
  acc[name] = 'readonly';
  return acc;
}, {});

const WRITE = (name) =>
  new RegExp(`(?:^|[^.$\\w])${name}\\s*(?:=(?!=)|[+\\-*/%&|^]{1,2}=|\\+\\+|--)`);
const FOR_TARGET = (name) =>
  new RegExp(`for\\s*\\(\\s*(?:\\[|\\{)?\\s*${name}\\s*(?:,\\s*[^)]*)?\\s+(?:of|in)\\b`);

/**
 * @param {{cwd?: string}} [options]
 * @returns {Promise<Array<{file: string, line: number, column: number, name: string, source: string}>>}
 */
export async function findGhostWrites({ cwd = ROOT } = {}) {
  let ESLint;
  try {
    ({ ESLint } = await import('eslint'));
  } catch (error) {
    // Solo se perdona que el paquete no esté (npm install --omit=dev). Cualquier
    // otro fallo al importar ESLint es un guardián estropeado, y eso debe
    // romperse arriba en vez de convertirse en un "todo bien".
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }

  const eslint = new ESLint({
    cwd,
    // config propia: sin depender de eslint.config.js, para poder encender
    // no-undef que el config del proyecto lleva apagado a propósito.
    overrideConfigFile: true,
    baseConfig: {
      ignores: ['node_modules/**', 'RikkaSession/**', 'src/tmp/**', 'database/**', 'temp_videos/**'],
      files: ['**/*.js'],
      languageOptions: {
        ecmaVersion: 2024,
        sourceType: 'module',
        globals: RUNTIME_GLOBALS,
      },
      rules: { 'no-undef': 'error' },
    },
  });

  // Se lintea patrón a patrón: ESLint lanza si un glob no casa ningún archivo,
  // y aquí un directorio vacío (p. ej. src/ sin .js en un fixture) no es un
  // error, es simplemente nada que revisar.
  const results = [];
  for (const pattern of PATTERNS) {
    try {
      results.push(...await eslint.lintFiles([pattern]));
    } catch (error) {
      if (error?.messageTemplate === 'file-not-found' || /No files matching/.test(error?.message || '')) continue;
      throw error;
    }
  }
  const seen = new Set();
  const unique = results.filter((r) => (seen.has(r.filePath) ? false : (seen.add(r.filePath), true)));
  const fs = await import('node:fs/promises');
  const ghosts = [];

  for (const result of unique) {
    const undefs = result.messages.filter((m) => m.ruleId === 'no-undef');
    if (!undefs.length) continue;
    const lines = (await fs.readFile(result.filePath, 'utf8')).split('\n');
    const reported = new Set();
    for (const message of undefs) {
      const name = /'([^']+)' is not defined/.exec(message.message)?.[1];
      if (!name) continue;
      // `typeof x` sobre un nombre inexistente es legal: no es un error.
      const line = lines[message.line - 1] ?? '';
      if (!WRITE(name).test(line) && !FOR_TARGET(name).test(line)) continue;
      const key = `${result.filePath}:${message.line}:${name}`;
      if (reported.has(key)) continue;
      reported.add(key);
      ghosts.push({
        file: path.relative(cwd, result.filePath),
        line: message.line,
        column: message.column,
        name,
        source: line.trim().slice(0, 120),
      });
    }
  }

  return ghosts.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const asJson = process.argv.includes('--json');
  const ghosts = await findGhostWrites();
  if (ghosts === null) {
    console.error('ESLint no está instalado; ejecuta `npm install` (es devDependency).');
    process.exit(2);
  }
  if (asJson) {
    console.log(JSON.stringify(ghosts, null, 2));
  } else if (!ghosts.length) {
    console.log('✓ Sin asignaciones a identificadores no declarados.');
  } else {
    console.error(`✖ ${ghosts.length} asignación(es) a identificadores fantasma:\n`);
    for (const g of ghosts) console.error(`  ${g.file}:${g.line}:${g.column}  ${g.name}\n      ${g.source}`);
    console.error('\nDeclara la variable (let/const) o borra la línea si nadie la lee.');
  }
  process.exit(ghosts.length ? 1 : 0);
}
