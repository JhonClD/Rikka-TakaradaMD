import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// Pruebas de src/libraries/dbs-http.js, la capa que resuelve el 403 de AnimeDBS.
//
// Se levanta un servidor local que imita a un WAF y se comprueba que el cliente
// escala entre estrategias (wreq → impit → axios → curl), que un 403 se traduce
// en un error accionable y que un 5xx sí se reintenta. No se toca la red real.
const { fetchDbs, esErrorDeBloqueo, HEADERS } = await import('../src/libraries/dbs-http.js')

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
  assert.match(HEADERS['User-Agent'], /Chrome\/\d+/)
  assert.equal(HEADERS['Sec-Fetch-Mode'], 'navigate')
  assert.equal(HEADERS['Upgrade-Insecure-Requests'], '1')
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
