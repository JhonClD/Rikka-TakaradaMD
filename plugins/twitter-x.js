import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  downloadKey,
  hasDownload,
  startDownload,
} from '../src/funcion/download-registry.js'

const MODULE_PATH = fileURLToPath(import.meta.url)
const IS_TEST_RUN = Boolean(
  process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  resolve(process.argv[1]) === MODULE_PATH,
)

// ─── Utilidades y proveedores X/Twitter ───────────────────────────────────────

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const VIDEO_INLINE_LIMIT = 50 * 1024 * 1024 // 50 MB (límite seguro para video/álbum inline en WhatsApp)
const MAX_DOCUMENT_LIMIT = 100 * 1024 * 1024 // 100 MB (límite máximo como documento)
const MAX_ALBUM_ITEMS = 100

const API_TIMEOUT_MS = 15_000
const MEDIA_TIMEOUT_MS = 90_000
const TWEELOAD_TOKEN_TTL_MS = 30 * 60 * 1000

const TWITTER_URL_REGEX =
  /https?:\/\/(?:(?:www|m|mobile)\.)?(?:twitter\.com|x\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com|fixvx\.com|twittpr\.com|xcancel\.com|t\.co)\/[^\s<>]+/i

const STATUS_ID_REGEX = /\/(?:status|statuses)\/(\d{1,25})/i
const SCREEN_NAME_REGEX =
  /https?:\/\/(?:(?:www|m|mobile)\.)?(?:twitter\.com|x\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com|fixvx\.com|twittpr\.com|xcancel\.com)\/([A-Za-z0-9_]{1,30})\/(?:status|statuses)\/\d+/i

let cachedTweeloadToken = null
let cachedTweeloadTokenAt = 0

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'N/A'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const formatCount = (n) => {
  if (!Number.isFinite(n) || n < 0) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

const formatDate = (iso) => {
  if (!iso) return 'N/A'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'N/A'
  return d
    .toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })
    .toUpperCase()
}

const sanitizeFileName = (str = '') => {
  const cleaned = String(str)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || 'twitter_media'
}

