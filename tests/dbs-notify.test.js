import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Pruebas de comportamiento de plugins/dbs-notify.js.
//
// El plugin no se importa en este proceso: crea timers globales y escribe en
// `database/`. El fixture (tests/fixtures/dbs-notify-harness.mjs) lo carga en
// un proceso hijo con las rutas y los módulos de red sustituidos, apunta
// AnimeDBS a una portada de mentira y un MediaFire falso a un servidor HTTP
// local, y ejercita el flujo real: sondeo → cola → descarga → envío.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS = path.join(ROOT, 'tests', 'fixtures', 'dbs-notify-harness.mjs')

let ejecucion = null
function ejecutar() {
  if (ejecucion) return ejecucion
  ejecucion = new Promise((resolve, reject) => {
    execFile(process.execPath, [HARNESS], { cwd: ROOT, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error)
        const lineas = String(stdout).trim().split('\n')
        try {
          resolve(JSON.parse(lineas.at(-1)))
        } catch (parseError) {
          reject(new Error(`salida no es JSON: ${parseError.message}\n${stdout}`))
        }
      })
  })
  return ejecucion
}

test('el escenario del fixture se ejecuta completo', { timeout: 150_000 }, async () => {
  const resultado = await ejecutar()
  assert.equal(resultado.ok, true, `falló en la fase "${resultado.fase}": ${resultado.error}`)
})

test('dbsstart registra la portada como base y no reenvía episodios viejos', { timeout: 150_000 }, async () => {
  const { trasStart, sinNovedades } = await ejecutar()
  assert.deepEqual(trasStart.seen['120363000000000001@g.us'], ['dbs-one-piece-5'])
  assert.equal(trasStart.state['120363000000000001@g.us'].intervalSec, 15)
  assert.equal(sinNovedades.documentos, 0, 'un episodio ya registrado no debe enviarse')
})

test('un episodio nuevo se envía una sola vez, con portada y desde disco', { timeout: 150_000 }, async () => {
  const { nuevo } = await ejecutar()

  // SUB y LAT comparten ficha: un único envío, aunque la ficha traiga los dos.
  assert.equal(nuevo.documentos.length, 2, 'debe enviar el original y su versión 360p')
  assert.equal(nuevo.compress, 1, 'la versión 360p se genera una vez')

  // Baileys recibe una ruta local (`{ url }`), nunca un Buffer en memoria.
  for (const doc of nuevo.documentos) {
    assert.match(doc.url, /temp_videos/, 'el documento debe enviarse desde una ruta local')
    assert.equal(doc.mimetype, 'video/mp4')
  }

  // Portada con caption: antes la imagen salía muda y el texto se perdía.
  assert.equal(nuevo.portadas, 1)
  assert.match(nuevo.caption, /Nuevo Episodio/)
  assert.match(nuevo.caption, /Ver online/)

  // SUB y LAT quedan marcados como vistos para no volver a enviarlos.
  assert.ok(nuevo.visto.includes('dbs-one-piece-6'))
  assert.ok(nuevo.visto.includes('dbs-lat-one-piece-6'))

  // La carpeta temporal del episodio se limpia al terminar.
  assert.deepEqual(nuevo.tempRestante, [])
})

test('no se reenvía lo ya enviado ni se repite la descarga', { timeout: 150_000 }, async () => {
  const { sinDuplicados, nuevo } = await ejecutar()
  assert.equal(sinDuplicados.mensajesNuevos, 0)
  assert.ok(nuevo.consultasFicha <= 3, `la ficha se pidió ${nuevo.consultasFicha} veces`)
})

test('una ficha caída no marca el episodio como visto (se reintenta)', { timeout: 150_000 }, async () => {
  const { fichaCaida } = await ejecutar()
  // 503 en la ficha del episodio: debe seguir pendiente para el próximo sondeo.
  assert.deepEqual(fichaCaida.visto, ['dbs-marcador-previo-1'])
})

test('cuando el sitio bloquea, el chat recibe instrucciones y no el error crudo', { timeout: 150_000 }, async () => {
  const { bloqueo } = await ejecutar()
  const mensaje = bloqueo?.ultimoMensaje || ''
  assert.match(mensaje, /403/, 'debe decir que el sitio bloquea con 403')
  assert.match(mensaje, /DBS_PROXY_URL/)
  assert.match(mensaje, /DBS_FLARESOLVERR_URL/)
  assert.match(mensaje, /quedan pendientes/)
  // El texto de axios no aporta nada al usuario y era justo lo que se veía.
  assert.doesNotMatch(mensaje, /Request failed with status code/)
})

test('un bloqueo del sitio no hace perder episodios: quedan pendientes', { timeout: 150_000 }, async () => {
  const { bloqueo } = await ejecutar()
  // Si se marcara como visto, al arreglar el acceso el capítulo no se enviaría nunca.
  assert.deepEqual(bloqueo.vistoTrasBloqueo, [])
})

test('dbsstatus resume el estado sin romperse', { timeout: 150_000 }, async () => {
  const { estado } = await ejecutar()
  assert.match(estado, /Estado AnimeDBS/)
  assert.match(estado, /Activo/)
  assert.match(estado, /Último chequeo/)
})
