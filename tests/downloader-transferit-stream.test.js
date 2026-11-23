import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'
import { toNodeReadable, openDownload } from '../plugins/downloader-transferit.js'

// api.js hace `global.fetch = node-fetch`, y node-fetch@3 entrega `Response.body`
// como un `PassThrough` de Node. El plugin antes hacía `Readable.fromWeb(body)`
// indiscriminadamente, lo que lanzaba:
//   ERR_INVALID_ARG_TYPE: The "readableStream" argument must be an instance of
//   ReadableStream. Received an instance of PassThrough
// Estas pruebas cubren los dos sabores de cuerpo que puede devolver fetch.

const MAX_BYTES = Math.min(2048, Math.max(1, Number(process.env.TRANSFERIT_MAX_MB) || 2048)) * 1024 * 1024
const TARGET = { handle: 'abc123', name: 'hola.bin', size: 4 }

async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function fakeResponse(body, { headers = {}, url = 'https://g.api.mega.co.nz/cs/g', ok = true, status = 200 } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]))
  return {
    ok,
    status,
    url,
    body,
    headers: { get: (name) => headerMap.get(String(name).toLowerCase()) ?? null },
    text: async () => '',
  }
}

/** Sustituye global.fetch solo durante la ejecución de fn. */
async function withFetch(mock, fn) {
  const previous = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete globalThis.fetch
    else globalThis.fetch = previous
  }
}

test('toNodeReadable acepta el PassThrough de node-fetch', async () => {
  const pass = new PassThrough()
  const stream = toNodeReadable(pass)
  assert.equal(stream, pass, 'debe reutilizar el stream de Node tal cual')
  const collected = collect(stream)
  pass.end(Buffer.from('hola'))
  assert.equal((await collected).toString(), 'hola')
})

test('toNodeReadable convierte un ReadableStream web', async () => {
  const web = Readable.toWeb(Readable.from([Buffer.from('hola'), Buffer.from('!!')]))
  const stream = toNodeReadable(web)
  assert.ok(stream instanceof Readable)
  assert.equal((await collect(stream)).toString(), 'hola!!')
})

test('toNodeReadable usa el fallback async iterable si fromWeb rechaza el cuerpo', async () => {
  // ReadableStream de otro realm/polyfill: no tiene la marca interna que exige
  // Readable.fromWeb(), pero sí es async iterable.
  const foreign = {
    getReader() { throw new Error('no debería llamarse') },
    async *[Symbol.asyncIterator]() { yield Buffer.from('hola') },
  }
  assert.equal((await collect(toNodeReadable(foreign))).toString(), 'hola')
})

test('toNodeReadable da errores claros con cuerpos ausentes o incompatibles', () => {
  assert.throws(() => toNodeReadable(null), /sin cuerpo/)
  assert.throws(() => toNodeReadable({}), /incompatible/)
})

test('openDownload funciona con el shim node-fetch (body = PassThrough)', async () => {
  const pass = new PassThrough()
  const response = fakeResponse(pass, {
    headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
  })

  const download = await withFetch(
    async () => response,
    () => openDownload('ABCDEFGH', TARGET, '', new AbortController().signal),
  )

  const collected = collect(download.stream)
  pass.end(Buffer.from('hola'))
  assert.equal((await collected).toString(), 'hola')
  assert.equal(download.size, 4)
})

test('openDownload sigue funcionando con body = ReadableStream web', async () => {
  const web = Readable.toWeb(Readable.from([Buffer.from('hola')]))
  const response = fakeResponse(web, {
    headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
  })

  const download = await withFetch(
    async () => response,
    () => openDownload('ABCDEFGH', TARGET, '', new AbortController().signal),
  )

  assert.equal((await collect(download.stream)).toString(), 'hola')
  assert.equal(download.size, 4)
})

test('openDownload destruye el PassThrough al rechazar un archivo demasiado grande', async () => {
  const bodies = []
  const mock = async () => {
    const pass = new PassThrough()
    bodies.push(pass)
    return fakeResponse(pass, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(MAX_BYTES + 1) },
    })
  }

  await withFetch(mock, () => assert.rejects(
    () => openDownload('ABCDEFGH', TARGET, '', new AbortController().signal),
    /supera el límite/,
  ))

  assert.ok(bodies.length > 0)
  assert.ok(bodies.every((body) => body.destroyed), 'el stream de node-fetch debe liberarse')
})