const sanitizeInlineText = (str = '', maxLen = 90) => {
  const cleaned = String(str)
    .replace(/https?:\/\/t\.co\/\S+/gi, '')
    .replace(/[`\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'Sin título'
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen).trim()}…` : cleaned
}

const extractTwitterUrl = (...sources) => {
  for (const src of sources) {
    if (!src) continue
    const match = String(src).match(TWITTER_URL_REGEX)
    if (match) {
      return match[0].replace(/[),.!?;:'"\]}>]+$/g, '')
    }
  }
  return null
}

const extractTweetId = (url) => {
  if (!url) return null
  const match = String(url).match(STATUS_ID_REGEX)
  return match ? match[1] : null
}

const extractScreenName = (url) => {
  if (!url) return null
  const match = String(url).match(SCREEN_NAME_REGEX)
  if (!match) return null
  const name = match[1]
  if (name.toLowerCase() === 'i') return null
  return name
}

function combineSignals(userSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!userSignal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([userSignal, timeoutSignal])
  }
  return userSignal
}

const isAbortError = (err) =>
  err?.name === 'AbortError' || err?.code === 'ABORT_ERR'

async function resolveTwitterUrl(rawUrl, { fetchImpl = globalThis.fetch, signal } = {}) {
  const directId = extractTweetId(rawUrl)
  if (directId) {
    return {
      url: rawUrl,
      tweetId: directId,
      screenName: extractScreenName(rawUrl),
    }
  }

  if (/^https?:\/\/t\.co\//i.test(rawUrl)) {
    const res = await fetchImpl(rawUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: combineSignals(signal, API_TIMEOUT_MS),
    })
    try {
      await res.body?.cancel?.()
    } catch {}
    const resolvedUrl = res.url || rawUrl
    const resolvedId = extractTweetId(resolvedUrl)
    if (resolvedId) {
      return {
        url: resolvedUrl,
        tweetId: resolvedId,
        screenName: extractScreenName(resolvedUrl),
      }
    }
  }

  return { url: rawUrl, tweetId: null, screenName: null }
}

function buildPhotoCandidates(url) {
  if (!url) return []
  const candidates = []
  try {
    const parsed = new URL(url)
    if (parsed.hostname.includes('pbs.twimg.com')) {
      const orig = new URL(url)
      orig.searchParams.set('name', 'orig')
      candidates.push(orig.toString())

      const large = new URL(url)
      large.searchParams.set('name', 'large')
      if (!candidates.includes(large.toString())) candidates.push(large.toString())
    }
  } catch {}
  if (!candidates.includes(url)) candidates.push(url)
  return candidates
}

function extractResolution(url) {
  const match = String(url || '').match(/(\d{2,5}x\d{2,5})/)
  return match ? match[1] : 'HD'
}

function normalizeVideoVariants(rawVariants = [], fallbackUrl = null) {
  const seen = new Set()
  const variants = []

  const pushVariant = (v) => {
    const url = typeof v === 'string' ? v : v?.url
    if (!url || seen.has(url)) return
    const contentType = String(v?.content_type || v?.contentType || '').toLowerCase()
    const isHls = contentType.includes('mpegurl') || /\.m3u8(\?|$)/i.test(url)
    if (isHls) return
    const isMp4 = contentType.includes('mp4') || /\.mp4(\?|$)/i.test(url) || !contentType
    if (!isMp4) return

    seen.add(url)
    variants.push({
      url,
      bitrate: Number(v?.bitrate) || 0,
      contentType: 'video/mp4',
      resolution: v?.resolution || extractResolution(url),
    })
  }

  if (Array.isArray(rawVariants)) {
    for (const v of rawVariants) pushVariant(v)
  }
  if (fallbackUrl) pushVariant(fallbackUrl)

  variants.sort((a, b) => b.bitrate - a.bitrate)
  return variants
}

function parseFxMediaBlock(mediaBlock) {
  if (!mediaBlock) return []
  const items = []

  if (Array.isArray(mediaBlock.all) && mediaBlock.all.length) {
    for (const entry of mediaBlock.all) {
      if (entry?.type === 'photo' && entry.url) {
        items.push({
          kind: 'photo',
          url: entry.url,
          fallbackUrls: buildPhotoCandidates(entry.url),
          width: entry.width || null,
          height: entry.height || null,
        })
      } else if ((entry?.type === 'video' || entry?.type === 'gif') && (entry.url || entry.variants?.length)) {
        const variants = normalizeVideoVariants(entry.variants, entry.url)
        if (variants.length) {
          items.push({
            kind: entry.type === 'gif' ? 'gif' : 'video',
            variants,
            durationSec: Number.isFinite(entry.duration) ? entry.duration : null,
            thumbnail: entry.thumbnail_url || null,
          })
        }
      }
    }
    if (items.length) return items
  }

  if (Array.isArray(mediaBlock.photos)) {
    for (const photo of mediaBlock.photos) {
      if (!photo?.url) continue
      items.push({
        kind: 'photo',
        url: photo.url,
        fallbackUrls: buildPhotoCandidates(photo.url),
        width: photo.width || null,
        height: photo.height || null,
      })
    }
  }

  if (Array.isArray(mediaBlock.videos)) {
    for (const video of mediaBlock.videos) {
      const variants = normalizeVideoVariants(video?.variants, video?.url)
      if (!variants.length) continue
      items.push({
        kind: video?.type === 'gif' ? 'gif' : 'video',
        variants,
        durationSec: Number.isFinite(video?.duration) ? video.duration : null,
        thumbnail: video?.thumbnail_url || null,
      })
    }
  }

  return items
}

function parseFxTwitterResponse(data) {
  const tweet = data?.tweet
  if (!tweet) return null

  let media = parseFxMediaBlock(tweet.media)
  let isQuotedMedia = false
  if (!media.length && tweet.quote?.media) {
    media = parseFxMediaBlock(tweet.quote.media)
    isQuotedMedia = media.length > 0
  }

  return {
    id: tweet.id || null,
    text: tweet.text || '',
    createdAt: tweet.created_at || null,
    author: {
      id: tweet.author?.id || null,
      name: tweet.author?.name || '',
      username: tweet.author?.screen_name || '',
    },
    stats: {
      likes: Number.isFinite(tweet.likes) ? tweet.likes : null,
      retweets: Number.isFinite(tweet.retweets) ? tweet.retweets : null,
      replies: Number.isFinite(tweet.replies) ? tweet.replies : null,
      views: Number.isFinite(tweet.views) ? tweet.views : null,
    },
    media,
    isQuotedMedia,
    source: 'fxtwitter',
  }
}

function parseVxMediaList(list) {
  if (!Array.isArray(list)) return []
  const items = []
  for (const entry of list) {
    if (!entry?.url) continue
    const type = String(entry.type || '').toLowerCase()
    if (type === 'image' || type === 'photo') {
      items.push({
        kind: 'photo',
        url: entry.url,
        fallbackUrls: buildPhotoCandidates(entry.url),
        width: entry.size?.width || null,
        height: entry.size?.height || null,
      })
    } else if (type === 'video' || type === 'gif') {
      const variants = normalizeVideoVariants([], entry.url)
      if (variants.length) {
        items.push({
          kind: type === 'gif' ? 'gif' : 'video',
          variants,
          durationSec: Number.isFinite(entry.duration_millis) ? entry.duration_millis / 1000 : null,
          thumbnail: entry.thumbnail_url || null,
        })
      }
    }
  }
  return items
}

function parseVxTwitterResponse(data) {
  if (!data || (!data.tweetID && !data.user_screen_name)) return null

  let media = parseVxMediaList(data.media_extended)
  let isQuotedMedia = false
  if (!media.length && data.qrt?.media_extended) {
    media = parseVxMediaList(data.qrt.media_extended)
    isQuotedMedia = media.length > 0
  }

  return {
    id: data.tweetID || null,
    text: data.text || '',
    createdAt: data.date || (data.date_epoch ? new Date(data.date_epoch * 1000).toISOString() : null),
    author: {
      id: null,
      name: data.user_name || '',
      username: data.user_screen_name || '',
    },
    stats: {
      likes: Number.isFinite(data.likes) ? data.likes : null,
      retweets: Number.isFinite(data.retweets) ? data.retweets : null,
      replies: Number.isFinite(data.replies) ? data.replies : null,
      views: null,
    },
    media,
    isQuotedMedia,
    source: 'vxtwitter',
  }
}

function parseSyndicationMedia(tweet) {
  const details = Array.isArray(tweet?.mediaDetails) ? tweet.mediaDetails : []
  const items = []

  for (const entry of details) {
    if (entry?.type === 'photo' && entry.media_url_https) {
      items.push({
        kind: 'photo',
        url: entry.media_url_https,
        fallbackUrls: buildPhotoCandidates(entry.media_url_https),
        width: entry.original_info?.width || null,
        height: entry.original_info?.height || null,
      })
    } else if (entry?.type === 'video' || entry?.type === 'animated_gif') {
      const variants = normalizeVideoVariants(entry.video_info?.variants)
      if (variants.length) {
        items.push({
          kind: entry.type === 'animated_gif' ? 'gif' : 'video',
          variants,
          durationSec: Number.isFinite(entry.video_info?.duration_millis)
            ? entry.video_info.duration_millis / 1000
            : null,
          thumbnail: entry.media_url_https || null,
        })
      }
    }
  }

  if (!items.length && Array.isArray(tweet?.photos)) {
    for (const p of tweet.photos) {
      if (!p?.url) continue
      items.push({
        kind: 'photo',
        url: p.url,
        fallbackUrls: buildPhotoCandidates(p.url),
        width: p.width || null,
        height: p.height || null,
      })
    }
  }

  return items
}

function parseSyndicationResponse(data) {
  if (!data || !data.id_str) return null

  let media = parseSyndicationMedia(data)
  let isQuotedMedia = false
  if (!media.length && data.quoted_tweet) {
    media = parseSyndicationMedia(data.quoted_tweet)
    isQuotedMedia = media.length > 0
  }

  return {
    id: data.id_str,
    text: data.text || '',
    createdAt: data.created_at || null,
    author: {
      id: data.user?.id_str || null,
      name: data.user?.name || '',
      username: data.user?.screen_name || '',
    },
    stats: {
      likes: Number.isFinite(data.favorite_count) ? data.favorite_count : null,
      retweets: null,
      replies: Number.isFinite(data.conversation_count) ? data.conversation_count : null,
      views: null,
    },
    media,
    isQuotedMedia,
    source: 'syndication',
  }
}

function parseTweeloadResponse(data) {
  if (data?.code !== 200 || !data?.tweet) return null
  const tweet = data.tweet
  const media = []

  if (Array.isArray(tweet.media?.photos)) {
    for (const photo of tweet.media.photos) {
      const url = typeof photo === 'string' ? photo : photo?.url
      if (!url) continue
      media.push({
        kind: 'photo',
        url,
        fallbackUrls: buildPhotoCandidates(url),
        width: photo?.width || null,
        height: photo?.height || null,
      })
    }
  }

  if (Array.isArray(tweet.media?.videos)) {
    for (const v of tweet.media.videos) {
      const variants = normalizeVideoVariants(v?.video_urls, v?.url)
      if (!variants.length) continue
      media.push({
        kind: v?.type === 'gif' ? 'gif' : 'video',
        variants,
        durationSec: Number.isFinite(v?.duration) ? v.duration : null,
        thumbnail: v?.thumbnail_url || null,
      })
    }
  }

  return {
    id: tweet.id || null,
    text: tweet.text || '',
    createdAt: tweet.created_at || null,
    author: {
      id: tweet.author?.id || null,
      name: tweet.author?.name || '',
      username: tweet.author?.screen_name || '',
    },
    stats: {
      likes: Number.isFinite(tweet.likes) ? tweet.likes : null,
      retweets: Number.isFinite(tweet.retweets) ? tweet.retweets : null,
      replies: Number.isFinite(tweet.replies) ? tweet.replies : null,
      views: Number.isFinite(tweet.views) ? tweet.views : null,
    },
    media,
    isQuotedMedia: false,
    source: 'tweeload',
  }
}

async function fetchJson(url, { headers = {}, fetchImpl = globalThis.fetch, signal } = {}) {
  const res = await fetchImpl(url, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      ...headers,
    },
    signal: combineSignals(signal, API_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} en ${new URL(url).hostname}`)
  }
  return res.json()
}

async function getTweeloadAuth({ fetchImpl = globalThis.fetch, signal } = {}) {
  if (cachedTweeloadToken && Date.now() - cachedTweeloadTokenAt < TWEELOAD_TOKEN_TTL_MS) {
    return cachedTweeloadToken
  }
  const res = await fetchImpl('https://pastebin.com/raw/SnCfd4ru', {
    headers: { 'User-Agent': DEFAULT_USER_AGENT },
    signal: combineSignals(signal, API_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} al obtener token`)
  const token = (await res.text()).trim()
  cachedTweeloadToken = token
  cachedTweeloadTokenAt = Date.now()
  return token
}

