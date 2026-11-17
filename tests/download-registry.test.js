import test from 'node:test'
import assert from 'node:assert/strict'
import {
  downloadKey,
  startDownload,
  finishDownload,
  hasDownload,
  listDownloads,
  cancelDownloads,
} from '../src/funcion/download-registry.js'

const key = (over = {}) => downloadKey({ chat: 'grupo-1@g.us', sender: '51999@s.whatsapp.net', ...over })

test('downloadKey separar usuarios dentro del mismo chat', () => {
  const a = downloadKey({ chat: 'g@g.us', sender: '111@s.whatsapp.net' })
  const b = downloadKey({ chat: 'g@g.us', sender: '222@s.whatsapp.net' })
  assert.notEqual(a, b)
  assert.equal(a, 'g@g.us:111@s.whatsapp.net')
})

test('cancelDownloads aborta todas las descargas activas del usuario', () => {
  const k = key()
  const mega = new AbortController()
  const mf = new AbortController()
  startDownload(k, 'mega', mega, { label: '☁️ Mega' })
  startDownload(k, 'mediafire', mf, { label: '🔥 MediaFire' })

  assert.deepEqual(listDownloads(k).map((j) => j.service), ['mega', 'mediafire'])

  const cancelled = cancelDownloads(k)
  assert.deepEqual(cancelled.map((j) => j.service).sort(), ['mediafire', 'mega'])
  assert.equal(mega.signal.aborted, true)
  assert.equal(mf.signal.aborted, true)
  assert.equal(hasDownload(k), false)
})

test('cancelDownloads sin descargas no lanza y devuelve lista vacía', () => {
  assert.deepEqual(cancelDownloads(key({ sender: 'nadie@x' })), [])
})

test('cancelDownloads puede filtrar por servicio', () => {
  const k = key({ sender: 'filtro@x' })
  const mega = new AbortController()
  const gd = new AbortController()
  startDownload(k, 'mega', mega)
  startDownload(k, 'gdrive', gd)

  const cancelled = cancelDownloads(k, 'mega')
  assert.deepEqual(cancelled.map((j) => j.service), ['mega'])
  assert.equal(mega.signal.aborted, true)
  assert.equal(gd.signal.aborted, false)
  assert.equal(hasDownload(k, 'gdrive'), true)
  assert.equal(hasDownload(k, 'mega'), false)
  cancelDownloads(k)
})

test('finishDownload solo libera el trabajo del mismo controller', () => {
  const k = key({ sender: 'reempazo@x' })
  const primero = new AbortController()
  startDownload(k, 'mega', primero)
  finishDownload(k, 'mega', primero)
  assert.equal(hasDownload(k, 'mega'), false)

  // trabajo nuevo: el finally de una descarga vieja no debe dejarlo huérfano
  const segundo = new AbortController()
  startDownload(k, 'mega', segundo)
  finishDownload(k, 'mega', primero)
  assert.equal(hasDownload(k, 'mega'), true)
  cancelDownloads(k)
  assert.equal(hasDownload(k), false)
})

test('startDownload devuelve su propio limpiador', () => {
  const k = key({ sender: 'cleanup@x' })
  const controller = new AbortController()
  const stop = startDownload(k, 'mediafire', controller)
  assert.equal(hasDownload(k, 'mediafire'), true)
  stop()
  assert.equal(hasDownload(k, 'mediafire'), false)
})
