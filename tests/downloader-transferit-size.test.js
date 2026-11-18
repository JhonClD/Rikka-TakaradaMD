import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import handler from '../plugins/downloader-transferit.js'

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
    async text() { return JSON.stringify(data) },
  }
}

async function runMockTransfer({ rangesSupported }) {
  const originalFetch = globalThis.fetch
  const statuses = []
  let documentSize = null
  let downloadRequests = 0

  globalThis.fetch = async (input, options = {}) => {
    if (options.method === 'POST') {
      const [{ a }] = JSON.parse(options.body)
      if (a === 'xi') return jsonResponse([{ size: [180] }])
      if (a === 'f') {
        return jsonResponse([{ f: [{ t: 0, h: '12345678', s: 120, k: '' }] }])
      }
      throw new Error(`Unexpected API command: ${a}`)
    }

    downloadRequests++
    const offset = Number(options.headers?.Range?.match(/bytes=(\d+)-/)?.[1] || 0)
    const status = offset > 0 && rangesSupported ? 206 : 200
    const bytes = offset > 0 && rangesSupported ? 60 : 120
    const body = new PassThrough()
    body.end(Buffer.alloc(bytes, 0x61))
    return {
      ok: true,
      status,
      url: String(input),
      headers: {
        get(name) {
          if (name.toLowerCase() === 'content-length') return String(bytes)
          if (name.toLowerCase() === 'content-type') return 'video/mp4'
          return null
        },
      },
      body,
    }
  }

  const conn = {
    async sendMessage(_chat, content) {
      if (content.document?.stream) {
        let size = 0
        for await (const chunk of content.document.stream) size += chunk.length
        documentSize = size
      } else {
        statuses.push(content.text || '')
      }
      return { key: { id: `mock-${statuses.length}` } }
    },
  }
  const message = {
    chat: 'mock@s.whatsapp.net',
    sender: 'mock-user',
    key: { remoteJid: 'mock@s.whatsapp.net', id: 'mock-input' },
    async reply(text) { statuses.push(String(text)) },
  }

  try {
    await handler(message, {
      conn,
      text: 'https://transfer.it/t/eUAIDCgFmRAZ',
      args: [],
      usedPrefix: '/',
      command: 'transferit',
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  return { statuses, documentSize, downloadRequests }
}

test('reúne 120 + 60 bytes con Range para completar los 180 bytes anunciados', async () => {
  const result = await runMockTransfer({ rangesSupported: true })
  assert.equal(result.downloadRequests, 2)
  assert.equal(result.documentSize, 180)
})

test('no envía los 120 bytes si el archivo anunciado mide 180 y el servidor no reanuda', async () => {
  const result = await runMockTransfer({ rangesSupported: false })
  assert.equal(result.documentSize, null)
  assert.equal(result.downloadRequests, 3)
  assert.ok(result.statuses.some((text) => text.includes('no permite reanudar')))
})