async function fetchTweetData(
  tweetId,
  { screenName = null, fetchImpl = globalThis.fetch, signal } = {},
) {
  const userPath = screenName ? `${encodeURIComponent(screenName)}/` : ''
  const syndicationToken = ((Number(tweetId) / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, '')

  const providers = [
    async () => {
      const data = await fetchJson(`https://api.fxtwitter.com/${userPath}status/${tweetId}`, {
        fetchImpl,
        signal,
      })
      return parseFxTwitterResponse(data)
    },
    async () => {
      const data = await fetchJson(
        `https://api.vxtwitter.com/${screenName ? encodeURIComponent(screenName) : 'Twitter'}/status/${tweetId}`,
        { fetchImpl, signal },
      )
      return parseVxTwitterResponse(data)
    },
    async () => {
      const data = await fetchJson(
        `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=es&token=${syndicationToken}`,
        { fetchImpl, signal },
      )
      return parseSyndicationResponse(data)
    },
    async () => {
      const auth = await getTweeloadAuth({ fetchImpl, signal })
      const data = await fetchJson(`https://info.tweeload.site/status/${tweetId}.json`, {
        headers: { Authorization: auth },
        fetchImpl,
        signal,
      })
      return parseTweeloadResponse(data)
    },
  ]

  let fallbackTweetWithoutMedia = null
  const errors = []

  for (const provider of providers) {
    if (signal?.aborted) throw new DOMException('Descarga cancelada', 'AbortError')
    try {
      const parsed = await provider()
      if (!parsed) continue
      if (parsed.media.length > 0) return parsed
      if (!fallbackTweetWithoutMedia) fallbackTweetWithoutMedia = parsed
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) throw err
      errors.push(err?.message || String(err))
    }
  }

  if (fallbackTweetWithoutMedia) return fallbackTweetWithoutMedia
  throw new Error(errors.join(' | ') || 'No se pudo obtener el tweet desde ninguna fuente.')
}

