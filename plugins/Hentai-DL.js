// ╔══════════════════════════════════════════════════════════════╗
// ║             HENTAI-DL.js — HentaiLA Downloader              ║
// ║  Comandos:                                                   ║
// ║   .hdl <nombre> <episodio>  → busca, portada y descarga     ║
// ║   .hdl overflow 1           → ejemplo                       ║
// ║   .hlatest                  → últimos lanzamientos          ║
// ╚══════════════════════════════════════════════════════════════╝

import nodeFetch from 'node-fetch'
import { prepareWAMessageMedia, generateWAMessageFromContent, getDevice } from '@whiskeysockets/baileys'
import * as cheerio from 'cheerio'
import { File as MegaFile } from 'megajs'
import { pipeline } from 'stream/promises'
import { PassThrough } from 'stream'
import { performance } from 'perf_hooks'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import https from 'https'

// ─── Configuración ─────────────────────────────────────────────────────────
const BASE = 'https://hentaila.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const httpsAgent = new https.Agent({ keepAlive: true, maxFreeSockets: 10 })

// ╔═══════════════════════════════════════════════════════════════════╗
// ║  CONFIGURACIÓN DEL PROXY — LEE ESTO                             ║
// ║                                                                   ║
// ║  Opción 1 (RECOMENDADA): Cloudflare Worker (gratis, 100k/día)   ║
// ║  1. Ve a https://workers.cloudflare.com y crea cuenta gratis     ║
// ║  2. Dashboard → Workers & Pages → Create Worker                  ║
// ║  3. Pega el código del worker (ver comentario más abajo)         ║
// ║  4. Deploy → copia la URL y pégala en CF_WORKER_URL              ║
// ║                                                                   ║
// ║  Opción 2: Sin proxy (puede ser bloqueado por Cloudflare)        ║
// ║  Deja CF_WORKER_URL = '' y el bot intentará conexión directa     ║
// ╚═══════════════════════════════════════════════════════════════════╝
//
// CÓDIGO DEL WORKER (pégalo en el editor de Cloudflare Workers):
// ─────────────────────────────────────────────────────────────────
// export default {
//   async fetch(request) {
//     const url = new URL(request.url)
//     const target = url.searchParams.get('url')
//     if (!target) return new Response('Falta ?url=', { status: 400 })
//     try {
//       const res = await fetch(target, {
//         headers: {
//           'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
//           'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
//           'Accept-Language': 'es-419,es;q=0.9',
//         },
//         redirect: 'follow',
//       })
//       const body = await res.text()
//       return new Response(body, {
//         status: res.status,
//         headers: { 'Content-Type': res.headers.get('Content-Type') || 'text/html', 'Access-Control-Allow-Origin': '*' }
//       })
//     } catch(e) { return new Response('Error: ' + e.message, { status: 500 }) }
//   }
// }
// ─────────────────────────────────────────────────────────────────

const CF_WORKER_URL = 'https://purple-cloud-3351.luisluissandovaltarazona.workers.dev'

global.activeDownloads = global.activeDownloads || new Map()
global.hentaiSelection = global.hentaiSelection || {}
global.hdlSessions = global.hdlSessions || {}

// ─── fetch wrapper robusto ─────────────────────────────────────────────────
async function fetchGet(url, opts = {}) {
    const timeoutMs = opts.timeout || 25000
    delete opts.timeout
    return nodeFetch(url, {
        ...opts,
        agent: opts.agent !== null ? (opts.agent || httpsAgent) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    })
}

// ─── Cabeceras estándar para bypass básico de Cloudflare ──────────────────
const CF_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-419,es;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
}

// ─── Cola de peticiones (máx 1 a la vez, delay entre c/u) ─────────────────
const REQUEST_DELAY = 2000
let _lastRequestTime = 0
let _queueRunning = false
const _requestQueue = []

function queuedFetch(fn) {
    return new Promise((resolve, reject) => {
        _requestQueue.push({ fn, resolve, reject })
        if (!_queueRunning) _processQueue()
    })
}

async function _processQueue() {
    if (_requestQueue.length === 0) { _queueRunning = false; return }
    _queueRunning = true
    const { fn, resolve, reject } = _requestQueue.shift()
    const now = Date.now()
    const wait = Math.max(0, _lastRequestTime + REQUEST_DELAY - now)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    _lastRequestTime = Date.now()
    try { resolve(await fn()) } catch (e) { reject(e) }
    _processQueue()
}

// ─── Helper: verificar si respuesta es HTML válido (no página CF bloqueada) ─
function esCFBloqueado(html) {
    if (!html || html.length < 200) return true
    // Cloudflare challenge/block pages tienen estas firmas características
    if (html.includes('cf-browser-verification') ||
        html.includes('Just a moment') ||
        html.includes('challenge-platform') ||
        html.includes('Enable JavaScript and cookies') ||
        html.includes('cf_clearance')) return true
    return false
}

