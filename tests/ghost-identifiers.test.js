import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findGhostWrites } from '../scripts/check-ghost-identifiers.mjs'

// Guardián contra `nombre = valor` sobre identificadores que nadie declara.
// En un módulo ES eso es un ReferenceError; si además cae dentro de un
// try/catch ancho (o bajo un handler de unhandledRejection filtrado, como
// estaba este repo) el fallo no se ve nunca. Aquí vivió sin síntomas
// `isFirstConnection = true` en main.js y `type`/`call`/`callText` en
// src/libraries/simple.js.
const ghosts = await findGhostWrites();

if (ghosts === null) {
  // Sin ESLint no hay guardián. En local se consiente (puede faltar node_modules);
  // en CI es un error: un test que se auto-salta deja pasar justo lo que vigila.
  test('el guardián de identificadores fantasma puede ejecutarse', {
    skip: process.env.CI ? false : 'ESLint no está instalado (es devDependency)',
  }, () => {
    assert.fail('ESLint no se pudo importar: el guardián no está vigilando nada');
  });
}

test('el proyecto no asigna identificadores sin declarar', { skip: ghosts === null }, () => {
  assert.deepEqual(
    ghosts,
    [],
    'asignaciones fantasma: ' + ghosts.map((g) => `${g.file}:${g.line} (${g.name})`).join(', '),
  );
});

test('el detector no está vacío: encuentra una asignación fantasma sembrada', { skip: ghosts === null }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rikka-ghost-'));
  try {
    await fs.writeFile(
      path.join(dir, 'sample.js'),
      'export const handler = async () => {\n  isFirstConnection = true;\n};\n',
    );
    const found = await findGhostWrites({ cwd: dir });
    assert.deepEqual(found.map((g) => g.name), ['isFirstConnection']);
    assert.equal(found[0].file, 'sample.js');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