function detectImageMime(buffer, contentType = '') {
  const ct = String(contentType).split(';')[0].trim().toLowerCase()
  if (ct.startsWith('image/')) return ct
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'image/png'
    }
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp'
    }
    if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
      return 'image/gif'
    }
  }
  return 'image/jpeg'
}

function isLikelyHtml(buffer, contentType = '') {
  if (String(contentType).toLowerCase().includes('text/html')) return true
  const head = buffer.subarray(0, 32).toString('utf8').trimStart().toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html')
}

async function fetchBuffer(url, { fetchImpl = globalThis.fetch, signal, maxBytes = MAX_DOCUMENT_LIMIT } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT },
    signal: combineSignals(signal, MEDIA_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const contentLength = Number(res.headers?.get?.('content-length') || 0)
  if (contentLength > maxBytes) {
    try {
      await res.body?.cancel?.()
    } catch {}
    const err = new Error(`Archivo supera el límite máximo (${formatBytes(contentLength)})`)
    err.tooLarge = true
    err.contentLength = contentLength
    throw err
  }

  const arrayBuffer = await res.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  if (!buffer.length) throw new Error('Respuesta vacía')
  if (buffer.length > maxBytes) {
    const err = new Error(`Archivo supera el límite máximo (${formatBytes(buffer.length)})`)
    err.tooLarge = true
    err.contentLength = buffer.length
    throw err
  }

  const contentType = res.headers?.get?.('content-type') || ''
  if (isLikelyHtml(buffer, contentType)) {
    throw new Error('La URL devolvió HTML en lugar de media')
  }

  return { buffer, contentType }
}