// ─── Capa 1: Via Cloudflare Worker (si está configurado) ──────────────────
async function fetchViaWorker(url) {
    if (!CF_WORKER_URL) throw new Error('CF_WORKER_URL no configurado')
    const proxyUrl = `${CF_WORKER_URL.replace(/\/$/, '')}/?url=${encodeURIComponent(url)}`
    const res = await fetchGet(proxyUrl, { timeout: 30000, agent: null })
    if (!res.ok) throw new Error(`Worker HTTP ${res.status}`)
    return res.text()
}

// ─── Capa 2: Fetch directo con headers de Chrome completos ────────────────
async function fetchDirecto(url) {
    const res = await fetchGet(url, { headers: CF_HEADERS, timeout: 25000, compress: true })
    if (!res.ok) throw new Error(`Directo HTTP ${res.status}`)
    return res.text()
}

// ─── Capa 3: Via proxies públicos gratuitos (lista rotativa) ──────────────
// Estos proxies HTTPS son gratuitos y rotan automáticamente
const PUBLIC_CORS_PROXIES = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    (url) => `https://thingproxy.freeboard.io/fetch/${encodeURIComponent(url)}`,
]
let _proxyIndex = 0

async function fetchViaProxy(url) {
    // Intentar cada proxy en rotación hasta que uno funcione
    for (let i = 0; i < PUBLIC_CORS_PROXIES.length; i++) {
        const proxyFn = PUBLIC_CORS_PROXIES[_proxyIndex % PUBLIC_CORS_PROXIES.length]
        _proxyIndex++
        const proxyUrl = proxyFn(url)
        try {
            const res = await fetchGet(proxyUrl, { timeout: 20000, agent: null })
            if (!res.ok) continue
            const text = await res.text()
            if (!esCFBloqueado(text)) return text
        } catch (_) { continue }
    }
    throw new Error('Todos los proxies públicos fallaron')
}

// ─── fetchText: cadena de fallback con 3 capas ────────────────────────────
// Capa 1: CF Worker (más confiable) → Capa 2: Directo → Capa 3: Proxy público
async function fetchText(url) {
    return queuedFetch(async () => {
        // Capa 1: Cloudflare Worker
        if (CF_WORKER_URL) {
            try {
                const html = await fetchViaWorker(url)
                if (!esCFBloqueado(html)) {
                    console.log(`[HDL] ✅ CF Worker OK: ${url.replace(BASE, '')}`)
                    return html
                }
            } catch (e) {
                console.warn(`[HDL] CF Worker falló: ${e.message}`)
            }
        }

        // Capa 2: Directo con headers de Chrome
        try {
            const html = await fetchDirecto(url)
            if (!esCFBloqueado(html)) {
                console.log(`[HDL] ✅ Directo OK: ${url.replace(BASE, '')}`)
                return html
            }
        } catch (e) {
            console.warn(`[HDL] Directo falló: ${e.message}`)
        }

        // Capa 3: Proxies públicos rotativos
        console.log(`[HDL] Intentando proxies públicos...`)
        const html = await fetchViaProxy(url)
        console.log(`[HDL] ✅ Proxy público OK: ${url.replace(BASE, '')}`)
        return html
    })
}

// ─── fetchBuffer: para imágenes (portadas) ────────────────────────────────
async function fetchBuffer(url) {
    return queuedFetch(async () => {
        // Para imágenes de CDN (no son hentaila.com directamente) funciona sin proxy
        try {
            const res = await fetchGet(url, {
                headers: { 'User-Agent': UA, 'Referer': BASE + '/' },
                timeout: 20000,
            })
            if (res.ok) {
                if (typeof res.buffer === 'function') return res.buffer()
                return Buffer.from(await res.arrayBuffer())
            }
        } catch (_) { }

        // Fallback: via proxy
        if (CF_WORKER_URL) {
            try {
                const proxyUrl = `${CF_WORKER_URL.replace(/\/$/, '')}/?url=${encodeURIComponent(url)}`
                const res = await fetchGet(proxyUrl, { timeout: 20000, agent: null })
                if (res.ok) {
                    if (typeof res.buffer === 'function') return res.buffer()
                    return Buffer.from(await res.arrayBuffer())
                }
            } catch (_) { }
        }
        throw new Error(`No se pudo obtener imagen: ${url}`)
    })
}

