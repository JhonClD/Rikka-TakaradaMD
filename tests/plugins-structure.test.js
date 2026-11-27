import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Análisis estático de plugins/: no importa los módulos (algunos arrancan
// timers o piden red al importarse), solo lee su fuente.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS = path.join(ROOT, 'plugins')

const files = fs.readdirSync(PLUGINS).filter((f) => f.endsWith('.js')).sort()

// Un archivo por función, en kebab-case minúsculo. No es capricho: con nombres
// tipo `Play.js`/`Purga.js` mezclados con `ytdl.js`, dos clones del mismo plugin
// acaban conviviendo (`play.js` y `Play.js`) y en un sistema de archivos sin
// distinción de mayúsculas eso es un cargue aleatorio de uno u otro.
const NAME_OK = /^[a-z0-9][a-z0-9._-]*\.js$/;

const quoted = (text) =>
  [...text.matchAll(/['"]([A-Za-z0-9_-]+)['"]/g)].map((m) => m[1].toLowerCase());

/** Alias declarados por un plugin, o null si no declara handler.command. */
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

test('hay plugins en plugins/', () => {
  assert.ok(files.length > 20, `solo se encontraron ${files.length} plugins`);
});

for (const file of files) {
  test(`${file} exporta un handler utilizable`, () => {
    const source = fs.readFileSync(path.join(PLUGINS, file), 'utf8');
    assert.match(source, /export\s+default/, 'falta `export default handler`');
    const tieneComando = commandAliases(source) !== null;
    const ganchoGlobal = /handler\.(all|before)\s*=/.test(source);
    assert.ok(
      tieneComando || ganchoGlobal,
      'debe declarar handler.command o un gancho handler.all/handler.before; si no, nunca se ejecuta',
    );
    assert.match(source, /handler\.(tags|help|commandNames)\s*=/, 'falta handler.tags (el menú agrupa por tags)');
  });
}

test('ningún alias de comando lo reclaman dos plugins', () => {
  // El despachador de handler.js recorre TODOS los plugins y no se detiene en
  // la primera coincidencia: si dos plugins declaran el mismo alias, ambos se
  // ejecutan y el usuario recibe dos respuestas por un solo comando.
  const owners = new Map();
  const conflicts = [];
  for (const file of files) {
    const aliases = commandAliases(fs.readFileSync(path.join(PLUGINS, file), 'utf8')) || [];
    for (const alias of aliases) {
      const previous = owners.get(alias);
      if (previous && previous !== file) conflicts.push(`${alias}: ${previous} y ${file}`);
      owners.set(alias, file);
    }
  }
  assert.deepEqual(conflicts, [], 'comandos duplicados entre plugins');
});

test('los plugins que ejecutan comandos del sistema están reservados al owner', () => {
  const sensibles = ['exec.js', 'npm-install.js', 'owner-update.js', 'deps-check.js', 'anidl.js'];
  for (const file of sensibles) {
    const source = fs.readFileSync(path.join(PLUGINS, file), 'utf8');
    const gated = /handler\.(owner|rowner)\s*=\s*true/.test(source) || /isOwner/.test(source);
    assert.ok(gated, `${file} permite ejecutar comandos del sistema sin control de owner`);
  }
});

test('los nombres de archivo siguen kebab-case en minúsculas', () => {
  const fuera = files.filter((f) => !NAME_OK.test(f));
  assert.deepEqual(fuera, [], 'renombra a minúsculas: ' + fuera.join(', '));
});

test('no hay dos plugins que solo se distingan por mayúsculas', () => {
  const vistos = new Map();
  const choques = [];
  for (const f of files) {
    const clave = f.toLowerCase();
    if (vistos.has(clave)) choques.push(`${vistos.get(clave)} vs ${f}`);
    vistos.set(clave, f);
  }
  assert.deepEqual(choques, []);
});
