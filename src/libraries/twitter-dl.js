const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const VIDEO_INLINE_LIMIT = 50 * 1024 * 1024 // 50 MB (límite seguro para video/álbum inline en WhatsApp)
export const MAX_DOCUMENT_LIMIT = 100 * 1024 * 1024 // 100 MB (límite máximo como documento)
export const MAX_ALBUM_ITEMS = 10

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

export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'N/A'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export const formatCount = (n) => {
  if (!Number.isFinite(n) || n < 0) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(n)
}

export const formatDate = (iso) => {
  if (!iso) return 'N/A'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'N/A'
  return d
    .toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })
    .toUpperCase()
}

export const sanitizeFileName = (str = '') => {
  const cleaned = String(str)
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || 'twitter_media'
}

export const sanitizeInlineText = (str = '', maxLen = 90) => {
  const cleaned = String(str)
    .replace(/https?:\/\/t\.co\/\S+/gi, '')
    .replace(/[`\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'Sin título'
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen).trim()}…` : cleaned
}

export const extractTwitterUrl = (...sources) => {
  for (const src of sources) {
    if (!src) continue
    const match = String(src).match(TWITTER_URL_REGEX)
    if (match) {
      return match[0].replace(/[),.!?;:'"\]}>]+$/g, '')
    }
  }
  return null
}

export const extractTweetId = (url) => {
  if (!url) return null
  const match = String(url).match(STATUS_ID_REGEX)
  return match ? match[1] : null
}

export const extractScreenName = (url) => {
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

export const isAbortError = (err) =>
  err?.name === 'AbortError' || err?.code === 'ABORT_ERR'

export async function resolveTwitterUrl(rawUrl, { fetchImpl = globalThis.fetch, signal } = {}) {
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

export function buildPhotoCandidates(url) {
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

export function parseFxTwitterResponse(data) {
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

export function parseVxTwitterResponse(data) {
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

export function parseSyndicationResponse(data) {
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

export function parseTweeloadResponse(data) {
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

export async function fetchTweetData(
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

export function detectImageMime(buffer, contentType = '') {
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

export function isLikelyHtml(buffer, contentType = '') {
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

export async function downloadAllMedia(
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

export function describeMediaType(items) {
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

export function buildCaption({
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

export function buildAlbumChunks(inlineItems, caption, maxPerAlbum = MAX_ALBUM_ITEMS) {
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
