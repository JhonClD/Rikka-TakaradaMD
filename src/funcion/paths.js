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

/** Carpeta con las imágenes del proyecto (imagen del menú). */
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
/** donde los plugins *-notify guardan su estado (episodios ya avisados, colas). */
export const DATA_DIR = fromRoot('database');
export const TEMP_VIDEOS_DIR = fromRoot('temp_videos');

/** Archivo de base de datos de lowdb, admisible con prefijo de instancia. */
export const dbFile = (prefix = '') => fromRoot(`${prefix ? `${prefix}_` : ''}database.json`);

/** Carpeta de sesión de Baileys. Si global.authFile ya es absoluta, se respeta. */
export const sessionDir = (authFile = 'RikkaSession') =>
  (isAbsolute(authFile) ? authFile : fromRoot(authFile));

export const sessionFile = (...parts) => sessionDir(global.authFile || 'RikkaSession', ...parts);

// ─── Tests embebidos (solo al ejecutar `node --test src/funcion/paths.js`) ──

if (process.env.NODE_TEST_CONTEXT && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { default: test } = await import('node:test');
  const { default: assert } = await import('node:assert/strict');
  const fs = await import('node:fs');
  const path = await import('node:path');

  const stripComments = (source) =>
    source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

  const jsFiles = (dir) =>
    fs.readdirSync(dir, { recursive: true })
      .filter((f) => typeof f === 'string' && /\.(js|cjs)$/.test(f))
      .map((f) => path.join(dir, f));

  test('paths.js apunta a la raíz del repositorio', () => {
    assert.equal(JSON.parse(fs.readFileSync(fromRoot('package.json'), 'utf8')).name, 'rikka-takarada-md');
    for (const entry of ['main.js', 'handler.js', 'plugins', 'src']) {
      assert.ok(fs.existsSync(path.join(ROOT, entry)), `ROOT no contiene ${entry}`);
    }
    assert.ok(TMP_DIR.startsWith(ROOT));
  });

  test('MENU_IMAGE resuelve dentro del proyecto y existe', () => {
    const permitidas = [path.join(ASSETS_DIR, 'menu.png'), fromRoot('src', 'menu', 'menu.png')];
    assert.ok(permitidas.includes(MENU_IMAGE), `MENU_IMAGE apunta a ${MENU_IMAGE}`);
    assert.ok(fs.existsSync(MENU_IMAGE), `falta ${MENU_IMAGE}`);
  });

  const FORBIDDEN_CWD = ['process', 'cwd()'].join('.');
  for (const dir of ['plugins', 'src']) {
    test(`${dir}/ no resuelve rutas contra ${FORBIDDEN_CWD}`, () => {
      const offenders = [];
      for (const file of jsFiles(fromRoot(dir))) {
        if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
        if (stripComments(fs.readFileSync(file, 'utf8')).includes(FORBIDDEN_CWD)) {
          offenders.push(path.relative(ROOT, file));
        }
      }
      assert.deepEqual(offenders, [], `usa ${FORBIDDEN_CWD}: cámbialo por src/funcion/paths.js`);
    });
  }

  test('.gitignore protege la sesión y el estado local', () => {
    const ignore = fs.readFileSync(fromRoot('.gitignore'), 'utf8');
    for (const entry of ['RikkaSession/', 'database.json', 'node_modules/', '.env']) {
      assert.ok(ignore.includes(entry), `.gitignore debería incluir ${entry}`);
    }
  });

  test('la recarga de plugins no los rechaza por sintaxis que Node sí acepta', () => {
    const main = fs.readFileSync(fromRoot('main.js'), 'utf8');
    assert.ok(!/from\s+'syntax-error'/.test(main), 'main.js vuelve a validar plugins con syntax-error');
    assert.match(main, /const module = \(await import\(/);
  });

  test('la medición del speedtest vive fuera de plugins/ para la recarga en caliente', () => {
    assert.ok(fs.existsSync(fromRoot('src', 'libraries', 'speedtest.js')));
    assert.ok(!fs.existsSync(fromRoot('src', 'libraries', 'ookla-speedtest.py')));
    const plugin = fs.readFileSync(fromRoot('plugins', 'speedtest.js'), 'utf8');
    assert.match(plugin, /from '\.\.\/src\/libraries\/speedtest\.js'/);
    assert.ok(!/python/i.test(stripComments(plugin)));
  });

  // ── Estructura y seguridad de plugins/ ───────────────────────────────────
  const PLUGINS = fromRoot('plugins');
  const pluginFiles = fs.readdirSync(PLUGINS).filter((f) => f.endsWith('.js')).sort();
  const NAME_OK = /^[a-z0-9][a-z0-9._-]*\.js$/;
  const quoted = (text) => [...text.matchAll(/['"]([A-Za-z0-9_-]+)['"]/g)].map((m) => m[1].toLowerCase());

  function commandAliases(source) {
    const match = source.match(/handler\.command\s*=\s*(.+)/);
    if (!match) return null;
    const value = match[1].trim().replace(/;$/, '');
    if (value.startsWith('/')) {
      const body = value.slice(1, value.lastIndexOf('/'));
      const group = body.match(/^\^\((.*)\)\$$/);
      if (group) return [...new Set(group[1].split('|').filter((a) => /^[A-Za-z0-9_-]+$/.test(a)).map((a) => a.toLowerCase()))];
      const single = body.match(/^\^([A-Za-z0-9_-]+)\$$/);
      if (single) return [single[1].toLowerCase()];
      return [];
    }
    const array = value.match(/^\[([\s\S]*)\]$/);
    if (array) return [...new Set(quoted(array[1]))];
    const identifier = value.match(/^[A-Za-z_$][\w$]*$/);
    if (identifier) {
      const declared = source.match(new RegExp(`(?:const|let|var)\\s+${identifier[0]}\\s*=\\s*\\[([^\\]]*)\\]`));
      if (declared) return [...new Set(quoted(declared[1]))];
      const viaObject = source.match(/(?:const|let|var)\s+alias\s*=\s*\{([\s\S]*?)\n\}/);
      if (viaObject) return [...new Set(quoted(viaObject[1]))];
    }
    return [];
  }

  test('todos los plugins exportan handler, comando/gancho, tags y siguen kebab-case', () => {
    assert.ok(pluginFiles.length > 20, `solo se encontraron ${pluginFiles.length} plugins`);
    const owners = new Map();
    const conflicts = [];
    const seenLower = new Map();
    const caseCollisions = [];
    const badNames = [];

    for (const file of pluginFiles) {
      if (!NAME_OK.test(file)) badNames.push(file);
      const lower = file.toLowerCase();
      if (seenLower.has(lower)) caseCollisions.push(`${seenLower.get(lower)} vs ${file}`);
      seenLower.set(lower, file);

      const source = fs.readFileSync(path.join(PLUGINS, file), 'utf8');
      assert.match(source, /export\s+default/, `${file}: falta export default`);
      const aliases = commandAliases(source);
      const hasHook = /handler\.(all|before)\s*=/.test(source);
      assert.ok(aliases !== null || hasHook, `${file}: falta handler.command o handler.all/before`);
      assert.match(source, /handler\.(tags|help|commandNames)\s*=/, `${file}: falta handler.tags`);

      for (const alias of aliases || []) {
        const prev = owners.get(alias);
        if (prev && prev !== file) conflicts.push(`${alias}: ${prev} y ${file}`);
        owners.set(alias, file);
      }
    }

    assert.deepEqual(badNames, [], 'renombra a minúsculas: ' + badNames.join(', '));
    assert.deepEqual(caseCollisions, []);
    assert.deepEqual(conflicts, [], 'comandos duplicados entre plugins');
  });

  test('los plugins que ejecutan comandos del sistema están reservados al owner', () => {
    for (const file of ['exec.js', 'npm-install.js', 'owner-update.js', 'deps-check.js']) {
      const source = fs.readFileSync(path.join(PLUGINS, file), 'utf8');
      const gated = /handler\.(owner|rowner)\s*=\s*true/.test(source) || /isOwner/.test(source);
      assert.ok(gated, `${file} permite ejecutar comandos del sistema sin control de owner`);
    }
  });
}

