const JKANIME_HOST_RE = /^(?:[a-z0-9-]+\.)*jkanime\.net$/i
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
    filemoon: ['filemoon'], streamwish: ['streamwish'], vidhide: ['vidhide'],
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

export async function resolveJkAnimeEpisodeInput(value, provider, { fetchPage = globalThis.fetch, signal } = {}) {
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