async function downloadPhotoItem(item, { fetchImpl, signal }) {
  const urls = item.fallbackUrls?.length ? item.fallbackUrls : [item.url]
  let lastError = null

  for (const url of urls) {
    if (signal?.aborted) throw new DOMException('Descarga cancelada', 'AbortError')
    try {
      const { buffer, contentType } = await fetchBuffer(url, {
        fetchImpl,
        signal,
        maxBytes: VIDEO_INLINE_LIMIT,
      })
      return {
        kind: 'photo',
        buffer,
        size: buffer.length,
        mimetype: detectImageMime(buffer, contentType),
      }
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) throw err
      lastError = err
    }
  }

  throw lastError || new Error('No se pudo descargar la imagen')
}

async function downloadVideoItem(
  item,
  { fetchImpl, signal, inlineLimit = VIDEO_INLINE_LIMIT, maxDocumentLimit = MAX_DOCUMENT_LIMIT },
) {
  const variants = item.variants || []
  if (!variants.length) throw new Error('Sin variantes de video disponibles')

  let oversizedCandidate = null
  let lastError = null

  for (const variant of variants) {
    if (signal?.aborted) throw new DOMException('Descarga cancelada', 'AbortError')
    try {
      const { buffer } = await fetchBuffer(variant.url, {
        fetchImpl,
        signal,
        maxBytes: maxDocumentLimit,
      })

      const result = {
        kind: item.kind === 'gif' ? 'gif' : 'video',
        buffer,
        size: buffer.length,
        mimetype: 'video/mp4',
        resolution: variant.resolution || 'HD',
        oversized: buffer.length > inlineLimit,
      }

      if (!result.oversized) {
        return result
      }

      // Si supera el límite inline, guardamos este como respaldo e intentamos una variante más ligera.
      if (!oversizedCandidate || result.size < oversizedCandidate.size) {
        oversizedCandidate = result
      }
    } catch (err) {
      if (isAbortError(err) && signal?.aborted) throw err
      lastError = err
    }
  }

  if (oversizedCandidate) return oversizedCandidate
  throw lastError || new Error('No se pudo descargar el video')
}

