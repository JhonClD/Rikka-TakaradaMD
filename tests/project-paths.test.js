import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, MENU_IMAGE, TMP_DIR, fromRoot } from '../src/funcion/paths.js'

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
  assert.equal(path.basename(ROOT), 'Rikka-TakaradaMD');
  assert.equal(MENU_IMAGE, fromRoot('src', 'menu', 'menu.png'));
  assert.ok(TMP_DIR.startsWith(ROOT));
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
