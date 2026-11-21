import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough, Readable } from 'node:stream'
import handler, {
  buildSlugVariations,
  clearHtmlCache,
  extractFireloadDirect,
  extractMediafireDirect,
  extractMp4UploadDirect,
  extractYourUploadDirect,
  fetchText,
  isCloudflareBlocked,
  normalizeMegaUrl,
  parseEpisodeLinks,
  parseHentaiInput,
  parseLatestReleases,
  parseSearchResults,
  parseSeriesInfo,
  toNodeReadable,
} from '../plugins/hentai-dl.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_PATH = path.join(ROOT, 'plugins', 'hentai-dl.js')

async function withLocalServer(responder, fn) {
  const state = { requests: [] }
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, method: req.method, headers: req.headers })
    const out = responder(req, state)
    res.writeHead(out.status, out.headers || { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(out.body ?? '')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base, state)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('plugins/hentai-dl.js no contiene tokens gratuitos ni proxies de terceros', () => {
  const source = fs.readFileSync(PLUGIN_PATH, 'utf8')
  const forbidden = [
    'SCRAPE_DO_TOKEN',
    'SCRAPE_DO_JK_TOKEN',
    'SCRAPERAPI_KEY',
    'WEBSCRAPING_AI_KEY',
    'WEBSCRAPINGAPI_KEY',
    'SCRAPINGDOG_KEY',
    'SCRAPINGBEE_KEY',
    'CF_WORKER_URL',
    'workers.dev',
    'api.scrape.do',
    'api.scraperapi.com',
    'allorigins.win',
    'corsproxy.io',
    'codetabs.com',
    'r.jina.ai',
    'hentaiSelection',
    'activeDownloads',
    'jkanime',
  ]
  for (const needle of forbidden) {
    assert.equal(source.includes(needle), false, `no debe quedar rastro de "${needle}"`)
  }
  assert.match(source, /import\('wreq-js'\)/)
  assert.match(source, /import\('impit'\)/)
})

test('parseHentaiInput interpreta URLs directas, nombres con episodio y slugs con guiones', () => {
  assert.deepEqual(
    parseHentaiInput('https://hentaila.com/media/overflow/3'),
    { slug: 'overflow', episode: '3', query: 'overflow' },
  )
  assert.deepEqual(
    parseHentaiInput('https://hentaila.com/media/harem-camp'),
    { slug: 'harem-camp', episode: null, query: 'harem camp' },
  )
  assert.deepEqual(
    parseHentaiInput('overflow 1'),
    { slug: null, episode: '1', query: 'overflow' },
  )
  assert.deepEqual(
    parseHentaiInput('Harem Camp ep 2'),
    { slug: null, episode: '2', query: 'Harem Camp' },
  )
  assert.deepEqual(
    parseHentaiInput('overflow ep4'),
    { slug: null, episode: '4', query: 'overflow' },
  )
  assert.deepEqual(
    parseHentaiInput('¿overflow?! #5'),
    { slug: null, episode: '5', query: 'overflow' },
  )
  assert.deepEqual(
    parseHentaiInput('25-sai-no-joshikousei'),
    { slug: null, episode: null, query: '25-sai-no-joshikousei' },
  )
})

test('buildSlugVariations genera slugs limpios y sin duplicados', () => {
  const vars = buildSlugVariations('Reika wa Karei na Boku no Joou')
  assert.ok(vars.includes('reika-wa-karei-na-boku-no-joou'))
  assert.ok(vars.includes('reika-karei-na-boku-joou'))
  assert.equal(new Set(vars).size, vars.length)
})

test('parseSeriesInfo extrae h1 limpio, portada, géneros y episodios ordenados', () => {
  const html = `
    <html>
      <head>
        <title>Overflow Online Gratis en HD | HentaiLA</title>
        <meta property="og:image" content="https://cdn.hentaila.com/covers/536.jpg" />
        <meta property="og:description" content="Sinopsis de prueba." />
      </head>
      <body>
        <h1>Overflow</h1>
        <a href="/catalogo?genre=harem">Harem</a>
        <a href="/catalogo?genre=vanilla">Vanilla</a>
        <a href="/catalogo?genre=harem">Harem</a>
        <a href="/media/overflow/3">Ep 3</a>
        <a href="/media/overflow/1">Ep 1</a>
        <a href="/media/overflow/2">Ep 2</a>
        <a href="/media/overflow/2">Ep 2</a>
      </body>
    </html>
  `
  const info = parseSeriesInfo(html, 'overflow')
  assert.equal(info.title, 'Overflow')
  assert.equal(info.cover, 'https://cdn.hentaila.com/covers/536.jpg')
  assert.equal(info.desc, 'Sinopsis de prueba.')
  assert.deepEqual(info.episodes, [1, 2, 3])
  assert.deepEqual(info.generos, ['Harem', 'Vanilla'])
})

test('parseSearchResults extrae títulos reales desde tarjetas article de /catalogo', () => {
  const html = `
    <main>
      <article>
        <a href="/media/harem-camp">Ver</a>
        <h2>Harem Camp!</h2>
      </article>
      <article>
        <a href="/media/harem-time-">Ver</a>
        <h3>Harem Time</h3>
      </article>
      <article>
        <a href="/media/harem-camp">Duplicado</a>
        <h2>Harem Camp!</h2>
      </article>
    </main>
  `
  assert.deepEqual(parseSearchResults(html), [
    { slug: 'harem-camp', title: 'Harem Camp!' },
    { slug: 'harem-time-', title: 'Harem Time' },
  ])
})

test('parseLatestReleases extrae títulos reales, episodios y deduplica por slug', () => {
  const html = `
    <section>
      <article>
        <a href="/media/solow/4">Ver</a>
        <h2>So_low</h2>
      </article>
      <article>
        <a href="/media/solow/3">Ver</a>
        <h2>So_low</h2>
      </article>
      <article>
        <a href="/media/hitori-tsuma/1">Ver</a>
        <h3>Hitori Tsuma</h3>
      </article>
    </section>
  `
  assert.deepEqual(parseLatestReleases(html, 5), [
    { slug: 'solow', title: 'So_low', episode: 4 },
    { slug: 'hitori-tsuma', title: 'Hitori Tsuma', episode: 1 },
  ])
})

test('normalizeMegaUrl y parseEpisodeLinks normalizan Mega y deduplican MP4Upload', () => {
  assert.equal(
    normalizeMegaUrl('https://mega.nz/file/!5d0VwIgI!NWEtxE2y7z8lS1ssy-9KlumfZXS8rKO3XKPhRqxv0TQ'),
    'https://mega.nz/file/5d0VwIgI#NWEtxE2y7z8lS1ssy-9KlumfZXS8rKO3XKPhRqxv0TQ',
  )
  assert.equal(
    normalizeMegaUrl('https://mega.nz/embed/!5d0VwIgI!NWEtxE2y7z8lS1ssy-9KlumfZXS8rKO3XKPhRqxv0TQ'),
    'https://mega.nz/file/5d0VwIgI#NWEtxE2y7z8lS1ssy-9KlumfZXS8rKO3XKPhRqxv0TQ',
  )

  const payload = `
    <script>
      embeds:{SUB:[
        {server:"YourUpload",url:"https://www.yourupload.com/embed/6RlGt61681PL"},
        {server:"MP4Upload",url:"https://www.mp4upload.com/embed-t0vgmtazj696.html"},
        {server:"Mega",url:"https://mega.nz/embed/!5d0VwIgI!NWEtxE2y7z8lS1ssy-9KlumfZXS8rKO3XKPhRqxv0TQ"}
      ]},
      downloads:{SUB:[
        {server:"MediaFire",url:"https://www.mediafire.com/file/mgakujmpenfkzwk"},
        {server:"FireLoad",url:"https://www.fireload.com/b8907003449feaf0"},
        {server:"1Fichier",url:"https://1fichier.com/?b7p4ko7eq2hfz9cugij5"},
        {server:"MP4Upload",url:"https://www.mp4upload.com/t0vgmtazj696"},
        {server:"Mega",url:"https://mega.nz/file/!5d0VwIgI!NWEtxE2y7z8lS1ssy-9KlumfZXS8rKO3XKPhRqxv0TQ"}
      ]}
    </script>
  `
  const links = parseEpisodeLinks(payload)
  assert.deepEqual(links.mega, ['https://mega.nz/file/5d0VwIgI#NWEtxE2y7z8lS1ssy-9KlumfZXS8rKO3XKPhRqxv0TQ'])
  assert.deepEqual(links.mediafire, ['https://www.mediafire.com/file/mgakujmpenfkzwk'])
  assert.deepEqual(links.fireload, ['https://www.fireload.com/b8907003449feaf0'])
  assert.deepEqual(links.fichier, ['https://1fichier.com/?b7p4ko7eq2hfz9cugij5'])
  assert.deepEqual(links.mp4upload, ['https://www.mp4upload.com/embed-t0vgmtazj696.html'])
  assert.deepEqual(links.yourupload, ['https://www.yourupload.com/embed/6RlGt61681PL'])
  assert.deepEqual(links.otros, [])
})

test('extractores de MediaFire, FireLoad, MP4Upload y YourUpload resuelven enlaces directos', () => {
  const mf = extractMediafireDirect(
    '<div class="promoDownloadName" title="ep1.mp4"></div><a id="downloadButton" href="https://download2263.mediafire.com/abc/ep1.mp4">Download</a>',
  )
  assert.deepEqual(mf, { direct: 'https://download2263.mediafire.com/abc/ep1.mp4', name: 'ep1.mp4' })

  const fl = extractFireloadDirect(
    '<title>536_1_SUB.mp4 | Fireload</title><script>window.Fl = {"dlink": "https://www.fireload.com/abc/536_1_SUB.mp4?pt=xyz", "dwait": "5"}</script>',
  )
  assert.deepEqual(fl, {
    direct: 'https://www.fireload.com/abc/536_1_SUB.mp4?pt=xyz',
    name: '536_1_SUB.mp4',
    waitSeconds: 5,
  })

  const mp = extractMp4UploadDirect(
    'player.src({ type: "video/mp4", src: "https://a6.mp4upload.com:183/d/abcdef1234567890abcdef1234567890/video.mp4" });',
  )
  assert.equal(mp.direct, 'https://a6.mp4upload.com:183/d/abcdef1234567890abcdef1234567890/video.mp4')

  const yu = extractYourUploadDirect(
    "jwplayerOptions = { file: 'https://vidcache.net:8161/token123/video.mp4' };",
  )
  assert.equal(yu, 'https://vidcache.net:8161/token123/video.mp4')
  assert.equal(extractYourUploadDirect("file: 'https://yourupload.com/novideo.mp4'"), null)
})

test('toNodeReadable soporta PassThrough de node-fetch y ReadableStream de wreq-js/impit', async () => {
  const pass = new PassThrough()
  assert.equal(toNodeReadable(pass), pass)

  const web = Readable.toWeb(Readable.from([Buffer.from('abc')]))
  const nodeStream = toNodeReadable(web)
  const chunks = []
  for await (const c of nodeStream) chunks.push(Buffer.from(c))
  assert.equal(Buffer.concat(chunks).toString(), 'abc')

  assert.throws(() => toNodeReadable(null), /sin cuerpo/)
})

test('fetchText usa huella Chrome (wreq-js), cachea 200, no reintenta 404 y escala a impit en 403', async () => {
  clearHtmlCache()
  const okBody = `<html><head><title>OK</title></head><body>${'x'.repeat(260)}</body></html>`

  await withLocalServer((req, state) => {
    if (req.url === '/ok') return { status: 200, body: okBody }
    if (req.url === '/missing') return { status: 404, body: '<html>Not Found</html>' }
    if (req.url === '/flaky') {
      const hits = state.requests.filter((r) => r.url === '/flaky').length
      return hits === 1 ? { status: 503, body: 'busy' } : { status: 200, body: okBody }
    }
    if (req.url === '/cf') {
      return { status: 200, body: `<html><title>Just a moment...</title>${'a'.repeat(300)}</html>` }
    }
    if (req.url === '/escalate') {
      const platform = String(req.headers['sec-ch-ua-platform'] || '')
      return platform.includes('Windows')
        ? { status: 403, body: 'blocked windows' }
        : { status: 200, body: okBody }
    }
    return { status: 404, body: '' }
  }, async (base, state) => {
    // 1. 200 + Chrome UA + cache hit
    const first = await fetchText(`${base}/ok`)
    assert.equal(first, okBody)
    const second = await fetchText(`${base}/ok`)
    assert.equal(second, okBody)
    const okReqs = state.requests.filter((r) => r.url === '/ok')
    assert.equal(okReqs.length, 1)
    assert.match(String(okReqs[0].headers['user-agent'] || ''), /Chrome\/142/)

    // 2. 404 no se reintenta
    await assert.rejects(
      () => fetchText(`${base}/missing`),
      (err) => err.status === 404,
    )
    assert.equal(state.requests.filter((r) => r.url === '/missing').length, 1)

    // 3. 503 se reintenta y recupera
    const recovered = await fetchText(`${base}/flaky`)
    assert.equal(recovered, okBody)
    assert.ok(state.requests.filter((r) => r.url === '/flaky').length >= 2)

    // 4. Desafío Cloudflare es detectado y rechazado
    assert.equal(isCloudflareBlocked('<html><title>Just a moment...</title></html>'), true)
    await assert.rejects(() => fetchText(`${base}/cf`), /Cloudflare/i)

    // 5. Escalado real wreq-js (Windows -> 403) a impit (macOS -> 200)
    const escalated = await fetchText(`${base}/escalate`)
    assert.equal(escalated, okBody)
    const escReqs = state.requests.filter((r) => r.url === '/escalate')
    assert.equal(escReqs.length, 2)
    assert.match(String(escReqs[0].headers['sec-ch-ua-platform']), /Windows/)
    assert.match(String(escReqs[1].headers['sec-ch-ua-platform']), /macOS/)
  })
})

test('handler.before no secuestra botones interactivos de otros plugins', async () => {
  const foreignMsg = {
    chat: 'chat1@g.us',
    sender: 'user1@s.whatsapp.net',
    text: '',
    message: {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: {
          paramsJson: JSON.stringify({ id: '.play bad apple' }),
        },
      },
    },
  }
  const handled = await handler.before(foreignMsg, { conn: {} })
  assert.equal(handled, false)
})