async function downloadAllMedia(
  mediaList,
  {
    fetchImpl = globalThis.fetch,
    signal,
    inlineLimit = VIDEO_INLINE_LIMIT,
    maxDocumentLimit = MAX_DOCUMENT_LIMIT,
  } = {},
) {
  const settled = await Promise.allSettled(
    mediaList.map((item) =>
      item.kind === 'photo'
        ? downloadPhotoItem(item, { fetchImpl, signal })
        : downloadVideoItem(item, { fetchImpl, signal, inlineLimit, maxDocumentLimit }),
    ),
  )

  const items = []
  const errors = []

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]
    if (r.status === 'fulfilled') {
      items.push({ ...r.value, index: i })
    } else {
      if (isAbortError(r.reason) && signal?.aborted) throw r.reason
      errors.push({ index: i, message: r.reason?.message || String(r.reason) })
    }
  }

  return { items, errors }
}

function describeMediaType(items) {
  if (!items.length) return 'N/A'
  if (items.length === 1) {
    const only = items[0]
    if (only.kind === 'gif') return 'GIF (video/mp4)'
    return only.mimetype || (only.kind === 'photo' ? 'image/jpeg' : 'video/mp4')
  }

  let photos = 0
  let videos = 0
  let gifs = 0
  for (const item of items) {
    if (item.kind === 'photo') photos++
    else if (item.kind === 'gif') gifs++
    else videos++
  }

  const parts = []
  if (photos) parts.push(`${photos} ${photos === 1 ? 'imagen' : 'imágenes'}`)
  if (videos) parts.push(`${videos} ${videos === 1 ? 'video' : 'videos'}`)
  if (gifs) parts.push(`${gifs} ${gifs === 1 ? 'GIF' : 'GIFs'}`)
  return `Álbum (${parts.join(' + ')})`
}

function buildCaption({
  username,
  name,
  title,
  size,
  type,
  fecha,
  url,
  stats,
  isQuotedMedia = false,
}) {
  const userLabel =
    name && username ? `${name} (@${username})` : name || (username ? `@${username}` : 'N/A')

  const statParts = []
  const likes = formatCount(stats?.likes)
  const retweets = formatCount(stats?.retweets)
  const views = formatCount(stats?.views)
  if (likes) statParts.push(`♥ ${likes}`)
  if (retweets) statParts.push(`↻ ${retweets}`)
  if (views) statParts.push(`👁 ${views}`)

  const lines = [
    'ִֶָ𓂃 ࣪˖ ִֶָ  *FILE INFO* ִֶָ𓂃 ࣪˖ ִֶָ',
    '',
    `⭑ ₊ ⭒  *USER* ꩜  \`${sanitizeInlineText(userLabel, 60)}\``,
    `⭑ ₊ ⭒  *TITLE* ꩜  \`${sanitizeInlineText(title, 80)}\``,
    `⭑ ₊ ⭒  *SIZE* ꩜  \`${size}\``,
    `⭑ ₊ ⭒  *TYPE* ꩜  \`${type}\``,
    `⭑ ₊ ⭒  *FECHA* ꩜  \`${fecha}\``,
  ]

  if (statParts.length) {
    lines.push(`⭑ ₊ ⭒  *STATS* ꩜  \`${statParts.join(' · ')}\``)
  }
  if (isQuotedMedia) {
    lines.push('⭑ ₊ ⭒  *NOTA* ꩜  `Media del tweet citado`')
  }

  lines.push('', '˗ˏˋ ꒰ ✉︎ ꒱ ˎˊ˗  *URL*', url, '', '✧˚ ༘ ⋆｡˚  𖥔 ࣪˖')
  return lines.join('\n')
}

function buildAlbumChunks(inlineItems, caption, maxPerAlbum = MAX_ALBUM_ITEMS) {
  const chunks = []
  for (let i = 0; i < inlineItems.length; i += maxPerAlbum) {
    const slice = inlineItems.slice(i, i + maxPerAlbum)
    const entries = slice.map((item, idx) => {
      const withCaption = i === 0 && idx === 0 && caption ? { caption } : {}
      if (item.kind === 'photo') {
        return {
          image: item.buffer,
          mimetype: item.mimetype || 'image/jpeg',
          ...withCaption,
        }
      }
      return {
        video: item.buffer,
        mimetype: 'video/mp4',
        ...(item.kind === 'gif' ? { gifPlayback: true } : {}),
        ...withCaption,
      }
    })
    chunks.push(entries)
  }
  return chunks
}