// ─── Helper: enviar lista interactiva de WhatsApp ─────────────────────────
async function enviarListaWA(conn, chat, m, titulo, descripcion, boton, seccion, filas, coverUrl = null) {
    const sessionKey = `${chat}|${m.sender}`
    global.hdlSessions[sessionKey] = {
        owner: m.sender,
        chat,
        expiry: Date.now() + 5 * 60 * 1000,
    }
    const now = Date.now()
    for (const k of Object.keys(global.hdlSessions)) {
        if (global.hdlSessions[k].expiry < now) delete global.hdlSessions[k]
    }

    let device
    try { device = getDevice(m.key.id) } catch (_) { device = 'android' }
    const isMobile = device !== 'desktop' && device !== 'web'

    if (isMobile) {
        try {
            let header
            if (coverUrl) {
                try {
                    const messa = await prepareWAMessageMedia(
                        { image: { url: coverUrl } },
                        { upload: conn.waUploadToServer }
                    )
                    header = {
                        title: titulo,
                        hasMediaAttachment: true,
                        imageMessage: messa.imageMessage,
                    }
                } catch (_) {
                    header = { title: titulo, hasMediaAttachment: false }
                }
            } else {
                header = { title: titulo, hasMediaAttachment: false }
            }

            const interactiveMessage = {
                body: { text: descripcion },
                footer: { text: global.wm || 'HentaiLA Bot' },
                header,
                nativeFlowMessage: {
                    buttons: [{
                        name: 'single_select',
                        buttonParamsJson: JSON.stringify({
                            title: boton,
                            sections: [{
                                title: seccion,
                                highlight_label: '',
                                rows: filas.map(r => ({
                                    header: r.title,
                                    title: r.subtitle || r.title,
                                    description: r.description || '',
                                    id: r.rowId,
                                })),
                            }],
                        }),
                    }],
                    messageParamsJson: '',
                },
            }

            const msg = generateWAMessageFromContent(
                chat,
                { viewOnceMessage: { message: { interactiveMessage } } },
                { userJid: conn.user.jid, quoted: m }
            )
            await conn.relayMessage(chat, msg.message, { messageId: msg.key.id })
            return msg
        } catch (err) {
            console.error('[interactiveMessage] Error:', err.message)
        }
    }

    // Fallback: texto plano
    let txt = `✨ *${titulo}*\n_${descripcion}_\n\n`
    filas.forEach((r, i) => {
        txt += `*${i + 1}.* ${r.title}`
        if (r.description) txt += ` _(${r.description})_`
        txt += `\n`
    })
    txt += `\n_Responde con el número o el comando._`
    return conn.sendMessage(chat, { text: txt }, { quoted: m })
}

// ─── Info de la serie: portada, descripción, episodios ────────────────────
async function obtenerInfoSerie(slug) {
    const html = await fetchText(`${BASE}/media/${slug}`)

    const imgMatch = html.match(/property="og:image"\s+content="([^"]+)"/) ||
        html.match(/content="([^"]+)"\s+property="og:image"/)
    const cover = imgMatch?.[1] || null

    const descMatch = html.match(/property="og:description"\s+content="([^"]+)"/) ||
        html.match(/name="description"\s+content="([^"]+)"/)
    const desc = descMatch?.[1]?.trim() || 'Sin descripción.'

    const titleMatch = html.match(/<title>([^<]+)<\/title>/)
    const title = titleMatch?.[1]?.replace(/\s*[-–|].*$/, '').trim() || slug.replace(/-/g, ' ')

    const epSet = new Set()
    const epRe = new RegExp(`/media/${slug}/(\\d+)`, 'g')
    let mMatch
    while ((mMatch = epRe.exec(html)) !== null) epSet.add(Number(mMatch[1]))
    const episodes = [...epSet].sort((a, b) => a - b)

    const $ = cheerio.load(html)
    const generos = []
    $('a[href*="?genre="]').each((_, el) => generos.push($(el).text().trim()))

    return { slug, title, cover, desc, episodes, generos }
}

// ─── Generar variaciones de slug ──────────────────────────────────────────
function generarSlugVariaciones(query) {
    const base = query.toLowerCase().trim()
    const variaciones = new Set()

    const full = base.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    variaciones.add(full)

    const sinStop = base.split(' ').filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'una', 'los', 'las', 'del'].includes(w))
    variaciones.add(sinStop.join('-').replace(/[^a-z0-9-]/g, ''))

    variaciones.add(base.split(' ').slice(0, 3).join('-').replace(/[^a-z0-9-]/g, ''))
    variaciones.add(base.split(' ').slice(0, 2).join('-').replace(/[^a-z0-9-]/g, ''))
    variaciones.add(base.split(' ')[0].replace(/[^a-z0-9-]/g, ''))

    const sinParticulas = base.replace(/\b(wa|no|ga|wo|ni|ha|de|mo|ka)\b/g, '').replace(/\s+/g, ' ').trim()
    variaciones.add(sinParticulas.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))

    return [...variaciones].filter(v => v && v.length > 1)
}

// ─── Búsqueda por fetch (extrae slugs del HTML de SvelteKit) ──────────────
async function buscarPorFetch(query) {
    try {
        const res = await fetchGet(`${BASE}/busqueda?q=${encodeURIComponent(query)}`, {
            headers: CF_HEADERS,
            timeout: 20000,
        })
        if (!res.ok) return []
        const html = await res.text()
        const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')

        const results = []
        const re = /"slug":"([^"]+)"(?:[^}]{0,300}?"title":"([^"]+)")?/g
        let m
        while ((m = re.exec(decoded)) !== null) {
            const slug = m[1], title = m[2] || m[1].replace(/-/g, ' ')
            if (slug && !results.find(r => r.slug === slug) && !slug.includes('/'))
                results.push({ slug, title })
        }
        const re2 = /href="\/media\/([^/"]+)(?:\/\d+)?"/g
        while ((m = re2.exec(decoded)) !== null) {
            const slug = m[1]
            if (slug && !results.find(r => r.slug === slug))
                results.push({ slug, title: slug.replace(/-/g, ' ') })
        }
        return results
    } catch (_) {
        return []
    }
}

