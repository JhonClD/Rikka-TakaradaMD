import test from 'node:test'
import assert from 'node:assert/strict'
import { extractJkAnimeLinks, parseJkAnimeEpisodeUrl } from '../src/libraries/jkanime-extractors.js'

const pageUrl = 'https://jkanime.net/serie/12/'

test('extrae streams codificados, descarga remota e iframe de JKAnime', () => {
  const streamUrl = 'https://streamwish.to/e/episode-token'
  const iframeUrl = 'https://player.example/embed/episode-token'
  const servers = [{
    remote: Buffer.from(streamUrl).toString('base64'),
    server: 'StreamWish',
    slug: 'download-token',
    lang: 'sub',
  }]
  const html = [
    `<script>var servers = ${JSON.stringify(servers)}; var remote = 'https://downloads.example';`,
    `video[0] = '<iframe src="${iframeUrl}"></iframe>';</script>`,
  ].join('\n')

  const links = extractJkAnimeLinks(html, pageUrl)
  assert.deepEqual(links.map(link => link.url), [
    streamUrl,
    'https://downloads.example/d/download-token/',
    iframeUrl,
  ])
  assert.equal(links[0].server, 'StreamWish')
  assert.equal(links[0].variant, 'sub')
  assert.equal(links[2].kind, 'player')
})

test('extrae slug y número de episodio desde URLs absolutas y relativas', () => {
  assert.deepEqual(parseJkAnimeEpisodeUrl('/serie-de-prueba/42/?from=feed', 'https://jkanime.net/'), {
    slug: 'serie-de-prueba',
    epNum: 42,
    epUrl: 'https://jkanime.net/serie-de-prueba/42/?from=feed',
  })
  assert.deepEqual(parseJkAnimeEpisodeUrl('https://www.jkanime.net/serie/7/', pageUrl), {
    slug: 'serie',
    epNum: 7,
    epUrl: 'https://www.jkanime.net/serie/7/',
  })
})

test('rechaza URLs fuera de JKAnime y no ejecuta literales JavaScript no JSON', () => {
  assert.equal(parseJkAnimeEpisodeUrl('https://example.org/serie/7/'), null)
  assert.equal(parseJkAnimeEpisodeUrl('/serie/no-es-numero/', 'https://jkanime.net/'), null)
  const html = `var servers = [(() => { globalThis.__jkExtractorExecuted = true })()];`
  assert.deepEqual(extractJkAnimeLinks(html, pageUrl), [])
  assert.equal(globalThis.__jkExtractorExecuted, undefined)
})