// ─── Handler del plugin ───────────────────────────────────────────────────────

const SERVICE = 'twitter'

async function safeReact(conn, m, emoji) {
  if (!conn?.sendMessage || !m?.key) return
  try {
    await conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } })
  } catch {}
}

async function sendSingleInlineItem(conn, chat, item, caption, quoted) {
  if (item.kind === 'photo') {
    return conn.sendMessage(
      chat,
      {
        image: item.buffer,
        mimetype: item.mimetype || 'image/jpeg',
        ...(caption ? { caption } : {}),
      },
      { quoted },
    )
  }

  return conn.sendMessage(
    chat,
    {
      video: item.buffer,
      mimetype: 'video/mp4',
      ...(item.kind === 'gif' ? { gifPlayback: true } : {}),
      ...(caption ? { caption } : {}),
    },
    { quoted },
  )
}

async function sendInlineMedia(conn, chat, inlineItems, caption, quoted) {
  if (!inlineItems.length) return

  if (inlineItems.length === 1) {
    await sendSingleInlineItem(conn, chat, inlineItems[0], caption, quoted)
    return
  }

  const chunks = buildAlbumChunks(inlineItems, caption)
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]
    if (chunk.length === 1) {
      await conn.sendMessage(chat, chunk[0], { quoted })
      continue
    }

    try {
      await conn.sendMessage(
        chat,
        { album: chunk },
        { quoted, albumContinueOnError: true },
      )
    } catch (albumErr) {
      console.warn('[Twitter-DL] Falló el envío en álbum, reintentando por separado:', albumErr?.message || albumErr)
      for (const entry of chunk) {
        await conn.sendMessage(chat, entry, { quoted })
      }
    }
  }
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  const rawUrl = extractTwitterUrl(
    text,
    args?.join(' '),
    m.quoted?.text,
    m.quoted?.caption,
  )

  if (!rawUrl) {
    return conn.sendMessage(
      m.chat,
      {
        text: `⭑ Envía el link de un tweet junto al comando (o responde a un mensaje con el link).\n\n*Ejemplo:*\n${usedPrefix + command} https://x.com/usuario/status/123456789`,
      },
      { quoted: m },
    )
  }

  const key = downloadKey(m)
  if (hasDownload(key, SERVICE)) {
    return conn.sendMessage(
      m.chat,
      { text: '⏳ Ya tienes una descarga de X/Twitter en curso. Usa *cancelar* si deseas detenerla.' },
      { quoted: m },
    )
  }

  const controller = new AbortController()
  const finish = startDownload(key, SERVICE, controller, { label: 'Twitter/X' })

  try {
    await safeReact(conn, m, '⏳')

    const resolved = await resolveTwitterUrl(rawUrl, { signal: controller.signal })
    if (!resolved.tweetId) {
      await safeReact(conn, m, '❌')
      return conn.sendMessage(
        m.chat,
        { text: '❌ URL inválida. Usa un enlace de X/Twitter que apunte a un tweet específico.' },
        { quoted: m },
      )
    }

    let tweet
    try {
      tweet = await fetchTweetData(resolved.tweetId, {
        screenName: resolved.screenName,
        signal: controller.signal,
      })
    } catch (e) {
      if (isAbortError(e) && controller.signal.aborted) throw e
      await safeReact(conn, m, '❌')
      return conn.sendMessage(
        m.chat,
        { text: `❌ No se pudo obtener el tweet (puede ser privado, eliminado o con restricción).\n\`${e.message}\`` },
        { quoted: m },
      )
    }

    if (!tweet?.media?.length) {
      await safeReact(conn, m, '❌')
      return conn.sendMessage(
        m.chat,
        { text: '❌ No se encontró ninguna imagen ni video en ese tweet.' },
        { quoted: m },
      )
    }

    const { items, errors } = await downloadAllMedia(tweet.media, {
      signal: controller.signal,
    })

    if (!items.length) {
      await safeReact(conn, m, '❌')
      const detail = errors[0]?.message ? `\n\`${errors[0].message}\`` : ''
      return conn.sendMessage(
        m.chat,
        { text: `❌ No se pudo descargar la media del tweet.${detail}` },
        { quoted: m },
      )
    }

    const inlineItems = items.filter((item) => !item.oversized)
    const docItems = items.filter((item) => item.oversized)
    const cleanUrl = resolved.url

    if (inlineItems.length) {
      const totalInlineBytes = inlineItems.reduce((acc, it) => acc + (it.size || 0), 0)
      const infoCaption = buildCaption({
        username: tweet.author.username,
        name: tweet.author.name,
        title: tweet.text || 'Sin título',
        size: formatBytes(totalInlineBytes),
        type: describeMediaType(inlineItems),
        fecha: formatDate(tweet.createdAt),
        url: cleanUrl,
        stats: tweet.stats,
        isQuotedMedia: tweet.isQuotedMedia,
      })

      await sendInlineMedia(conn, m.chat, inlineItems, infoCaption, m)
    }

    for (let i = 0; i < docItems.length; i++) {
      const item = docItems[i]
      const suffix = docItems.length > 1 ? `_${i + 1}` : ''
      const baseName = sanitizeFileName(
        tweet.text || `tweet_${tweet.author.username || resolved.tweetId}`,
      )
      const fileName = `${baseName}${suffix}.mp4`
      const docCaption = buildCaption({
        username: tweet.author.username,
        name: tweet.author.name,
        title: tweet.text || 'Sin título',
        size: formatBytes(item.size),
        type: `video/mp4 (${item.resolution || 'HD'})`,
        fecha: formatDate(tweet.createdAt),
        url: cleanUrl,
        stats: tweet.stats,
        isQuotedMedia: tweet.isQuotedMedia,
      })

      await conn.sendMessage(
        m.chat,
        {
          document: item.buffer,
          mimetype: 'video/mp4',
          fileName,
          caption: docCaption,
        },
        { quoted: m },
      )
    }

    if (errors.length) {
      await conn.sendMessage(
        m.chat,
        { text: `⚠️ Se omitieron ${errors.length} archivo(s) porque no se pudieron descargar.` },
        { quoted: m },
      )
    }

    await safeReact(conn, m, '✅')
  } catch (e) {
    if (isAbortError(e) && controller.signal.aborted) {
      await safeReact(conn, m, '🛑')
      return conn.sendMessage(
        m.chat,
        { text: '🛑 Descarga de X/Twitter cancelada.' },
        { quoted: m },
      )
    }
    console.error('[Twitter-DL]', e)
    await safeReact(conn, m, '❌')
    return conn.sendMessage(
      m.chat,
      { text: `❌ Error inesperado al procesar el tweet.\n\`${e?.message || e}\`` },
      { quoted: m },
    )
  } finally {
    finish()
  }
}

