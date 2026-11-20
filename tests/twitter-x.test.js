import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAlbumChunks,
  buildCaption,
  buildPhotoCandidates,
  describeMediaType,
  detectImageMime,
  downloadAllMedia,
  extractScreenName,
  extractTweetId,
  extractTwitterUrl,
  fetchTweetData,
  formatDate,
  parseFxTwitterResponse,
  parseSyndicationResponse,
  parseTweeloadResponse,
  parseVxTwitterResponse,
  resolveTwitterUrl,
} from '../src/libraries/twitter-dl.js'
import twitterHandler from '../plugins/twitter-x.js'

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MP4_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32])

const makeResponse = ({ ok = true, status = 200, url = '', headers = {}, json, buffer } = {}) => ({
  ok,
  status,
  url,
  headers: {
    get: (name) => headers[name.toLowerCase()] ?? null,
  },
  body: { cancel: async () => {} },
  json: async () => json,
  text: async () => (typeof json === 'string' ? json : JSON.stringify(json ?? '')),
  arrayBuffer: async () => {
    const buf = buffer || Buffer.alloc(0)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  },
})

test('extractTwitterUrl soporta x.com, twitter.com, fx/vx, t.co y limpia puntuación', () => {
  assert.equal(
    extractTwitterUrl('mira esto https://x.com/user_1/status/1800000000000000001?s=20.'),
    'https://x.com/user_1/status/1800000000000000001?s=20',
  )
  assert.equal(
    extractTwitterUrl('', 'https://mobile.twitter.com/nasa/status/1234567890)'),
    'https://mobile.twitter.com/nasa/status/1234567890',
  )
  assert.equal(
    extractTwitterUrl(null, null, 'link citado https://fxtwitter.com/foo/status/9876543210!'),
    'https://fxtwitter.com/foo/status/9876543210',
  )
  assert.equal(
    extractTwitterUrl('https://t.co/AbCdEf1234'),
    'https://t.co/AbCdEf1234',
  )
  assert.equal(extractTwitterUrl('https://example.com/1234567890'), null)
})

test('extractTweetId y extractScreenName validan estrictamente /status/<id>', () => {
  assert.equal(extractTweetId('https://x.com/usuario/status/1899999999999999999?s=46'), '1899999999999999999')
  assert.equal(extractTweetId('https://x.com/usuario/1234567890'), null)
  assert.equal(extractScreenName('https://x.com/RikkaBot/status/1899999999999999999'), 'RikkaBot')
  assert.equal(extractScreenName('https://x.com/i/status/1899999999999999999'), null)
})

test('resolveTwitterUrl resuelve enlaces cortos t.co siguiendo redirecciones', async () => {
  const mockFetch = async () =>
    makeResponse({ url: 'https://x.com/dev/status/1777777777777777777?s=20' })
  const res = await resolveTwitterUrl('https://t.co/short123', { fetchImpl: mockFetch })
  assert.equal(res.tweetId, '1777777777777777777')
  assert.equal(res.screenName, 'dev')
})