// ─── Búsqueda principal ────────────────────────────────────────────────────
async function buscarHentaiLA(query) {
    // 1. Probar slugs generados directamente
    const variaciones = generarSlugVariaciones(query)
    for (const slug of variaciones) {
        try {
            const _html = await fetchText(`${BASE}/media/${slug}`)
            if (_html && _html.length > 500 && !_html.includes('404')) {
                console.log(`[SLUG] ✅ Encontrado directo: ${slug}`)
                return [{ slug, title: slug.replace(/-/g, ' ') }]
            }
        } catch (_) { continue }
    }

    // 2. Fetch por búsqueda
    const fetchResults = await buscarPorFetch(query)
    if (fetchResults.length > 0) {
        console.log(`[FETCH] ✅ ${fetchResults.length} resultados`)
        return fetchResults
    }

    return []
}

// ─── Últimos lanzamientos ─────────────────────────────────────────────────
async function obtenerUltimos() {
    const html = await fetchText(`${BASE}/`)
    const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')
    const results = []
    const re = /"slug":"([^"]+)"[^}]{0,200}?"episode":(\d+)(?:[^}]{0,200}?"title":"([^"]+)")?/g
    let m
    while ((m = re.exec(decoded)) !== null) {
        const slug = m[1], episode = m[2], title = m[3] || m[1].replace(/-/g, ' ')
        if (!results.find(r => r.slug === slug))
            results.push({ slug, title, episode })
    }
    if (results.length === 0) {
        const re2 = /href="\/media\/([^/]+)\/(\d+)"/g
        while ((m = re2.exec(html)) !== null) {
            const slug = m[1], episode = m[2]
            if (!results.find(r => r.slug === slug))
                results.push({ slug, title: slug.replace(/-/g, ' '), episode })
        }
    }
    return results.slice(0, 10)
}

