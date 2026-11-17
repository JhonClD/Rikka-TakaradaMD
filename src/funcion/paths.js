// Rutas absolutas del proyecto.
//
// Antes cada módulo resolvía sus archivos contra process.cwd(), así que
// arrancar con `node /ruta/al/bot/index.js` desde otro directorio hacía que
// el bot no viera su sesión, su base de datos, su .env ni sus imágenes.
// Todas las rutas internas deben salir de aquí.
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Resuelve una ruta relativa al repositorio, no al directorio actual. */
export const fromRoot = (...parts) => join(ROOT, ...parts);

export const SRC_DIR = fromRoot('src');
export const TMP_DIR = fromRoot('src', 'tmp');
export const MENU_IMAGE = fromRoot('src', 'menu', 'menu.png');
export const ANTI_ARAB_JSON = fromRoot('src', 'antiArab.json');
export const PACKAGE_JSON = fromRoot('package.json');
export const ENV_FILE = fromRoot('.env');
export const SPEEDTEST_SCRIPT = fromRoot('src', 'libraries', 'ookla-speedtest.py');
/** donde los plugins *-notify guardan su estado (episodios ya avisados, colas). */
export const DATA_DIR = fromRoot('database');
export const TEMP_VIDEOS_DIR = fromRoot('temp_videos');

/** Archivo de base de datos de lowdb, admisible con prefijo de instancia. */
export const dbFile = (prefix = '') => fromRoot(`${prefix ? `${prefix}_` : ''}database.json`);

/** Carpeta de sesión de Baileys. Si global.authFile ya es absoluta, se respeta. */
export const sessionDir = (authFile = 'RikkaSession') =>
  (isAbsolute(authFile) ? authFile : fromRoot(authFile));

export const sessionFile = (...parts) => sessionDir(global.authFile || 'RikkaSession', ...parts);
