const JKANIME_HOST_RE = /^(?:[a-z0-9-]+\.)*jkanime\.net$/i
const JKPLAYERS_HOST_RE = /^(?:[a-z0-9-]+\.)*jkplayers\.com$/i
const MAX_PAGE_CHARS = 5 * 1024 * 1024
const PAGE_TIMEOUT_MS = 20_000

function safeHttpUrl(value, baseUrl) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return null
  try {
    const url = new URL(text, baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch (_) {
    return null
  }
}

function extractBalanced(text, start) {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '[') depth += 1
    if (ch === ']') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function extractServersLiteral(html) {
  const match = /\b(?:var|let|const)\s+servers\s*=/i.exec(html)
  if (!match) return []
  const rest = html.slice(match.index + match[0].length)
  const start = rest.search(/\[/)
  if (start < 0) return []
  const literal = extractBalanced(rest, start)
  if (!literal) return []
  try {
    const value = JSON.parse(literal)
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : []
  } catch (_) {
    return []
  }
}

function decodeRemote(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (/^https?:\/\//i.test(raw)) return raw
  if (!raw || !/^[A-Za-z0-9+/_=-]+$/.test(raw)) return null
  try {
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim()
    return /^https?:\/\//i.test(decoded) ? decoded : null
  } catch (_) {
    return null
  }
}

export function parseJkAnimeEpisodeUrl(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch (_) { return null }
  if (!['http:', 'https:'].includes(url.protocol) || !JKANIME_HOST_RE.test(url.hostname) || url.username || url.password) return null
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2 || !/^\d+$/.test(parts.at(-1)) || Number(parts.at(-1)) < 1) return null
  return url.href
}

function extractPlayerUrls(html, baseUrl) {
  const found = []
  const add = (raw) => {
    const url = safeHttpUrl(raw, baseUrl)
    if (!url) return
    try {
      const parsed = new URL(url)
      if (!JKANIME_HOST_RE.test(parsed.hostname)) return
      if (!/^\/(?:jkplayer\/[a-z0-9]+|um2?\.php|umv\.php|c\d+\.php|stream\/jkmedia)/i.test(parsed.pathname)) return
      if (!found.includes(url)) found.push(url)
    } catch (_) {}
  }
  const pattern = /https?:\/\/(?:www\.)?jkanime\.net\/(?:jkplayer\/[a-z0-9]+|um2?\.php|umv\.php|c\d+\.php|stream\/jkmedia)\?[^\s"'<>\\]*/gi
  for (const match of html.matchAll(pattern)) add(match[0])
  const iframePattern = /<iframe\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi
  for (const match of html.matchAll(iframePattern)) add(match[2].replace(/\\\//g, '/'))
  return found
}

function matchesProvider(entry, provider) {
  const name = String(entry.server || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  const key = String(provider || '').toLowerCase()
  if (key === 'magi') return false
  if (key === 'desu') return false
  if (key === 'jkplayer') return false
  const aliases = {
    byse: ['byse', 'filemoon'], filemoon: ['filemoon', 'byse'],
    streamwish: ['streamwish'], vidhide: ['vidhide'],
    streamtape: ['streamtape'], doodstream: ['doodstream', 'dood'], mixdrop: ['mixdrop'],
  }[key] || [key]
  return aliases.some(alias => name.includes(alias.replace(/[^a-z0-9]/g, '')))
}

function selectPlayerUrl(html, baseUrl, provider) {
  const urls = extractPlayerUrls(html, baseUrl)
  const patterns = {
    jkplayer: /^\/jkplayer\//i,
    magi: /^\/(?:jkplayer\/umv|umv\.php)$/i,
    desu: /^\/(?:jkplayer\/um|um\.php|stream\/jkmedia)$/i,
  }
  const pattern = patterns[provider]
  return pattern ? urls.find(raw => pattern.test(new URL(raw).pathname)) || null : null
}

export function parseJkPlayersRedirectUrl(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch (_) { return null }
  if (!['http:', 'https:'].includes(url.protocol) || !JKPLAYERS_HOST_RE.test(url.hostname) || url.username || url.password) return null
  if (!/^\/d\/[a-z0-9_-]{4,64}\/?$/i.test(url.pathname)) return null
  return url.href
}

export async function resolveJkAnimeEpisodeInput(value, provider, { fetchPage = globalThis.fetch, signal } = {}) {
  const redirectUrl = parseJkPlayersRedirectUrl(value)
  if (redirectUrl) {
    if (typeof fetchPage !== 'function') throw new Error('No hay un método disponible para resolver el enlace de descarga.')
    const response = await fetchPage(redirectUrl, {
      headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      redirect: 'manual',
      signal: signal || AbortSignal.timeout(PAGE_TIMEOUT_MS),
    })
    const location = response?.headers?.get?.('location')
    try { await response?.body?.cancel?.() } catch (_) {}
    const resolved = location && safeHttpUrl(location, redirectUrl)
    if (!resolved) throw new Error(`No pude resolver la redirección de descarga (${response?.status || 'sin Location'}).`)
    return resolved
  }
  const episodeUrl = parseJkAnimeEpisodeUrl(value)
  if (!episodeUrl) return value
  if (typeof fetchPage !== 'function') throw new Error('No hay un método disponible para consultar JKAnime.')
  const response = await fetchPage(episodeUrl, {
    headers: { accept: 'text/html,application/xhtml+xml', ...(process.env.JK_COOKIE ? { cookie: process.env.JK_COOKIE } : {}) },
    redirect: 'manual',
    signal: signal || AbortSignal.timeout(PAGE_TIMEOUT_MS),
  })
  if (!response?.ok) throw new Error(`JKAnime no permitió leer el episodio (HTTP ${response?.status || 'desconocido'}; puede estar protegido por Cloudflare).`)
  if (response.url) {
    let finalUrl
    try { finalUrl = new URL(response.url) } catch (_) { finalUrl = null }
    if (!finalUrl || !JKANIME_HOST_RE.test(finalUrl.hostname)) throw new Error('JKAnime redirigió a un dominio inesperado; se rechazó por seguridad.')
  }
  const html = await response.text()
  if (html.length > MAX_PAGE_CHARS) throw new Error('La página del episodio excede el tamaño permitido.')
  const pageBase = response.url || episodeUrl
  if (['jkplayer', 'magi', 'desu'].includes(provider)) {
    const selected = selectPlayerUrl(html, pageBase, provider)
    if (selected) return selected
    throw new Error(`El episodio no contiene una ruta de reproductor compatible con ${provider}.`)
  }
  const entry = extractServersLiteral(html).find(item => matchesProvider(item, provider))
  const remote = entry ? decodeRemote(entry.remote) : null
  const selected = remote && safeHttpUrl(remote, pageBase)
  if (!selected) throw new Error(`El episodio no publica un servidor ${provider} válido en la matriz servers.`)
  return selected
}

// ─── Tests embebidos (solo al ejecutar `node --test plugins/lib/jkanime-episode-servers.js`) ──

if (process.env.NODE_TEST_CONTEXT && process.argv[1]) {
  const { resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { default: test } = await import('node:test')
    const { default: assert } = await import('node:assert/strict')

    const episode = 'https://jkanime.net/kyoufu-collector/7/'
    const b64 = value => Buffer.from(value).toString('base64')
    const html = `
<script>
var servers = [
  {"server":"Filemoon","remote":"${b64('https://bysekoze.com/e/ldrk67q0kwiw')}","slug":"ldrk67q0kwiw"},
  {"server":"Streamwish","remote":"${b64('https://vibuxer.com/f/87wzxbc2xijd')}","slug":"87wzxbc2xijd"},
  {"server":"Vidhide","remote":"${b64('https://callistanise.com/file/4t8obkq2pwnr')}","slug":"4t8obkq2pwnr"},
  {"server":"StreamTape","remote":"${b64('https://streamtape.com/e/st-id')}","slug":"st-id"},
  {"server":"DoodStream","remote":"${b64('https://dood.wf/e/ds-id')}","slug":"ds-id"},
  {"server":"Mixdrop","remote":"${b64('https://mixdrop.ag/e/md-id')}","slug":"md-id"}
];
</script>
<script>
var video = [];
video[0] = '<iframe src="https://jkanime.net/jkplayer/um?e=desu-token"></iframe>';
video[1] = '<iframe src="https://jkanime.net/jkplayer/umv?e=magi-token"></iframe>';
</script>`

    const mockFetch = (text = html, finalUrl = episode) =>
      async () => ({ ok: true, status: 200, url: finalUrl, text: async () => text })

    test('solo acepta URLs de episodio JKAnime con ruta numérica', () => {
      assert.equal(parseJkAnimeEpisodeUrl(episode), episode)
      assert.equal(parseJkAnimeEpisodeUrl('https://evil.example/kyoufu-collector/7/'), null)
      assert.equal(parseJkAnimeEpisodeUrl('https://jkanime.net/search/kyoufu/'), null)
      assert.equal(parseJkAnimeEpisodeUrl('javascript:alert(1)'), null)
    })

    test('resuelve los seis servidores externos por etiqueta, no por posición', async () => {
      const [{ parseByseUrl }, { parseStreamWishUrl }, { parseVidHideUrl }] = await Promise.all([
        import('../byse-dl.js'),
        import('../streamwish-dl.js'),
        import('../vidhide-dl.js'),
      ])
      const expected = {
        byse: 'https://bysekoze.com/e/ldrk67q0kwiw',
        streamwish: 'https://vibuxer.com/f/87wzxbc2xijd',
        vidhide: 'https://callistanise.com/file/4t8obkq2pwnr',
        streamtape: 'https://streamtape.com/e/st-id',
        doodstream: 'https://dood.wf/e/ds-id',
        mixdrop: 'https://mixdrop.ag/e/md-id',
      }
      for (const [provider, url] of Object.entries(expected)) {
        assert.equal(await resolveJkAnimeEpisodeInput(episode, provider, { fetchPage: mockFetch() }), url)
      }
      assert.equal(parseByseUrl(expected.byse).code, 'ldrk67q0kwiw')
      assert.equal(parseStreamWishUrl(expected.streamwish).id, '87wzxbc2xijd')
      assert.equal(parseVidHideUrl(expected.vidhide).id, '4t8obkq2pwnr')
    })

    test('resuelve redirecciones de descarga c1.jkplayers.com/d/... y rutas /f/', async () => {
      const [{ parseByseUrl }, { parseStreamTapeUrl }, { parseDoodStreamUrl }] = await Promise.all([
        import('../byse-dl.js'),
        import('../streamtape-dl.js'),
        import('../doodstream-dl.js'),
      ])
      const dlUrl = 'https://c1.jkplayers.com/d/0Cs92624xLO3Y/'
      assert.equal(parseJkPlayersRedirectUrl(dlUrl), dlUrl)
      assert.equal(parseJkPlayersRedirectUrl('https://evil.example/d/abc123/'), null)

      const target = 'https://streamtape.com/f/qW6g361aLYfRdD/video-07.mp4'
      const resolved = await resolveJkAnimeEpisodeInput(dlUrl, 'streamtape', {
        fetchPage: async () => ({ status: 302, headers: new Headers({ location: target }) }),
      })
      assert.equal(resolved, target)
      assert.equal(parseStreamTapeUrl(resolved).id, 'qW6g361aLYfRdD')
      assert.equal(parseByseUrl('https://bysekoze.com/f/ldrk67q0kwiw/').code, 'ldrk67q0kwiw')
      assert.equal(parseDoodStreamUrl('https://dsvplay.com/f/wsj0f35bkcei').id, 'wsj0f35bkcei')
      assert.equal(parseDoodStreamUrl('https://playmogo.com/e/wsj0f35bkcei').id, 'wsj0f35bkcei')
    })

    test('resuelve los reproductores Magi, Desu y JKPlayer por tipo de ruta', async () => {
      assert.equal(await resolveJkAnimeEpisodeInput(episode, 'magi', { fetchPage: mockFetch() }), 'https://jkanime.net/jkplayer/umv?e=magi-token')
      assert.equal(await resolveJkAnimeEpisodeInput(episode, 'desu', { fetchPage: mockFetch() }), 'https://jkanime.net/jkplayer/um?e=desu-token')
      assert.equal(await resolveJkAnimeEpisodeInput(episode, 'jkplayer', { fetchPage: mockFetch() }), 'https://jkanime.net/jkplayer/um?e=desu-token')
    })

    test('no ejecuta JavaScript y rechaza matriz malformada o proveedor ausente', async () => {
      const invalid = '<script>globalThis.__ran = true; var servers = getServers();</script>'
      await assert.rejects(resolveJkAnimeEpisodeInput(episode, 'byse', { fetchPage: mockFetch(invalid) }), /no publica un servidor byse válido/)
      assert.equal(globalThis.__ran, undefined)
      await assert.rejects(resolveJkAnimeEpisodeInput(episode, 'byse', { fetchPage: mockFetch(html, 'https://elsewhere.example/redirect') }), /dominio inesperado/)
    })

    test('las URLs directas pasan sin hacer una petición', async () => {
      let requests = 0
      const direct = 'https://bysekoze.com/e/abc123'
      const output = await resolveJkAnimeEpisodeInput(direct, 'byse', { fetchPage: async () => { requests += 1 } })
      assert.equal(output, direct)
      assert.equal(requests, 0)
    })
  }
}