// ─── Links de descarga en página /media/slug/ep ──────────────────────────
async function obtenerLinksDescarga(mediaUrl) {
    const html = await fetchText(mediaUrl)
    const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')

    const mega = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mega\.nz\/file\/[^\s"'<\\]*/g) || [])]
    const mediafire = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mediafire\.com\/file[^\s"'<\\]*/g) || [])]
    const fireload = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*fireload\.com\/[^\s"'<\\]*/g) || [])]
    const fichier = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*1fichier\.com\/\?[^\s"'<\\]*/g) || [])]
    const mp4upload = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mp4upload\.com\/[^\s"'<\\]*/g) || [])]
    const yourupload = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*yourupload\.com\/[^\s"'<\\]*/g) || [])]
    const otros = [...new Set(
        (decoded.match(/https?:\/\/[^\s"'<\\]{10,}/g) || [])
            .filter(u =>
                !u.includes(BASE) &&
                !mega.includes(u) && !mediafire.includes(u) && !fireload.includes(u) &&
                !fichier.includes(u) && !mp4upload.includes(u) && !yourupload.includes(u) &&
                /\.(mp4|mkv|avi|ts|m4v)(\?|$)/i.test(u)
            )
    )]

    return { mega, mediafire, fireload, fichier, mp4upload, yourupload, otros }
}

// ─── Resolvers ────────────────────────────────────────────────────────────
async function resolverMediafire(url) {
    const res = await fetchGet(url, { headers: { 'User-Agent': UA }, timeout: 15000 })
    const html = await res.text()
    const $ = cheerio.load(html)
    const direct =
        $('#downloadButton').attr('href') ||
        html.match(/href="(https:\/\/download\d+\.mediafire\.com[^"]+)"/)?.[1]
    const name =
        $('.promoDownloadName').first().attr('title') ||
        $('.filename').first().text().trim() ||
        url.split('/').pop().split('?')[0] || 'video.mp4'
    return { direct, name: name.trim() }
}

async function resolverFireload(url) {
    const res = await fetchGet(url, { headers: { 'User-Agent': UA }, timeout: 15000 })
    const html = await res.text()
    const direct =
        html.match(/href="(https?:\/\/[^"]*fireload\.com\/d\/[^"]+)"/)?.[1] ||
        html.match(/file:\s*"([^"]+)"/)?.[1] ||
        html.match(/source\s+src="([^"]+)"/)?.[1]
    const name = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() || 'video.mp4'
    return { direct: direct || null, name }
}

async function resolver1fichier(url) {
    const res = await fetchGet('https://api.1fichier.com/v1/download/get_token.cgi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ url }),
        timeout: 15000,
    })
    const json = await res.json().catch(() => null)
    return { direct: json?.download_url || null, name: json?.filename || 'video.mp4' }
}

async function resolverMp4upload(url) {
    const res = await fetchGet(url, { headers: { 'User-Agent': UA }, timeout: 15000 })
    const html = await res.text()
    const direct =
        html.match(/file:\s*"([^"]+\.mp4[^"]*)"/)?.[1] ||
        html.match(/src:\s*"([^"]+\.mp4[^"]*)"/)?.[1] ||
        html.match(/source\s+src="([^"]+)"/)?.[1]
    const name = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() || 'video.mp4'
    return { direct: direct || null, name }
}

// ─── Descarga genérica por URL directa ───────────────────────────────────
async function descargarDirecto(directUrl, fileName, tempPath, updateStatus, label) {
    const headRes = await fetchGet(directUrl, { method: 'HEAD', headers: { 'User-Agent': UA }, timeout: 10000 })
    const sizeBytes = parseInt(headRes.headers.get('content-length') || '0')
    const sizeH = sizeBytes ? (sizeBytes / 1048576).toFixed(2) + ' MB' : '?'

    await updateStatus(`📥 *${label}:* ${fileName}\n⚖️ *Peso:* ${sizeH}\n⏬ _Descargando..._`)

    const response = await fetchGet(directUrl, { headers: { 'User-Agent': UA }, timeout: 180000 })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    let dld = 0
    response.body.on('data', chunk => {
        dld += chunk.length
        if (sizeBytes > 0) process.stdout.write(`\r[${label}] ${((dld / sizeBytes) * 100).toFixed(1)}% (${(dld / 1048576).toFixed(1)} MB)`)
    })
    await pipeline(response.body, fs.createWriteStream(tempPath))
    console.log(`\n[${label}] ✅ Completo`)
    return sizeH
}

// ─── Enviar portada con info ───────────────────────────────────────────────
async function enviarPortada(m, conn, info, episodio = null, extra = '') {
    const { title, cover, desc, episodes, generos } = info
    const totalEps = episodes.length
    const lastEp = episodes[totalEps - 1] || '?'
    const rango = totalEps === 1 ? 'Episodio 1' : `Episodios 1 – ${lastEp}`
    const tags = generos.length > 0 ? generos.slice(0, 6).join(' • ') : 'N/A'

    const caption =
        `🔞 *${title}*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📖 ${desc}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🎬 *Episodios:* ${totalEps > 0 ? `${totalEps} (${rango})` : '?'}\n` +
        `🏷️ *Géneros:* ${tags}\n` +
        (extra ? `━━━━━━━━━━━━━━━━━━━━\n${extra}` : '')

    if (cover) {
        try {
            const imgBuf = await fetchBuffer(cover)
            await conn.sendMessage(m.chat, { image: imgBuf, caption, mimetype: 'image/jpeg' }, { quoted: m })
            return
        } catch (_) { }
    }
    await conn.sendMessage(m.chat, { text: caption }, { quoted: m })
}

// ─── FIX 4: Descarga + envío del archivo ──────────────────────────────────
// Bug original: "document: { url: tempPath }" — tempPath es una ruta local,
// NO una URL HTTP. Baileys no puede leer un archivo desde path://.
// Fix: leer el archivo como Buffer y pasarlo directamente.
async function descargarYEnviar(m, conn, mediaUrl, title, episodio, updateStatus) {
    const links = await obtenerLinksDescarga(mediaUrl)

    const totalLinks =
        links.mega.length + links.mediafire.length + links.fireload.length +
        links.fichier.length + links.mp4upload.length + links.yourupload.length + links.otros.length

    if (totalLinks === 0) {
        return updateStatus(`❌ No se encontraron links de descarga.\n🔗 ${mediaUrl}`)
    }

    const servidores = [
        ...links.mediafire.map(u => ({ tipo: 'mediafire', url: u })),
        ...links.fireload.map(u => ({ tipo: 'fireload', url: u })),
        ...links.fichier.map(u => ({ tipo: '1fichier', url: u })),
        ...links.mp4upload.map(u => ({ tipo: 'mp4upload', url: u })),
        ...links.yourupload.map(u => ({ tipo: 'yourupload', url: u })),
        ...links.otros.map(u => ({ tipo: 'directo', url: u })),
        ...links.mega.map(u => ({ tipo: 'mega', url: u })),
    ]

    let tempPath = null
    let fileName = `${title} - Ep ${episodio}.mp4`
    let sizeH = '?'
    let exitoso = false

    for (const srv of servidores) {
        tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
        try {
            await updateStatus(`🔄 *Intentando con ${srv.tipo.toUpperCase()}...*\n⏳ Ep. ${episodio} de *${title}*`)

            if (srv.tipo === 'mega') {
                const file = MegaFile.fromURL(srv.url)
                await file.loadAttributes()
                fileName = file.name || fileName
                const sizeBytes = file.size
                sizeH = (sizeBytes / 1048576).toFixed(2) + ' MB'
                tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
                await updateStatus(`📥 *MEGA:* ${fileName}\n⚖️ *Peso:* ${sizeH}\n⏬ _Descargando..._`)
                const fileStream = file.download()
                let dld = 0
                fileStream.on('data', chunk => {
                    dld += chunk.length
                    process.stdout.write(`\r[MEGA] ${((dld / sizeBytes) * 100).toFixed(1)}% (${(dld / 1048576).toFixed(1)} MB)`)
                })
                await pipeline(fileStream, fs.createWriteStream(tempPath))
                console.log('\n[MEGA] ✅ Completo')

            } else if (srv.tipo === 'mediafire') {
                const { direct, name } = await resolverMediafire(srv.url)
                if (!direct) throw new Error('No se pudo resolver MediaFire')
                fileName = name || fileName
                tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, 'MediaFire')

            } else if (srv.tipo === 'fireload') {
                const { direct, name } = await resolverFireload(srv.url)
                if (!direct) throw new Error('No se pudo resolver FireLoad')
                fileName = name || fileName
                tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, 'FireLoad')

            } else if (srv.tipo === '1fichier') {
                const { direct, name } = await resolver1fichier(srv.url)
                if (!direct) throw new Error('No se pudo resolver 1Fichier')
                fileName = name || fileName
                tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, '1Fichier')

            } else if (srv.tipo === 'mp4upload') {
                const { direct, name } = await resolverMp4upload(srv.url)
                if (!direct) throw new Error('No se pudo resolver MP4Upload')
                fileName = name || fileName
                tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, 'MP4Upload')

            } else if (srv.tipo === 'yourupload') {
                const res = await fetchGet(srv.url, { headers: { 'User-Agent': UA }, timeout: 15000 })
                const html = await res.text()
                const direct = html.match(/file:\s*"([^"]+)"/)?.[1] || html.match(/src="([^"]+\.mp4[^"]*)"/)?.[1]
                if (!direct) throw new Error('No se pudo resolver YourUpload')
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, 'YourUpload')

            } else {
                sizeH = await descargarDirecto(srv.url, fileName, tempPath, updateStatus, 'Directo')
            }

            exitoso = true
            break

        } catch (err) {
            console.error(`[${srv.tipo.toUpperCase()}] ❌ Falló: ${err.message}`)
            await updateStatus(`⚠️ *${srv.tipo.toUpperCase()} falló*, probando siguiente servidor...`)
            if (tempPath && fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath) } catch (_) { }
            }
            tempPath = null
            continue
        }
    }

    if (!exitoso || !tempPath) {
        return updateStatus(`❌ Todos los servidores fallaron para el ep. ${episodio} de *${title}*.\n🔗 ${mediaUrl}`)
    }

    try {
        await updateStatus(`✅ *Descarga completa!*\n📤 _Enviando a WhatsApp..._`)

        // FIX 4: Leer el archivo como Buffer — Baileys necesita el contenido,
        // NO una ruta de archivo local. "document: { url: '/tmp/...' }" no funciona.
        const fileBuffer = fs.readFileSync(tempPath)
        const stats = fs.statSync(tempPath)
        const epNum = String(episodio).padStart(2, '0')
        const cleanTitle = title.replace(/[/\\:*?"<>|]/g, '').trim()
        const finalName = `${epNum} ${cleanTitle}.mp4`
        const fileSizeH = (stats.size / 1048576).toFixed(2) + ' MB'

        await conn.sendMessage(m.chat, {
            document: fileBuffer,               // ← Buffer directo, no { url: path }
            fileName: finalName,
            mimetype: 'video/mp4',
            caption:
                `🔞 *${title}* — Ep. ${episodio}\n` +
                `📁 ${finalName}\n` +
                `⚖️ ${fileSizeH}\n` +
                `🌐 HentaiLA`,
        }, { quoted: m })

        console.log(`\n[BOT] ✨ Enviado: ${finalName}`)
        await updateStatus(`✅ *¡Enviado!* 🔞 ${title} — Ep. ${episodio}`)

    } finally {
        if (tempPath && fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath) } catch (_) { }
        }
    }
}

