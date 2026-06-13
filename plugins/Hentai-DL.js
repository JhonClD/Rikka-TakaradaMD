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
import { performance } from 'perf_hooks'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import https from 'https'
import axios from 'axios'  // ✅ FIX: import estático en lugar de dinámico

// ─── Zyte API — bypasea Cloudflare automáticamente ───────────────────────
const ZYTE_API_KEY = '36511f73431e488aa79f6480bebaa021'
const ZYTE_ENDPOINT = 'https://api.zyte.com/v1/extract'

// ─── Cola de peticiones a hentaila.com (máx 1 a la vez) ──────────────────
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
    _processQueue()   // no awaited intencionalmente — solo encola la siguiente
}

async function _zyteRequest(url, binary = false) {
    const auth = Buffer.from(`${ZYTE_API_KEY}:`).toString('base64')
    const res = await nodeFetch(ZYTE_ENDPOINT, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, httpResponseBody: true }),
        signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`Zyte HTTP ${res.status}: ${errText.slice(0, 150)}`)
    }
    const json = await res.json()
    if (!json.httpResponseBody) throw new Error('Zyte: respuesta sin httpResponseBody')
    const buf = Buffer.from(json.httpResponseBody, 'base64')
    return binary ? buf : buf.toString('utf-8')
}

async function fetchViaZyte(url) {
    return queuedFetch(() => _zyteRequest(url, false))
}

async function fetchViaZyteBinary(url) {
    return queuedFetch(() => _zyteRequest(url, true))
}

// ✅ FIX: renombrado de "fetch" a "httpFetch" para evitar conflicto con
//         el fetch global de Node.js 18+ y con node-fetch importado arriba
function httpFetch(url, opts = {}) {
    const { timeout = 25000, ...rest } = opts
    return nodeFetch(url, { ...rest, signal: AbortSignal.timeout(timeout) })
}

const httpsAgent = new https.Agent({ keepAlive: true, maxFreeSockets: 10 })
global.activeDownloads  = global.activeDownloads  || new Map()
global.hentaiSelection  = global.hentaiSelection  || {}
global.hdlSessions      = global.hdlSessions      || {}   // { "chatId|sender": { owner, expiry } }

const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const BASE = 'https://hentaila.com'

