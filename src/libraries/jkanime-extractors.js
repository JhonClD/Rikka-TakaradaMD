// Adaptado de src/services/jkanime.service.js de anime1v-api.
// Copyright (c) 2025 Feer (FxxMorgan); licencia MIT en ./ANIME1V-API-LICENSE.
// No evalúa el JavaScript remoto: únicamente extrae y analiza literales JSON.

function extractBalancedSection(text, startIndex, openChar, closeChar) {
  let depth = 0
  let activeQuote = ''
  let escaped = false
  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index]
    if (activeQuote) {
      if (escaped) { escaped = false; continue }
      if (character === '\\') { escaped = true; continue }
      if (character === activeQuote) activeQuote = ''
      continue
    }
    if (character === '"' || character === "'" || character === '`') { activeQuote = character; continue }
    if (character === openChar) depth += 1
    if (character === closeChar) {
      depth -= 1
      if (depth === 0) return text.slice(startIndex, index + 1)
    }
  }
  return null
}

function extractVarLiteral(html, variableName) {
  const marker = new RegExp(`\\b(?:var|let|const)\\s+${variableName}\\s*=`, 'g')
  const match = marker.exec(html)
  if (!match) return null
  const slice = html.slice(marker.lastIndex)
  const start = slice.search(/[\[{]/)
  if (start < 0) return null
  const open = slice[start]
  return extractBalancedSection(slice, start, open, open === '{' ? '}' : ']')
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try { return Buffer.from(value, 'base64').toString('utf8').trim() } catch (_) { return null }
}

function safeHttpUrl(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch (_) { return null }
}

export function parseJkAnimeEpisodeUrl(candidate, baseUrl = 'https://jkanime.net/') {
  const normalized = safeHttpUrl(candidate, baseUrl)
  if (!normalized) return null
  try {
    const url = new URL(normalized)
    if (!/(^|\.)jkanime\.net$/i.test(url.hostname)) return null
    const segments = url.pathname.split('/').filter(Boolean)
    const episodeText = segments.at(-1) || ''
    const epNum = Number(episodeText)
    if (!Number.isSafeInteger(epNum) || epNum < 1 || segments.length < 2) return null
    return { slug: segments.at(-2), epNum, epUrl: url.href }
  } catch (_) { return null }
}

function extractVideoIframeUrls(html, baseUrl) {
  const urls = []
  const videoPattern = /video\[\d+\]\s*=\s*(['"])([\s\S]*?)\1/g
  let match
  while ((match = videoPattern.exec(html))) {
    const fragment = match[2].replace(/\\(["'])/g, '$1').replace(/\\\//g, '/')
    const srcMatch = fragment.match(/<iframe\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1/i)
    if (!srcMatch) continue
    const url = safeHttpUrl(srcMatch[2], baseUrl)
    if (url && !urls.includes(url)) urls.push(url)
  }
  return urls
}

/**
 * Extrae fuentes conocidas por el módulo JKAnime de anime1v-api:
 * `servers[].remote` en Base64, URLs de descarga basadas en `remote` + `slug`,
 * y los iframes embebidos en `video[n]`.
 */
export function extractJkAnimeLinks(html, baseUrl) {
  const links = []
  const add = (url, server, kind, variant = null) => {
    const normalized = safeHttpUrl(url, baseUrl)
    if (!normalized || links.some(link => link.url === normalized)) return
    links.push({ url: normalized, server: String(server || '').trim(), kind, variant })
  }

  const literal = extractVarLiteral(html, 'servers')
  let servers = []
  if (literal) {
    try {
      const parsed = JSON.parse(literal)
      if (Array.isArray(parsed)) servers = parsed
    } catch (_) {
      // El literal puede usar sintaxis JavaScript no JSON; no se ejecuta código remoto.
    }
  }

  const remoteMatch = html.match(/\bvar\s+remote\s*=\s*(['"])(.*?)\1/i)
  const remoteBase = remoteMatch ? safeHttpUrl(remoteMatch[2], baseUrl) : null
  for (const entry of servers) {
    if (!entry || typeof entry !== 'object') continue
    const decoded = decodeBase64(entry.remote)
    if (decoded) add(decoded, entry.server || 'embed', 'stream', entry.lang || null)
    if (remoteBase && entry.slug) {
      const downloadUrl = `${remoteBase.replace(/\/$/, '')}/d/${encodeURIComponent(String(entry.slug))}/`
      add(downloadUrl, entry.server || 'embed', 'download', entry.lang || null)
    }
  }

  for (const url of extractVideoIframeUrls(html, baseUrl)) add(url, 'jkplayer', 'player')
  return links
}
