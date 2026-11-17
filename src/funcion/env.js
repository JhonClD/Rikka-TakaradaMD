// Cargador mínimo de .env, sin dependencia de dotenv.
//
// Estaba duplicado en plugins/nidl.js y src/libraries/youtube-scraper.js, y
// cada uno leía el archivo desde process.cwd(): si el bot se arrancaba desde
// otro directorio, las claves simplemente no existían y los plugins fallaban
// con "API key no configurada". Ahora lo llama config.js una sola vez, antes
// de que cualquier plugin se importe.
import fs from 'node:fs';
import { ENV_FILE } from './paths.js';

let loaded = false;

/**
 * Carga KEY=VALUE desde `file` en process.env sin pisar variables que ya
 * existan (la variable del entorno manda sobre el archivo).
 * @returns {boolean} true si el archivo se leyó
 */
export function loadEnv(file = ENV_FILE) {
  if (loaded) return true;
  loaded = true;
  let raw;
  try {
    if (!fs.existsSync(file)) return false;
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    console.warn(`[ ⚠️ ] No se pudo leer ${file}:`, error?.message || error);
    return false;
  }
  let applied = 0;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key in process.env) continue;
    process.env[key] = value.replace(/^(['"])(.*)\1$/, '$2');
    applied += 1;
  }
  if (applied) console.log(`[ ℹ️ ] .env cargado (${applied} variable(s)).`);
  return true;
}

/** Devuelve la primera variable no vacía de la lista. */
export function envFirst(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}