handler.help = ['x <url>', 'twitter <url>']
handler.tags = ['downloader']
handler.command = /^(x|twitter|xdl|dlx|twdl|twt|twitterdl)$/i

export default handler

// ─── Tests embebidos (solo al ejecutar `node --test plugins/twitter-x.js`) ────

if (IS_TEST_RUN) {
  const { default: test } = await import('node:test')
  const { default: assert } = await import('node:assert/strict')

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

  test('buildAlbumChunks agrupa 20+ items en un solo álbum, pone caption solo en el primero y divide solo si supera el límite', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      kind: i % 2 === 0 ? 'photo' : 'video',
      buffer: i % 2 === 0 ? JPEG_BYTES : MP4_BYTES,
      mimetype: i % 2 === 0 ? 'image/jpeg' : 'video/mp4',
    }))

    const chunks = buildAlbumChunks(items, 'MI CAPTION')
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].length, 20)
    assert.equal(chunks[0][0].caption, 'MI CAPTION')
    assert.equal(chunks[0][1].caption, undefined)

    const split = buildAlbumChunks(items, 'MI CAPTION', 15)
    assert.equal(split.length, 2)
    assert.equal(split[0].length, 15)
    assert.equal(split[1].length, 5)
    assert.equal(split[1][0].caption, undefined)
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

      await handler(m, {
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

      await handler(m, {
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
}