// ─── Flujo completo ────────────────────────────────────────────────────────
async function flujoCompleto(m, conn, info, episodio, statusKey) {
    const updateStatus = async txt => {
        try {
            if (statusKey) await conn.sendMessage(m.chat, { text: txt, edit: statusKey })
            else await conn.sendMessage(m.chat, { text: txt }, { quoted: m })
        } catch (_) { await conn.sendMessage(m.chat, { text: txt }, { quoted: m }) }
    }

    await updateStatus(`🖼️ _Cargando portada de *${info.title}*..._`)
    await enviarPortada(m, conn, info, episodio,
        `📥 Preparando descarga del episodio *${episodio}*...`
    )
    await updateStatus(
        `⬇️ *Descargando:* ${info.title} — Ep. ${episodio}\n` +
        `_Espera, esto puede tardar..._`
    )

    const epUrl = `${BASE}/media/${info.slug}/${episodio}`
    await descargarYEnviar(m, conn, epUrl, info.title, episodio, updateStatus)
}

// ─── Handler principal ────────────────────────────────────────────────────
const handler = async (m, { conn, text, usedPrefix, command }) => {
    const isLatest = /hlatest|hentailatest/i.test(command)

    if (!text && !isLatest) {
        return m.reply(
            `🔞 *Uso:* ${usedPrefix}${command} <nombre> <episodio>\n\n` +
            `*Ejemplo:* ${usedPrefix}${command} overflow 1\n\n` +
            `💡 Usa \`${usedPrefix}hlatest\` para ver lo más nuevo.`
        )
    }

    let statusKey
    try {
        const sent = await conn.sendMessage(m.chat, { text: `🔍 _Buscando en HentaiLA..._` }, { quoted: m })
        statusKey = sent.key
    } catch (_) {
        const sent = await m.reply(`🔍 _Buscando en HentaiLA..._`)
        statusKey = sent?.key || sent
    }

    const updateStatus = async txt => {
        try {
            await conn.sendMessage(m.chat, { text: txt, edit: statusKey })
        } catch (_) {
            await conn.sendMessage(m.chat, { text: txt }, { quoted: m })
        }
    }

    try {
        // ── .hlatest ──────────────────────────────────────────────────────
        if (isLatest) {
            const ultimos = await obtenerUltimos()
            if (ultimos.length === 0)
                return updateStatus(`❌ No se pudieron obtener los últimos lanzamientos.`)

            const filas = ultimos.map((item) => ({
                rowId: `${usedPrefix}hdl ${item.slug} ${item.episode}`,
                title: item.title || item.slug.replace(/-/g, ' '),
                description: `Ep. ${item.episode}`,
            }))
            await enviarListaWA(
                conn, m.chat, m,
                '🔞 Últimos lanzamientos en HentaiLA',
                'Elige un título para ver portada y descargar:',
                '📋 Ver lanzamientos',
                'Recién subidos',
                filas
            )
            await updateStatus(`✅ _${ultimos.length} lanzamientos disponibles. Elige uno._`)
            return
        }

        // ── Parsear nombre y episodio ──────────────────────────────────────
        let query = text.trim()
        let episodio = null
        const words = query.split(' ')
        if (words.length > 1 && !isNaN(words[words.length - 1])) {
            episodio = words.pop()
            query = words.join(' ')
        }
        const cleanQuery = query.replace(/[?!¡¿]/g, '').trim()
        const slugIntent = cleanQuery.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

        // ── Intento directo por slug ───────────────────────────────────────
        let directOk = false
        try {
            const _html = await fetchText(`${BASE}/media/${slugIntent}`)
            directOk = _html && _html.length > 500 && !_html.includes('404')
        } catch (_) { }

        let info = null

        if (directOk) {
            await updateStatus(`✅ _Encontrado! Cargando info..._`)
            info = await obtenerInfoSerie(slugIntent)
        } else {
            await updateStatus(`🔎 _Buscando "${cleanQuery}"..._`)
            const results = await buscarHentaiLA(cleanQuery)

            if (results.length === 0)
                return updateStatus(
                    `❌ No se encontraron resultados para *"${cleanQuery}"*.\n\n` +
                    `💡 Intenta con el nombre en inglés o en romaji.\n` +
                    `Ej: \`.hdl overflow 1\` o \`.hdl seihou shouka\``
                )

            if (results.length === 1) {
                await updateStatus(`✅ _Encontrado! Cargando info..._`)
                info = await obtenerInfoSerie(results[0].slug)
            } else {
                const top = results.slice(0, 8)
                const filas = top.map((r) => ({
                    rowId: episodio ? `${usedPrefix}hdl ${r.slug} ${episodio}` : `${usedPrefix}hdl ${r.slug}`,
                    title: r.title || r.slug.replace(/-/g, ' '),
                }))
                await enviarListaWA(
                    conn, m.chat, m,
                    `🔞 Resultados para: "${cleanQuery}"`,
                    `Se encontraron ${top.length} títulos. Elige uno:`,
                    '📋 Ver opciones',
                    'Títulos disponibles',
                    filas
                )
                await updateStatus(`🔎 _${top.length} resultados. Elige un título._`)
                return
            }
        }

        // ── Sin episodio: mostrar portada + lista ──────────────────────────
        if (!episodio) {
            const epList = info.episodes.length > 0 ? info.episodes.slice(0, 20) : [1, 2, 3]
            const filasEp = epList.map(ep => ({
                rowId: `${usedPrefix}hdl ${info.slug} ${ep}`,
                title: `Episodio ${ep}`,
            }))
            await enviarListaWA(
                conn, m.chat, m,
                `🎬 ${info.title}`,
                `${info.desc}\n\n🎬 *Eps:* ${info.episodes.length > 0 ? info.episodes.length + ' (' + (info.episodes.length === 1 ? 'Episodio 1' : 'Eps 1-' + info.episodes[info.episodes.length - 1]) + ')' : '?'}\n🏷️ *Géneros:* ${info.generos.length > 0 ? info.generos.slice(0, 4).join(' · ') : 'N/A'}`,
                '📺 Elegir episodio',
                'Episodios disponibles',
                filasEp,
                info.cover || null
            )
            await updateStatus(`💬 Elige un episodio de *${info.title}*`)
            return
        }

        // ── Con episodio: flujo completo ────────────────────────────────────
        await flujoCompleto(m, conn, info, episodio, statusKey)

    } catch (err) {
        console.error('[HentaiDL]', err.message)
        await updateStatus(`❌ *Error:* ${err.message}`)
    }
}

