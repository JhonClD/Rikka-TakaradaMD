import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
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

// ─── Cliente HTTP de AnimeDBS (vive dentro del plugin) ───────────────────────
//
// El cliente está embebido en plugins/dbs-notify.js; estos tests lo cargan desde
// ahí para que nunca haya dos archivos desincronizados. Se levanta un servidor
// local que imita a un WAF y se comprueba que escala entre estrategias
// (wreq → impit → axios → curl), que un 403 se traduce en un error accionable y
// que un 5xx sí se reintenta. No se toca la red real.
//
// El plugin exporta estas piezas solo para pruebas: al bot le llega el default.
const { fetchDbs, esErrorDeBloqueo, DBS_HEADERS } = await import('../plugins/dbs-notify.js')

function servidorWaf(comportamiento) {
  const estado = { peticiones: [], intentos: 0 }
  const server = http.createServer((req, res) => {
    estado.peticiones.push({ url: req.url, ua: req.headers['user-agent'] || '' })
    estado.intentos += 1
    const respuesta = comportamiento(req, estado)
    res.writeHead(respuesta.status, respuesta.headers || {})
    res.end(respuesta.body || '')
  })
  return { server, estado }
}

async function conServidor(comportamiento, fn) {
  const { server, estado } = servidorWaf(comportamiento)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base, estado)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('las cabeceras fingen navegación de un Chrome real', () => {
  assert.match(DBS_HEADERS['User-Agent'], /Chrome\/\d+/)
  assert.equal(DBS_HEADERS['Sec-Fetch-Mode'], 'navigate')
  assert.equal(DBS_HEADERS['Upgrade-Insecure-Requests'], '1')
})

test('devuelve el cuerpo cuando el sitio responde 200', async () => {
  await conServidor(
    () => ({ status: 200, body: '<html>portada</html>' }),
    async (base, estado) => {
      const respuesta = await fetchDbs(`${base}/`)
      assert.equal(respuesta.status, 200)
      assert.match(String(respuesta.data), /portada/)
      assert.ok(estado.peticiones.length >= 1)
      // La petición sale con huella de navegador, no con el UA de node.
      assert.match(estado.peticiones[0].ua, /Chrome\/\d+/)
    },
  )
})

test('un 403 se convierte en un error accionable, no en el texto de axios', async () => {
  await conServidor(
    () => ({ status: 403, body: 'forbidden' }),
    async base => {
      const error = await fetchDbs(`${base}/ver/episodio-1`).then(
        () => { throw new Error('debía fallar') },
        err => err,
      )
      assert.equal(error.code, 'DBS_FORBIDDEN')
      assert.equal(esErrorDeBloqueo(error), true)
      assert.match(error.message, /403/)
      // El mensaje debe decir qué hacer, que es lo que faltaba antes.
      assert.match(error.message, /DBS_PROXY_URL/)
      assert.match(error.message, /DBS_FLARESOLVERR_URL/)
      assert.doesNotMatch(error.message, /Request failed with status code/)
    },
  )
})

test('un 5xx se reintenta y termina devolviendo el contenido', async () => {
  await conServidor(
    (_req, estado) => estado.intentos < 2
      ? { status: 503, body: 'ocupado' }
      : { status: 200, body: 'recuperado' },
    async base => {
      const respuesta = await fetchDbs(`${base}/flaky`, { intentos: 3 })
      assert.equal(respuesta.status, 200)
      assert.equal(String(respuesta.data), 'recuperado')
    },
  )
})

test('un 404 no se reintenta: no se arregla esperando', async () => {
  await conServidor(
    () => ({ status: 404, body: 'no existe' }),
    async (base, estado) => {
      const error = await fetchDbs(`${base}/no-existe`).then(
        () => { throw new Error('debía fallar') },
        err => err,
      )
      assert.notEqual(error.code, 'DBS_FORBIDDEN')
      // Una sola ronda de estrategias, sin repetir por timeout.
      assert.ok(estado.intentos <= 6, `demasiados intentos: ${estado.intentos}`)
    },
  )
})

test('las portadas viajan en binario y no se corrompen', async () => {
  // PNG mínimo válido: firma + IHDR. Si el cliente lo decodificara como texto,
  // la firma se perdería y la portada llegaría rota a WhatsApp.
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ])
  await conServidor(
    () => ({ status: 200, body: png, headers: { 'content-type': 'image/png' } }),
    async base => {
      const respuesta = await fetchDbs(`${base}/cover.png`, { documento: false, binario: true })
      assert.ok(Buffer.isBuffer(respuesta.data), 'debe devolver un Buffer')
      assert.deepEqual([...respuesta.data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      assert.equal(respuesta.data.length, png.length)
    },
  )
})

test('esErrorDeBloqueo distingue bloqueo de error de red', () => {
  assert.equal(esErrorDeBloqueo({ status: 403 }), true)
  assert.equal(esErrorDeBloqueo({ code: 'DBS_FORBIDDEN' }), true)
  assert.equal(esErrorDeBloqueo({ status: 500 }), false)
  assert.equal(esErrorDeBloqueo(new Error('ECONNRESET')), false)
  assert.equal(esErrorDeBloqueo(null), false)
})

// ─── Escenario completo del plugin (fixture) ─────────────────────────────────

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

test('un episodio nuevo se envía una sola vez, limpio y desde disco', { timeout: 150_000 }, async () => {
  const { nuevo } = await ejecutar()

  // SUB y LAT comparten ficha: un único envío, aunque la ficha traiga los dos.
  assert.equal(nuevo.documentos.length, 2, 'debe enviar el original y su versión 360p')
  assert.equal(nuevo.compress, 1, 'la versión 360p se genera una vez')

  // Baileys recibe una ruta local (`{ url }`), nunca un Buffer en memoria.
  for (const doc of nuevo.documentos) {
    assert.match(doc.url, /temp_videos/, 'el documento debe enviarse desde una ruta local')
    assert.equal(doc.mimetype, 'video/mp4')
  }

  // El notificador envía únicamente los archivos, sin portada ni textos extra.
  assert.equal(nuevo.portadas, 0)
  assert.equal(nuevo.caption, null)

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