test('parseFxTwitterResponse preserva orden de media mixta (fotos + videos + gif) y soporta tweet citado', () => {
  const mixed = parseFxTwitterResponse({
    code: 200,
    tweet: {
      id: '100',
      text: 'Post mixto',
      created_at: '2025-05-01T12:00:00Z',
      author: { id: '1', name: 'Rikka', screen_name: 'rikka' },
      likes: 1500,
      retweets: 300,
      views: 50000,
      media: {
        all: [
          { type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg' },
          {
            type: 'video',
            url: 'https://video.twimg.com/low.mp4',
            variants: [
              { bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/720x720/mid.mp4' },
              { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/1080x1080/hd.mp4' },
              { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/pl.m3u8' },
            ],
          },
          { type: 'gif', url: 'https://video.twimg.com/anim.mp4' },
        ],
      },
    },
  })

  assert.equal(mixed.media.length, 3)
  assert.equal(mixed.media[0].kind, 'photo')
  assert.equal(mixed.media[1].kind, 'video')
  assert.equal(mixed.media[1].variants[0].url, 'https://video.twimg.com/1080x1080/hd.mp4')
  assert.equal(mixed.media[1].variants.length, 3) // excluye m3u8, ordena bitrate desc
  assert.equal(mixed.media[2].kind, 'gif')
  assert.equal(mixed.isQuotedMedia, false)

  const quoted = parseFxTwitterResponse({
    code: 200,
    tweet: {
      id: '101',
      text: 'Mira esto',
      author: { name: 'Ana', screen_name: 'ana' },
      quote: {
        media: {
          photos: [{ url: 'https://pbs.twimg.com/media/Q1.jpg' }],
        },
      },
    },
  })
  assert.equal(quoted.media.length, 1)
  assert.equal(quoted.isQuotedMedia, true)
})

test('parseVxTwitterResponse, parseSyndicationResponse y parseTweeloadResponse extraen fotos y videos sin descartar ninguno', () => {
  const vx = parseVxTwitterResponse({
    tweetID: '200',
    text: 'Dos videos',
    user_name: 'User',
    user_screen_name: 'user',
    media_extended: [
      { type: 'video', url: 'https://video.twimg.com/v1.mp4' },
      { type: 'video', url: 'https://video.twimg.com/v2.mp4' },
    ],
  })
  assert.equal(vx.media.length, 2)
  assert.deepEqual(vx.media.map((m) => m.kind), ['video', 'video'])

  const syn = parseSyndicationResponse({
    id_str: '300',
    text: 'Syndication',
    user: { id_str: '9', name: 'Syn', screen_name: 'syn' },
    mediaDetails: [
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/S1.png' },
      {
        type: 'animated_gif',
        video_info: {
          variants: [{ bitrate: 0, content_type: 'video/mp4', url: 'https://video.twimg.com/g1.mp4' }],
        },
      },
    ],
  })
  assert.equal(syn.media.length, 2)
  assert.deepEqual(syn.media.map((m) => m.kind), ['photo', 'gif'])

  // Bug histórico en tweeload: antes usaba `else if` y descartaba fotos si había videos.
  const tw = parseTweeloadResponse({
    code: 200,
    tweet: {
      id: '400',
      text: 'Mixto tweeload',
      author: { name: 'T', screen_name: 't' },
      media: {
        photos: [{ url: 'https://pbs.twimg.com/media/T1.jpg' }],
        videos: [{ type: 'video', video_urls: [{ bitrate: 1000, url: 'https://video.twimg.com/tv1.mp4' }] }],
      },
    },
  })
  assert.equal(tw.media.length, 2)
  assert.deepEqual(tw.media.map((m) => m.kind), ['photo', 'video'])
})

test('fetchTweetData hace fallback automático entre proveedores si el primero falla', async () => {
  const calls = []
  const mockFetch = async (url) => {
    calls.push(url)
    if (url.includes('api.fxtwitter.com')) {
      return makeResponse({ ok: false, status: 500 })
    }
    if (url.includes('api.vxtwitter.com')) {
      return makeResponse({
        json: {
          tweetID: '555',
          text: 'Recuperado por vx',
          user_name: 'Backup',
          user_screen_name: 'backup',
          media_extended: [
            { type: 'image', url: 'https://pbs.twimg.com/media/1.jpg' },
            { type: 'image', url: 'https://pbs.twimg.com/media/2.jpg' },
          ],
        },
      })
    }
    throw new Error('No debería llegar a proveedores posteriores')
  }

  const tweet = await fetchTweetData('555', { screenName: 'backup', fetchImpl: mockFetch })
  assert.equal(tweet.source, 'vxtwitter')
  assert.equal(tweet.media.length, 2)
  assert.equal(calls.length, 2)
})

test('downloadAllMedia elige variante más ligera si el video HD supera inlineLimit y sube fotos con fallback de calidad', async () => {
  const bigMp4 = Buffer.alloc(1024, 1)
  const smallMp4 = MP4_BYTES

  const mockFetch = async (url) => {
    if (url.includes('name=orig')) return makeResponse({ ok: false, status: 404 })
    if (url.includes('name=large')) {
      return makeResponse({ headers: { 'content-type': 'image/png' }, buffer: PNG_BYTES })
    }
    if (url.includes('hd.mp4')) {
      return makeResponse({ headers: { 'content-type': 'video/mp4' }, buffer: bigMp4 })
    }
    if (url.includes('sd.mp4')) {
      return makeResponse({ headers: { 'content-type': 'video/mp4' }, buffer: smallMp4 })
    }
    return makeResponse({ ok: false, status: 404 })
  }

  const { items, errors } = await downloadAllMedia(
    [
      { kind: 'photo', url: 'https://pbs.twimg.com/media/pic.png', fallbackUrls: buildPhotoCandidates('https://pbs.twimg.com/media/pic.png') },
      {
        kind: 'video',
        variants: [
          { url: 'https://video.twimg.com/hd.mp4', bitrate: 2000, resolution: '1080x1080' },
          { url: 'https://video.twimg.com/sd.mp4', bitrate: 500, resolution: '480x480' },
        ],
      },
    ],
    { fetchImpl: mockFetch, inlineLimit: 500, maxDocumentLimit: 2048 },
  )

  assert.equal(errors.length, 0)
  assert.equal(items.length, 2)
  assert.equal(items[0].mimetype, 'image/png')
  assert.equal(items[1].oversized, false)
  assert.equal(items[1].resolution, '480x480')
})

test('buildAlbumChunks agrupa media, pone caption solo en el primer item y divide de a 10', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    kind: i % 2 === 0 ? 'photo' : 'video',
    buffer: i % 2 === 0 ? JPEG_BYTES : MP4_BYTES,
    mimetype: i % 2 === 0 ? 'image/jpeg' : 'video/mp4',
  }))

  const chunks = buildAlbumChunks(items, 'MI CAPTION')
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].length, 10)
  assert.equal(chunks[1].length, 2)
  assert.equal(chunks[0][0].caption, 'MI CAPTION')
  assert.equal(chunks[0][1].caption, undefined)
  assert.equal(chunks[1][0].caption, undefined)
})