handler.before = async function (m, { conn }) {
    // ── Respuesta de interactiveMessage (nativeFlow single_select) ──────────
    const nativeFlow = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage
    if (nativeFlow) {
        try {
            const params = JSON.parse(nativeFlow.paramsJson || '{}')
            const selectedId = params?.id || null
            if (selectedId) {
                const sessionKey = `${m.chat}|${m.sender}`
                const session = global.hdlSessions?.[sessionKey]

                if (!session || session.owner !== m.sender || Date.now() > session.expiry) {
                    console.log(`[HDL] Botón ignorado: no es el dueño de la sesión`)
                    return true
                }

                delete global.hdlSessions[sessionKey]

                const usedPrefix = selectedId[0]
                const [command, ...argParts] = selectedId.slice(1).trim().split(' ')
                const text = argParts.join(' ')
                try {
                    await handler.call(conn, m, { conn, text, usedPrefix, command })
                } catch (e) {
                    console.error('[HDL before] Error ejecutando handler:', e.message)
                }
                return true
            }
        } catch (_) { }
        return false
    }

    // ── Fallback: listResponseMessage o texto numérico ───────────────────────
    let rawInput = null
    const listResp = m.message?.listResponseMessage
    if (listResp) rawInput = listResp.singleSelectReply?.selectedRowId || null
    if (!rawInput) {
        if (!m.text || !/^\d+$/.test(m.text.trim())) return false
        rawInput = m.text.trim()
    }
    if (!/^\d+$/.test(rawInput)) return false

    const sel = global.hentaiSelection?.[m.sender]
    if (!sel) return false

    const input = parseInt(rawInput)
    const quotedText = m.quoted
        ? (m.quoted.text || m.quoted.body || m.quoted.caption || m.quoted.message?.conversation || '')
        : ''

    const esListaTitulos = /n.mero para ver portada|Últimos lanzamientos|Resultados para|n.mero del t.tulo/i.test(quotedText)
    const esListaEpisodios = /n.mero de episodio/i.test(quotedText)

    if (m.quoted && !esListaTitulos && !esListaEpisodios) {
        const quotedId = m.quoted?.key?.id || m.quoted?.id
        const esMsgGuardado = quotedId && sel.msgId && quotedId === sel.msgId
        if (!esMsgGuardado) return false
    }

    if (sel.type === 'selectTitle' || sel.type === 'latest') {
        const index = input - 1
        if (index < 0 || index >= sel.results.length) {
            await conn.sendMessage(m.chat, { text: `❌ Número inválido. Elige entre 1 y ${sel.results.length}.` }, { quoted: m })
            return true
        }
        delete global.hentaiSelection[m.sender]

        const item = sel.results[index]
        const episodio = item.episode || sel.episodio || null

        let statusKey
        try {
            const sent = await conn.sendMessage(m.chat, { text: `✅ _Cargando info de *${item.title || item.slug}*..._` }, { quoted: m })
            statusKey = sent.key
        } catch (_) { statusKey = null }

        const updateStatus = async txt => {
            try {
                if (statusKey) await conn.sendMessage(m.chat, { text: txt, edit: statusKey })
                else await conn.sendMessage(m.chat, { text: txt }, { quoted: m })
            } catch (_) { await conn.sendMessage(m.chat, { text: txt }, { quoted: m }) }
        }

        const info = await obtenerInfoSerie(item.slug).catch(() => null)
        if (!info) return updateStatus(`❌ No se pudo cargar la info de *${item.slug}*.`)

        if (!episodio) {
            const pfx = global.prefix || '.'
            const epList = info.episodes.length > 0 ? info.episodes.slice(0, 20) : [1, 2, 3]
            const filasEp = epList.map(ep => ({
                rowId: `${pfx}hdl ${info.slug} ${ep}`,
                title: `Episodio ${ep}`,
            }))
            await enviarListaWA(
                conn, m.chat, m,
                `🎬 ${info.title}`,
                `${info.desc}\n\n🎬 *Eps:* ${info.episodes.length > 0 ? info.episodes.length + ' (' + (info.episodes.length === 1 ? 'Episodio 1' : 'Eps 1-' + info.episodes[info.episodes.length - 1]) + ')' : '?'}\n🏷️ *Géneros:* ${info.generos.length > 0 ? info.generos.slice(0, 4).join(' · ') : 'N/A'}`,
                '📺 Elegir episodio',
                'Episodios disponibles',
                filasEp,
                info.cover || null
            )
            await updateStatus(`💬 Elige un episodio de *${info.title}*`)
        } else {
            await flujoCompleto(m, conn, info, episodio, statusKey)
        }
        return true
    }

    if (sel.type === 'selectEp') {
        const episodio = rawInput
        const { slug, title } = sel
        delete global.hentaiSelection[m.sender]

        let statusKey
        try {
            const sent = await conn.sendMessage(m.chat, { text: `⬇️ _Descargando episodio *${episodio}* de *${title}*..._` }, { quoted: m })
            statusKey = sent.key
        } catch (_) { statusKey = null }

        const info = await obtenerInfoSerie(slug).catch(() => ({
            slug, title, cover: null, desc: '', episodes: [], generos: []
        }))
        await flujoCompleto(m, conn, info, episodio, statusKey)
        return true
    }

    return false
}

handler.help = ['hdl <nombre> <episodio>']
handler.tags = ['nsfw']
handler.command = /^(hdl|hentaidl|hlatest|hentailatest)$/i

export default handler