// ─── Helper: lista interactiva de WhatsApp ────────────────────────────────
async function enviarListaWA(conn, chat, m, titulo, descripcion, boton, seccion, filas, coverUrl = null) {
    const sessionKey = `${chat}|${m.sender}`
    global.hdlSessions[sessionKey] = {
        owner: m.sender,
        chat,
        expiry: Date.now() + 5 * 60 * 1000,   // ✅ FIX: 5 min (antes era 1 min, muy corto)
    }
    // Limpiar sesiones expiradas
    const now = Date.now()
    for (const k of Object.keys(global.hdlSessions)) {
        if (global.hdlSessions[k].expiry < now) delete global.hdlSessions[k]
    }

    const device = getDevice(m.key.id)
    const isMobile = device !== 'desktop' && device !== 'web'

    if (isMobile) {
        try {
            let header
            if (coverUrl) {
                const messa = await prepareWAMessageMedia(
                    { image: { url: coverUrl } },
                    { upload: conn.waUploadToServer }
                )
                header = {
                    title: titulo,
                    hasMediaAttachment: true,
                    imageMessage: messa.imageMessage,
                }
            } else {
                header = { title: titulo, hasMediaAttachment: false }
            }

            const interactiveMessage = {
                body: { text: descripcion },
                footer: { text: global.wm || 'HentaiDL Bot' },
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

    // Fallback texto plano (desktop / web o si falla interactiveMessage)
    let txt = `✨ *${titulo}*\n_${descripcion}_\n\n`
    filas.forEach((r, i) => {
        txt += `*${i + 1}.* ${r.title}`
        if (r.description) txt += ` _(${r.description})_`
        txt += `\n`
    })
    txt += `\n_Responde con el número._`
    return conn.sendMessage(chat, { text: txt }, { quoted: m })
}

// ─── Fetch helpers ────────────────────────────────────────────────────────
async function fetchText(url) {
    if (url.includes('hentaila.com')) return fetchViaZyte(url)
    const res = await nodeFetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' },
        agent: httpsAgent,
        signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`fetchText HTTP ${res.status} → ${url}`)
    return res.text()
}

async function fetchBuffer(url) {
    if (url.includes('hentaila.com')) return fetchViaZyteBinary(url)
    const res = await nodeFetch(url, {
        headers: { 'User-Agent': UA },
        agent: httpsAgent,
        signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`fetchBuffer HTTP ${res.status}`)
    return res.buffer()
}

// ─── Info de la serie: portada, descripción, episodios ────────────────────
async function obtenerInfoSerie(slug) {
    const html = await fetchText(`${BASE}/media/${slug}`)
    const $ = cheerio.load(html)
    const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')

    // Título — og:title limpiado
    const ogTitle =
        $('meta[property="og:title"]').attr('content') ||
        $('title').text().trim() ||
        slug.replace(/-/g, ' ')
    const title = ogTitle.replace(/\s*[-–|]\s*(hentaila|hentai\s*la).*$/i, '').trim() || slug

    // Portada
    const cover =
        $('meta[property="og:image"]').attr('content') ||
        $('meta[name="og:image"]').attr('content') ||
        null

    // Descripción
    const desc =
        $('meta[property="og:description"]').attr('content') ||
        $('meta[name="description"]').attr('content') ||
        'Sin descripción.'

    // Episodios — varios métodos combinados
    const epSet = new Set()

    // Método 1: regex en HTML/JSON embebido
    const epRe = new RegExp(`/media/${slug}/(\\d+)`, 'g')
    let m
    while ((m = epRe.exec(decoded)) !== null) epSet.add(Number(m[1]))

    // Método 2: "episode": N en JSON de SvelteKit
    const jsonRe = /"episode":(\d+)/g
    while ((m = jsonRe.exec(decoded)) !== null) epSet.add(Number(m[1]))

    // Método 3: atributos href con número de episodio
    $(`a[href*="/media/${slug}/"]`).each((_, el) => {
        const match = $(el).attr('href')?.match(/\/(\d+)\/?$/)
        if (match) epSet.add(Number(match[1]))
    })

    const episodes = [...epSet].sort((a, b) => a - b)
    if (episodes.length === 0) episodes.push(1)   // Mínimo el ep 1

    // Géneros
    const generos = []
    $('a[href*="?genre="], a[href*="/genre/"], a[href*="genero"]').each((_, el) => {
        const text = $(el).text().trim()
        if (text && !generos.includes(text)) generos.push(text)
    })

    return { slug, title, cover, desc, episodes, generos }
}

// ─── Variaciones de slug ──────────────────────────────────────────────────
function generarSlugVariaciones(query) {
    const base = query.toLowerCase().trim()
    const variaciones = new Set()

    const full = base.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    variaciones.add(full)

    const primeras3 = base.split(' ').slice(0, 3).join('-').replace(/[^a-z0-9-]/g, '')
    variaciones.add(primeras3)

    const primeras2 = base.split(' ').slice(0, 2).join('-').replace(/[^a-z0-9-]/g, '')
    variaciones.add(primeras2)

    const primera = base.split(' ')[0].replace(/[^a-z0-9-]/g, '')
    variaciones.add(primera)

    const sinParticulas = base
        .replace(/\b(wa|no|ga|wo|ni|ha|de|mo|ka|the|and|for|with)\b/g, '')
        .replace(/\s+/g, ' ').trim()
    variaciones.add(sinParticulas.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))

    return [...variaciones].filter(v => v && v.length > 1)
}

// ─── Búsqueda vía scraping con Zyte ──────────────────────────────────────
// ✅ FIX: antes usaba fetch() directo (sin Zyte) → Cloudflare lo bloqueaba
async function buscarPorFetch(query) {
    const searchUrls = [
        `${BASE}/busqueda?q=${encodeURIComponent(query)}`,
        `${BASE}/?s=${encodeURIComponent(query)}`,
    ]

    for (const searchUrl of searchUrls) {
        try {
            const html = await fetchViaZyte(searchUrl)  // ✅ Zyte para Cloudflare
            const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')
            const results = []

            // Slugs en JSON embebido (SvelteKit)
            const re = /"slug":"([^"]+)"(?:[^}]{0,300}?"title":"([^"]+)")?/g
            let mt
            while ((mt = re.exec(decoded)) !== null) {
                const slug = mt[1], title = mt[2] || mt[1].replace(/-/g, ' ')
                if (slug && !results.find(r => r.slug === slug) && !slug.includes('/'))
                    results.push({ slug, title })
            }

            // Links /media/ en el HTML con Cheerio
            const $ = cheerio.load(html)
            $('a[href*="/media/"]').each((_, el) => {
                const href = $(el).attr('href') || ''
                const match = href.match(/\/media\/([^/\s"?]+)(?:\/\d+)?(?:\/|$)/)
                if (match) {
                    const slug = match[1]
                    if (slug && !results.find(r => r.slug === slug)) {
                        const title = $(el).text().trim() || slug.replace(/-/g, ' ')
                        results.push({ slug, title })
                    }
                }
            })

            if (results.length > 0) return results
        } catch (err) {
            console.error(`[buscarPorFetch] ${searchUrl}: ${err.message}`)
        }
    }
    return []
}

// ─── Búsqueda principal: slug directo → scraping ──────────────────────────
async function buscarHentaiLA(query) {
    // 1. Probar las 3 variaciones más probables en paralelo (queue las serializa automáticamente)
    const variaciones = generarSlugVariaciones(query).slice(0, 3)
    const checks = variaciones.map(slug =>
        fetchViaZyte(`${BASE}/media/${slug}`)
            .then(html => (html && html.length > 500) ? slug : null)
            .catch(() => null)
    )
    const directResults = (await Promise.all(checks)).filter(Boolean)
    if (directResults.length > 0) {
        console.log(`[SLUG] ✅ Encontrado directo: ${directResults[0]}`)
        return [{ slug: directResults[0], title: directResults[0].replace(/-/g, ' ') }]
    }

    // 2. Búsqueda vía scraping
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
    let mt
    while ((mt = re.exec(decoded)) !== null) {
        const slug = mt[1], episode = mt[2], title = mt[3] || mt[1].replace(/-/g, ' ')
        if (!results.find(r => r.slug === slug))
            results.push({ slug, title, episode })
    }

    // Fallback: buscar links /media/slug/N
    if (results.length === 0) {
        const $ = cheerio.load(html)
        $('a[href*="/media/"]').each((_, el) => {
            const href = $(el).attr('href') || ''
            const match = href.match(/\/media\/([^/]+)\/(\d+)/)
            if (match) {
                const [, slug, episode] = match
                if (!results.find(r => r.slug === slug))
                    results.push({ slug, title: slug.replace(/-/g, ' '), episode })
            }
        })
    }

    return results.slice(0, 10)
}

// ─── Links de descarga en /media/slug/ep ──────────────────────────────────
async function obtenerLinksDescarga(mediaUrl) {
    const html = await fetchText(mediaUrl)
    const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"').replace(/\\n/g, ' ')

    const mega       = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mega\.nz\/file\/[^\s"'<\\]*/g) || [])]
    const mediafire  = [...new Set(decoded.match(/https?:\/\/(?:www\.)?mediafire\.com\/file[^\s"'<\\]*/g) || [])]
    const fireload   = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*fireload\.com\/[^\s"'<\\]*/g) || [])]
    const fichier    = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*1fichier\.com\/\?[^\s"'<\\]*/g) || [])]
    const mp4upload  = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mp4upload\.com\/[^\s"'<\\]*/g) || [])]
    const yourupload = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*yourupload\.com\/[^\s"'<\\]*/g) || [])]
    const sendcm     = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*send\.cm\/[^\s"'<\\]*/g) || [])]
    const mixdrop    = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mixdrop\.(?:co|ch|to|ag)\/[^\s"'<\\]*/g) || [])]

    const allKnown = [...mega, ...mediafire, ...fireload, ...fichier, ...mp4upload, ...yourupload, ...sendcm, ...mixdrop]
    const otros = [...new Set(
        (decoded.match(/https?:\/\/[^\s"'<\\]{10,}/g) || []).filter(u =>
            !u.includes('hentaila.com') &&
            !allKnown.includes(u) &&
            /\.(mp4|mkv|avi|ts|m4v)(\?|$)/i.test(u)
        )
    )]

    return { mega, mediafire, fireload, fichier, mp4upload, yourupload, sendcm, mixdrop, otros }
}

// ─── Resolvers de servidores ──────────────────────────────────────────────
async function resolverMediafire(url) {
    const res  = await httpFetch(url, { headers: { 'User-Agent': UA }, timeout: 15000 })
    const html = await res.text()
    const $    = cheerio.load(html)
    const direct =
        $('#downloadButton').attr('href') ||
        $('a[href*="download.mediafire.com"]').first().attr('href') ||
        html.match(/href="(https:\/\/download\d*\.mediafire\.com[^"]+)"/)?.[1]
    if (!direct) throw new Error('MediaFire: link directo no encontrado')
    const name =
        $('[class*="filename"]').first().text().trim() ||
        url.split('/').pop().split('?')[0] ||
        'video.mp4'
    return { direct, name: name.trim() || 'video.mp4' }
}

async function resolverFireload(url) {
    const res  = await httpFetch(url, { headers: { 'User-Agent': UA }, timeout: 15000 })
    const html = await res.text()
    const direct =
        html.match(/href="(https?:\/\/[^"]*fireload\.com\/d\/[^"]+)"/)?.[1] ||
        html.match(/file:\s*"([^"]+)"/)?.[1] ||
        html.match(/source\s+src="([^"]+)"/)?.[1]
    if (!direct) throw new Error('FireLoad: link directo no encontrado')
    const name = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() || 'video.mp4'
    return { direct, name }
}

async function resolver1fichier(url) {
    const res  = await httpFetch('https://api.1fichier.com/v1/download/get_token.cgi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ url }),
        timeout: 15000,
    })
    const json = await res.json().catch(() => null)
    if (!json?.download_url) throw new Error('1Fichier: no se obtuvo download_url')
    return { direct: json.download_url, name: json.filename || 'video.mp4' }
}

async function resolverMp4upload(url) {
    const res  = await httpFetch(url, { headers: { 'User-Agent': UA }, timeout: 15000 })
    const html = await res.text()
    const direct =
        html.match(/file:\s*"([^"]+\.mp4[^"]*)"/)?.[1] ||
        html.match(/src:\s*"([^"]+\.mp4[^"]*)"/)?.[1] ||
        html.match(/source\s+src="([^"]+\.mp4[^"]*)"/)?.[1]
    if (!direct) throw new Error('MP4Upload: link directo no encontrado')
    const name = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() || 'video.mp4'
    return { direct, name }
}

// ─── Descarga genérica por URL directa ───────────────────────────────────
async function descargarDirecto(directUrl, fileName, tempPath, updateStatus, label) {
    let sizeBytes = 0, sizeH = '?'
    try {
        const head = await httpFetch(directUrl, { method: 'HEAD', headers: { 'User-Agent': UA }, timeout: 10000 })
        sizeBytes = parseInt(head.headers.get('content-length') || '0')
        if (sizeBytes) sizeH = (sizeBytes / 1048576).toFixed(2) + ' MB'
    } catch (_) {}

    await updateStatus(`📥 *${label}:* ${fileName}\n⚖️ *Peso:* ${sizeH}\n⏬ _Descargando..._`)

    const response = await axios({
        method: 'get',
        url: directUrl,
        responseType: 'stream',
        headers: { 'User-Agent': UA },
        httpsAgent,
        timeout: 180000,
    })

    let dld = 0
    response.data.on('data', chunk => {
        dld += chunk.length
        const pct = sizeBytes ? ((dld / sizeBytes) * 100).toFixed(1) + '%' : `${(dld / 1048576).toFixed(1)} MB`
        process.stdout.write(`\r[${label}] ${pct} descargado`)
    })

    await pipeline(response.data, fs.createWriteStream(tempPath))
    console.log(`\n[${label}] ✅ Completo`)
    return sizeH
}

// ─── Enviar portada con info (Msg 2) ─────────────────────────────────────
async function enviarPortada(m, conn, info, episodio = null, extra = '') {
    const { title, cover, desc, episodes, generos } = info
    const totalEps = episodes.length
    const lastEp   = episodes[totalEps - 1] || '?'
    const rango    = totalEps === 1 ? 'Episodio 1' : `Episodios 1 – ${lastEp}`
    const tags     = generos.length > 0 ? generos.slice(0, 6).join(' • ') : 'N/A'

    const caption =
        `🔞 *${title}*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📖 ${desc.slice(0, 300)}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🎬 *Episodios:* ${totalEps > 0 ? `${totalEps} (${rango})` : '?'}\n` +
        `🏷️ *Géneros:* ${tags}\n` +
        (extra ? `━━━━━━━━━━━━━━━━━━━━\n${extra}` : '')

    if (cover) {
        try {
            const imgBuf = await fetchBuffer(cover)
            await conn.sendMessage(m.chat, {
                image: imgBuf, caption, mimetype: 'image/jpeg',
            }, { quoted: m })
            return
        } catch (e) {
            console.error('[enviarPortada] Error imagen:', e.message)
        }
    }
    await conn.sendMessage(m.chat, { text: caption }, { quoted: m })
}

// ─── Descarga + envío del archivo (Msg 3) ─────────────────────────────────
async function descargarYEnviar(m, conn, mediaUrl, title, episodio, updateStatus) {
    const links = await obtenerLinksDescarga(mediaUrl)

    const totalLinks = Object.values(links).reduce((acc, arr) => acc + arr.length, 0)
    if (totalLinks === 0) {
        return updateStatus(
            `❌ No se encontraron links de descarga.\n🔗 Revisa manualmente: ${mediaUrl}`
        )
    }

    // Prioridad: hosts más rápidos primero, MEGA al final (más lento)
    const servidores = [
        ...links.mediafire.map(u  => ({ tipo: 'mediafire',  url: u })),
        ...links.fireload.map(u   => ({ tipo: 'fireload',   url: u })),
        ...links.fichier.map(u    => ({ tipo: '1fichier',   url: u })),
        ...links.mp4upload.map(u  => ({ tipo: 'mp4upload',  url: u })),
        ...links.sendcm.map(u     => ({ tipo: 'sendcm',     url: u })),
        ...links.yourupload.map(u => ({ tipo: 'yourupload', url: u })),
        ...links.mixdrop.map(u    => ({ tipo: 'mixdrop',    url: u })),
        ...links.otros.map(u      => ({ tipo: 'directo',    url: u })),
        ...links.mega.map(u       => ({ tipo: 'mega',       url: u })),
    ]

    let tempPath = null
    let fileName = `${title} - Ep ${episodio}.mp4`
    let sizeH    = '?'
    let exitoso  = false

    for (const srv of servidores) {
        const safeName = fileName.replace(/[/\\:*?"<>|]/g, '_')
        tempPath = path.join(tmpdir(), `hent_${Date.now()}_${safeName}`)

        try {
            await updateStatus(`🔄 *Intentando con ${srv.tipo.toUpperCase()}...*\n⏳ Ep. ${episodio} de *${title}*`)

            if (srv.tipo === 'mega') {
                const file = MegaFile.fromURL(srv.url)
                await file.loadAttributes()
                fileName      = file.name || fileName
                const sizeMB  = file.size || 0
                sizeH         = sizeMB ? (sizeMB / 1048576).toFixed(2) + ' MB' : '?'
                tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
                await updateStatus(`📥 *MEGA:* ${fileName}\n⚖️ *Peso:* ${sizeH}\n⏬ _Descargando..._`)
                const fileStream = file.download()
                let dld = 0
                fileStream.on('data', chunk => {
                    dld += chunk.length
                    if (sizeMB) process.stdout.write(`\r[MEGA] ${((dld / sizeMB) * 100).toFixed(1)}%`)
                })
                await pipeline(fileStream, fs.createWriteStream(tempPath))
                console.log('\n[MEGA] ✅ Completo')

            } else if (srv.tipo === 'mediafire') {
                const { direct, name } = await resolverMediafire(srv.url)
                fileName = name || fileName
                tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, 'MediaFire')

            } else if (srv.tipo === 'fireload') {
                const { direct, name } = await resolverFireload(srv.url)
                fileName = name || fileName
                tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, 'FireLoad')

            } else if (srv.tipo === '1fichier') {
                const { direct, name } = await resolver1fichier(srv.url)
                fileName = name || fileName
                tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, '1Fichier')

            } else if (srv.tipo === 'mp4upload') {
                const { direct, name } = await resolverMp4upload(srv.url)
                fileName = name || fileName
                tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, 'MP4Upload')

            } else if (srv.tipo === 'yourupload') {
                const res   = await httpFetch(srv.url, { headers: { 'User-Agent': UA }, timeout: 15000 })
                const html  = await res.text()
                const direct = html.match(/file:\s*"([^"]+)"/)?.[1] || html.match(/src="([^"]+\.mp4[^"]*)"/)?.[1]
                if (!direct) throw new Error('YourUpload: link directo no encontrado')
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, 'YourUpload')

            } else if (srv.tipo === 'sendcm') {
                const res   = await httpFetch(srv.url, { headers: { 'User-Agent': UA }, timeout: 15000 })
                const html  = await res.text()
                const direct =
                    html.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/)?.[1] ||
                    html.match(/action="(https?:\/\/[^"]+)"/)?.[1]
                if (!direct) throw new Error('Send.cm: link directo no encontrado')
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, 'Send.cm')

            } else {
                // URL directa genérica
                sizeH = await descargarDirecto(srv.url, fileName, tempPath, updateStatus, 'Directo')
            }

            // Verificar que el archivo no esté vacío
            const stat = fs.statSync(tempPath)
            if (stat.size < 1024) throw new Error('Archivo descargado está vacío o incompleto')

            exitoso = true
            break

        } catch (err) {
            console.error(`[${srv.tipo.toUpperCase()}] ❌ Falló: ${err.message}`)
            await updateStatus(`⚠️ *${srv.tipo.toUpperCase()} falló*, probando siguiente servidor...`)
            if (tempPath && fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath) } catch (_) {}
            }
            tempPath = null
        }
    }

    if (!exitoso || !tempPath) {
        return updateStatus(
            `❌ Todos los servidores fallaron para ep. ${episodio} de *${title}*.\n🔗 ${mediaUrl}`
        )
    }

    try {
        const stats = fs.statSync(tempPath)
        await updateStatus(
            `✅ *Descarga completa!*\n📤 _Subiendo a WhatsApp (${(stats.size / 1048576).toFixed(1)} MB)..._`
        )
        console.log(`[BOT] Subiendo ${fileName} (${(stats.size / 1048576).toFixed(1)} MB)...`)

        const epNum     = String(episodio).padStart(2, '0')
        const cleanTitle = title.replace(/[/\\:*?"<>|]/g, '').trim()
        const finalName  = `${epNum} ${cleanTitle}.mp4`

        // ✅ FIX PRINCIPAL: usar stream en lugar de { url: localPath }
        //    Baileys no acepta rutas locales en el campo "url" — debe ser
        //    un stream (o buffer), no una URL de archivo local
        await conn.sendMessage(m.chat, {
            document: { stream: fs.createReadStream(tempPath) },
            fileName: finalName,
            mimetype: 'video/mp4',
            caption:
                `🔞 *${title}* — Ep. ${episodio}\n` +
                `📁 ${finalName}\n` +
                `⚖️ ${sizeH}\n` +
                `🌐 HentaiLA`,
        }, { quoted: m })

        console.log('[BOT] ✨ ¡Enviado!')
        await updateStatus(`✅ *¡Enviado!* 🔞 ${title} — Ep. ${episodio}`)

    } catch (err) {
        console.error('[BOT] Error al enviar:', err.message)
        await updateStatus(`❌ Error al enviar el archivo: ${err.message}`)
        throw err
    } finally {
        if (tempPath && fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath) } catch (_) {}
        }
    }
}

// ─── Flujo completo: portada → descarga → envío ───────────────────────────
async function flujoCompleto(m, conn, info, episodio, statusKey) {
    const updateStatus = async txt => {
        try {
            if (statusKey) await conn.sendMessage(m.chat, { text: txt, edit: statusKey })
            else await conn.sendMessage(m.chat, { text: txt }, { quoted: m })
        } catch (_) {
            await conn.sendMessage(m.chat, { text: txt }, { quoted: m })
        }
    }

    await updateStatus(`🖼️ _Cargando portada de *${info.title}*..._`)
    await enviarPortada(m, conn, info, episodio,
        `📥 Preparando descarga del episodio *${episodio}*...`
    )
    await updateStatus(
        `⬇️ *Descargando:* ${info.title} — Ep. ${episodio}\n_Espera, esto puede tardar unos minutos..._`
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

            const filas = ultimos.map(item => ({
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
        if (words.length > 1 && /^\d+$/.test(words[words.length - 1])) {
            episodio = words.pop()
            query    = words.join(' ')
        }
        const cleanQuery = query.replace(/[?!¡¿]/g, '').trim()
        const slugIntent = cleanQuery.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

        let info     = null
        let directOk = false

        // ── Intento directo por slug ───────────────────────────────────────
        try {
            const html = await fetchViaZyte(`${BASE}/media/${slugIntent}`)
            directOk = !!(html && html.length > 500)
        } catch (_) {}

        if (directOk) {
            await updateStatus(`✅ _Encontrado! Cargando info..._`)
            info = await obtenerInfoSerie(slugIntent)
        } else {
            await updateStatus(`🔎 _Buscando "${cleanQuery}"..._`)
            const results = await buscarHentaiLA(cleanQuery)

            if (results.length === 0)
                return updateStatus(
                    `❌ No se encontraron resultados para *"${cleanQuery}"*.\n\n` +
                    `💡 Intenta con el nombre en inglés o solo las primeras palabras.\n` +
                    `Ej: \`.hdl overflow\` o \`.hdl overflow 1\``
                )

            if (results.length === 1) {
                await updateStatus(`✅ _Encontrado! Cargando info..._`)
                info = await obtenerInfoSerie(results[0].slug)
            } else {
                const top   = results.slice(0, 8)
                const filas = top.map(r => ({
                    rowId: episodio
                        ? `${usedPrefix}hdl ${r.slug} ${episodio}`
                        : `${usedPrefix}hdl ${r.slug}`,
                    title: r.title || r.slug.replace(/-/g, ' '),
                }))
                await enviarListaWA(
                    conn, m.chat, m,
                    `🔞 Resultados: "${cleanQuery}"`,
                    `Se encontraron ${top.length} títulos. Elige uno:`,
                    '📋 Ver opciones',
                    'Títulos disponibles',
                    filas
                )
                await updateStatus(`🔎 _${top.length} resultados. Elige un título._`)
                return
            }
        }

        // ── Sin episodio: portada + lista de episodios ─────────────────────
        if (!episodio) {
            const epList  = info.episodes.slice(0, 20)
            const filasEp = epList.map(ep => ({
                rowId: `${usedPrefix}hdl ${info.slug} ${ep}`,
                title: `Episodio ${ep}`,
            }))
            await enviarListaWA(
                conn, m.chat, m,
                `🎬 ${info.title}`,
                `${info.desc.slice(0, 250)}\n\n` +
                `🎬 *Eps:* ${info.episodes.length}\n` +
                `🏷️ *Géneros:* ${info.generos.slice(0, 4).join(' · ') || 'N/A'}`,
                '📺 Elegir episodio',
                'Episodios disponibles',
                filasEp,
                info.cover || null
            )
            await updateStatus(`💬 Elige un episodio de *${info.title}*`)
            return
        }

        // ── Con episodio: flujo completo ──────────────────────────────────
        await flujoCompleto(m, conn, info, episodio, statusKey)

    } catch (err) {
        console.error('[HentaiDL] Error:', err)
        await updateStatus(`❌ *Error:* ${err.message}\n\nRevisa la consola para más detalles.`)
    }
}

handler.before = async function (m, { conn }) {
    // ── Respuesta interactiva de nativeFlow (móvil) ───────────────────────
    const nativeFlow = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage
    if (nativeFlow) {
        try {
            const params     = JSON.parse(nativeFlow.paramsJson || '{}')
            const selectedId = params?.id || null
            if (selectedId) {
                const sessionKey = `${m.chat}|${m.sender}`
                const session    = global.hdlSessions?.[sessionKey]

                if (!session || session.owner !== m.sender || Date.now() > session.expiry) {
                    console.log(`[HDL] Sesión inválida para @${m.sender.split('@')[0]}`)
                    return true
                }
                delete global.hdlSessions[sessionKey]

                const usedPrefix = selectedId[0]
                const [command, ...argParts] = selectedId.slice(1).trim().split(' ')
                const text = argParts.join(' ')
                try {
                    await handler.call(conn, m, { conn, text, usedPrefix, command })
                } catch (e) {
                    console.error('[HDL before] Error nativeFlow handler:', e.message)
                }
                return true
            }
        } catch (e) {
            console.error('[HDL before] Error parseando nativeFlow:', e.message)
        }
        return false
    }

    // ── Respuesta de lista (listResponseMessage) ──────────────────────────
    const listResp = m.message?.listResponseMessage
    if (listResp) {
        const selectedId = listResp.singleSelectReply?.selectedRowId
        if (selectedId) {
            const sessionKey = `${m.chat}|${m.sender}`
            const session    = global.hdlSessions?.[sessionKey]
            if (!session || session.owner !== m.sender || Date.now() > session.expiry) return false
            delete global.hdlSessions[sessionKey]

            const usedPrefix = selectedId[0]
            const [command, ...argParts] = selectedId.slice(1).trim().split(' ')
            const text = argParts.join(' ')
            try {
                await handler.call(conn, m, { conn, text, usedPrefix, command })
            } catch (e) {
                console.error('[HDL before] Error listResp handler:', e.message)
            }
            return true
        }
    }

    // ── Fallback: número por texto plano (desktop / web) ─────────────────
    if (!m.text || !/^\d+$/.test(m.text.trim())) return false

    const sel = global.hentaiSelection?.[m.sender]
    if (!sel) return false

    const input = parseInt(m.text.trim())

    if (sel.type === 'selectTitle' || sel.type === 'latest') {
        const index = input - 1
        if (index < 0 || index >= sel.results.length) {
            await conn.sendMessage(m.chat, {
                text: `❌ Número inválido. Elige entre 1 y ${sel.results.length}.`
            }, { quoted: m })
            return true
        }
        delete global.hentaiSelection[m.sender]

        const item     = sel.results[index]
        const episodio = item.episode || sel.episodio || null

        let statusKey = null
        try {
            const sent = await conn.sendMessage(m.chat,
                { text: `✅ _Cargando *${item.title || item.slug}*..._` },
                { quoted: m }
            )
            statusKey = sent.key
        } catch (_) {}

        const updateStatus = async txt => {
            try {
                if (statusKey) await conn.sendMessage(m.chat, { text: txt, edit: statusKey })
                else await conn.sendMessage(m.chat, { text: txt }, { quoted: m })
            } catch (_) {
                await conn.sendMessage(m.chat, { text: txt }, { quoted: m })
            }
        }

        const info = await obtenerInfoSerie(item.slug).catch(() => null)
        if (!info) return updateStatus(`❌ No se pudo cargar la info de *${item.slug}*.`)

        if (!episodio) {
            const pfx     = global.prefix || '.'
            const epList  = info.episodes.slice(0, 20)
            const filasEp = epList.map(ep => ({
                rowId: `${pfx}hdl ${info.slug} ${ep}`,
                title: `Episodio ${ep}`,
            }))
            await enviarListaWA(
                conn, m.chat, m,
                `🎬 ${info.title}`,
                `${info.desc.slice(0, 250)}\n\n` +
                `🎬 *Eps:* ${info.episodes.length}\n` +
                `🏷️ *Géneros:* ${info.generos.slice(0, 4).join(' · ') || 'N/A'}`,
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
        const episodio = m.text.trim()
        const { slug, title } = sel
        delete global.hentaiSelection[m.sender]

        let statusKey = null
        try {
            const sent = await conn.sendMessage(m.chat,
                { text: `⬇️ _Descargando ep. *${episodio}* de *${title}*..._` },
                { quoted: m }
            )
            statusKey = sent.key
        } catch (_) {}

        const info = await obtenerInfoSerie(slug).catch(() => ({
            slug, title, cover: null, desc: '', episodes: [], generos: []
        }))
        await flujoCompleto(m, conn, info, episodio, statusKey)
        return true
    }

    return false
}

handler.help    = ['hdl <nombre> <episodio>']
handler.tags    = ['nsfw']
handler.command = /^(hdl|hentaidl|hlatest|hentailatest)$/i

export default handler
