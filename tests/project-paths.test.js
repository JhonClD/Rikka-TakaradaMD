import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, ASSETS_DIR, MENU_IMAGE, TMP_DIR, fromRoot } from '../src/funcion/paths.js'

// Rutas del proyecto: el bot se puede arrancar desde cualquier directorio
// (`node /ruta/al/bot/index.js`, pm2, un launcher de Termux). Todo lo que se
// resuelva contra process.cwd() deja de funcionar según dónde se arranque.
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
  // Se comprueba la forma del proyecto, no el nombre de la carpeta: el bot se
  // puede clonar como ~/bot-rikka, /data/home/Rikka-TakaradaMD o lo que sea, y
  // un assert.equal(basename, 'Rikka-TakaradaMD') fallaría sin motivo.
  assert.equal(JSON.parse(fs.readFileSync(fromRoot('package.json'), 'utf8')).name, 'rikka-takarada-md');
  for (const entry of ['main.js', 'handler.js', 'plugins', 'src']) {
    assert.ok(fs.existsSync(path.join(ROOT, entry)), `ROOT no contiene ${entry}`);
  }
  assert.ok(TMP_DIR.startsWith(ROOT));
});

test('MENU_IMAGE resuelve dentro del proyecto', () => {
  // La imagen vive en src/assets/; se tolera la ubicación vieja (src/menu/)
  // porque paths.js la acepta como compatibilidad.
  const permitidas = [path.join(ASSETS_DIR, 'menu.png'), fromRoot('src', 'menu', 'menu.png')];
  assert.ok(permitidas.includes(MENU_IMAGE), `MENU_IMAGE apunta a ${MENU_IMAGE}`);
});

test('los archivos gráficos que carga config.js existen', () => {
  assert.ok(fs.existsSync(MENU_IMAGE), `falta ${MENU_IMAGE}`);
});

for (const dir of ['plugins', 'src']) {
  test(`${dir}/ no resuelve rutas contra process.cwd()`, () => {
    const offenders = [];
    for (const file of jsFiles(fromRoot(dir))) {
      if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
      if (stripComments(fs.readFileSync(file, 'utf8')).includes('process.cwd()')) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    assert.deepEqual(offenders, [], 'usa process.cwd(): cámbialo por src/funcion/paths.js');
  });
}

test('.gitignore protege la sesión y el estado local', () => {
  const ignore = fs.readFileSync(fromRoot('.gitignore'), 'utf8');
  for (const entry of ['RikkaSession/', 'database.json', 'node_modules/', '.env']) {
    assert.ok(ignore.includes(entry), `.gitignore debería incluir ${entry}`);
  }
});