test('utilidades de formato manejan fechas inválidas, mime por magic bytes y descripción de álbumes', () => {
  assert.equal(formatDate('no-es-fecha'), 'N/A')
  assert.equal(detectImageMime(PNG_BYTES, ''), 'image/png')
  assert.equal(
    describeMediaType([{ kind: 'photo' }, { kind: 'photo' }, { kind: 'video' }]),
    'Álbum (2 imágenes + 1 video)',
  )
  const cap = buildCaption({
    username: 'rikka',
    name: 'Rikka',
    title: 'Hola `mundo`\nhttps://t.co/abc',
    size: '1.20 MB',
    type: 'Álbum (2 imágenes)',
    fecha: '01 MAY 2025',
    url: 'https://x.com/rikka/status/1',
    stats: { likes: 1200, retweets: 50, views: null },
  })
  assert.ok(cap.includes('Rikka (@rikka)'))
  assert.ok(!cap.includes('https://t.co/abc'))
  assert.ok(cap.includes('♥ 1.2K · ↻ 50'))
})

test('handler envía múltiples imágenes juntas en UN solo álbum y múltiples videos juntos en UN solo álbum', async () => {
  const originalFetch = globalThis.fetch
  const sentMessages = []

  const conn = {
    sendMessage: async (chat, content, options) => {
      sentMessages.push({ chat, content, options })
      return { key: { id: 'msg' } }
    },
  }

  const m = { chat: '123@g.us', sender: 'user1@s.whatsapp.net', key: { id: 'k1' } }

  try {
    // 1) Tweet con 3 imágenes -> debe enviarse en UN solo mensaje `album` de 3 fotos
    globalThis.fetch = async (url) => {
      if (url.includes('api.fxtwitter.com')) {
        return makeResponse({
          json: {
            code: 200,
            tweet: {
              id: '9001',
              text: 'Tres fotos',
              created_at: '2025-05-01T00:00:00Z',
              author: { name: 'FotoUser', screen_name: 'fotouser' },
              media: {
                all: [
                  { type: 'photo', url: 'https://pbs.twimg.com/media/p1.jpg' },
                  { type: 'photo', url: 'https://pbs.twimg.com/media/p2.jpg' },
                  { type: 'photo', url: 'https://pbs.twimg.com/media/p3.jpg' },
                ],
              },
            },
          },
        })
      }
      return makeResponse({ headers: { 'content-type': 'image/jpeg' }, buffer: JPEG_BYTES })
    }

    await twitterHandler(m, {
      conn,
      text: 'https://x.com/fotouser/status/9001',
      args: ['https://x.com/fotouser/status/9001'],
      usedPrefix: '.',
      command: 'x',
    })

    const photoAlbums = sentMessages.filter((msg) => Array.isArray(msg.content?.album))
    const singleImages = sentMessages.filter((msg) => msg.content?.image)
    assert.equal(photoAlbums.length, 1, 'debe enviar un único álbum para las 3 fotos')
    assert.equal(photoAlbums[0].content.album.length, 3)
    assert.equal(singleImages.length, 0, 'no debe enviar las fotos por separado')
    assert.ok(photoAlbums[0].content.album[0].caption.includes('Álbum (3 imágenes)'))

    // 2) Tweet con 2 videos -> debe enviarse en UN solo mensaje `album` de 2 videos
    sentMessages.length = 0
    globalThis.fetch = async (url) => {
      if (url.includes('api.fxtwitter.com')) {
        return makeResponse({
          json: {
            code: 200,
            tweet: {
              id: '9002',
              text: 'Dos videos',
              created_at: '2025-05-01T00:00:00Z',
              author: { name: 'VidUser', screen_name: 'viduser' },
              media: {
                all: [
                  { type: 'video', url: 'https://video.twimg.com/v1.mp4' },
                  { type: 'video', url: 'https://video.twimg.com/v2.mp4' },
                ],
              },
            },
          },
        })
      }
      return makeResponse({ headers: { 'content-type': 'video/mp4' }, buffer: MP4_BYTES })
    }

    await twitterHandler(m, {
      conn,
      text: 'https://x.com/viduser/status/9002',
      args: ['https://x.com/viduser/status/9002'],
      usedPrefix: '.',
      command: 'x',
    })

    const videoAlbums = sentMessages.filter((msg) => Array.isArray(msg.content?.album))
    const singleVideos = sentMessages.filter((msg) => msg.content?.video)
    assert.equal(videoAlbums.length, 1, 'debe enviar un único álbum para los 2 videos')
    assert.equal(videoAlbums[0].content.album.length, 2)
    assert.equal(singleVideos.length, 0, 'no debe enviar los videos por separado')
    assert.ok(videoAlbums[0].content.album[0].caption.includes('Álbum (2 videos)'))
  } finally {
    globalThis.fetch = originalFetch
  }
})
