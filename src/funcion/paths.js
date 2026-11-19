// Rutas absolutas del proyecto.
//
// Antes cada módulo resolvía sus archivos contra process.cwd(), así que
// arrancar con `node /ruta/al/bot/index.js` desde otro directorio hacía que
// el bot no viera su sesión, su base de datos, su .env ni sus imágenes.
// Todas las rutas internas deben salir de aquí.
import { existsSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Resuelve una ruta relativa al repositorio, no al directorio actual. */
export const fromRoot = (...parts) => join(ROOT, ...parts);

export const SRC_DIR = fromRoot('src');
export const TMP_DIR = fromRoot('src', 'tmp');

/** Carpeta con las imágenes del proyecto (menú, avatares, svg de bienvenida). */
export const ASSETS_DIR = fromRoot('src', 'assets');

/**
 * Devuelve la primera ruta que exista; si ninguna existe, la primera.
 * Estas imágenes estaban repartidas entre `src/` y `src/menu/`. Quien tenga su
 * propia copia en la ubicación vieja no debe quedarse sin imagen al actualizar,
 * así que esa ruta sigue siendo válida como respaldo.
 */
const firstExisting = (...candidates) => candidates.find((file) => existsSync(file)) ?? candidates[0];

/** Imagen de un asset, tolerando la ubicación anterior (`src/<nombre>`). */
export const assetFile = (name) => firstExisting(join(ASSETS_DIR, name), join(SRC_DIR, name));

export const MENU_IMAGE = firstExisting(
  join(ASSETS_DIR, 'menu.png'),
  fromRoot('src', 'menu', 'menu.png'),
);
export const ANTI_ARAB_JSON = fromRoot('src', 'antiArab.json');
export const PACKAGE_JSON = fromRoot('package.json');
export const ENV_FILE = fromRoot('.env');
/** El speedtest es 100% JavaScript: plugins/speedtest.js (no usa Python). */
/** donde los plugins *-notify guardan su estado (episodios ya avisados, colas). */
export const DATA_DIR = fromRoot('database');
export const TEMP_VIDEOS_DIR = fromRoot('temp_videos');

/** Archivo de base de datos de lowdb, admisible con prefijo de instancia. */
export const dbFile = (prefix = '') => fromRoot(`${prefix ? `${prefix}_` : ''}database.json`);

/** Carpeta de sesión de Baileys. Si global.authFile ya es absoluta, se respeta. */
export const sessionDir = (authFile = 'RikkaSession') =>
  (isAbsolute(authFile) ? authFile : fromRoot(authFile));

export const sessionFile = (...parts) => sessionDir(global.authFile || 'RikkaSession', ...parts);
