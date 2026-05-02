// ╔══════════════════════════════════════════════════════════════╗
// ║          HENTAI-DL.js — HentaiLA Downloader v2              ║
// ║  Mejoras vs v1:                                             ║
// ║  • Parser basado en HTML real renderizado (cheerio preciso) ║
// ║  • fetchWithBypass: Android → AndroidTV+Cookies → Proxies  ║
// ║  • Búsqueda: slug directo → cdn backdrops → HTML parse      ║
// ║  • Sin Puppeteer para búsquedas (solo fallback descarga)    ║
// ║  • Extrae cdn.hentaila.com/backdrops para covers            ║
// ╚══════════════════════════════════════════════════════════════╝

import fetch        from 'node-fetch'
import * as cheerio from 'cheerio'
import { File as MegaFile } from 'megajs'
import { pipeline }  from 'stream/promises'
import { PassThrough } from 'stream'
import { performance } from 'perf_hooks'
import { prepareWAMessageMedia, generateWAMessageFromContent, getDevice } from '@whiskeysockets/baileys'
import https   from 'https'
import fs      from 'fs'
import path    from 'path'
import { tmpdir } from 'os'

// ─── Constantes ──────────────────────────────────────────────────────────────
const BASE         = 'https://hentaila.com'
const CDN          = 'https://cdn.hentaila.com'
const UA_ANDROID   = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
const UA_ANDROIDTV = 'Crunchyroll/ANDROIDTV/3.59.0_22338 (Android 13.0; en-US; TCL-S5400AF Build/TP1A.220624.014)'
const UA_DESKTOP   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const HEADERS_ANDROID = {
    'User-Agent':                UA_ANDROID,
    'Accept':                    'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language':           'es-419,es;q=0.9,en;q=0.8',
    'Accept-Encoding':           'gzip, deflate, br',
    'Connection':                'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'none',
    'Sec-Fetch-User':            '?1',
}

const httpsAgent = new https.Agent({ keepAlive: true, maxFreeSockets: 10 })

global.activeDownloads  = global.activeDownloads  || new Map()
global.hentaiSelection  = global.hentaiSelection  || {}
global.hdlSessions      = global.hdlSessions      || {}

// ─── Cookie cache (estilo CR preLogin) ───────────────────────────────────────
let _cookieCache = {}
async function preLogin(origin = BASE) {
    const host = new URL(origin).hostname
    const cached = _cookieCache[host]
    if (cached && Date.now() - cached.ts < 20 * 60 * 1000) return cached.cookies
    try {
        const res = await fetch(origin, {
            headers: { 'User-Agent': UA_ANDROIDTV, 'Accept': 'text/html,*/*' },
            redirect: 'follow', timeout: 15000,
        })
        const raw = res.headers.raw()['set-cookie'] || []
        const cookies = raw.map(c => c.split(';')[0]).join('; ')
        _cookieCache[host] = { cookies, ts: Date.now() }
        return cookies
    } catch { return '' }
}

// ─── Detectar CF en body ──────────────────────────────────────────────────────
function isCFBlock(text) {
    return /cloudflare|cf-ray|just a moment|checking your browser|sorry.*blocked|you have been blocked|enable cookies.*cf/i.test(text.slice(0, 4096))
}

// ─── fetchWithBypass: 6 estrategias en cascada ───────────────────────────────
async function fetchText(url, referer = BASE) {
    const strategies = [
        // 1. Android Chrome directo
        async () => {
            const r = await fetch(url, { headers: { ...HEADERS_ANDROID, Referer: referer }, redirect: 'follow', timeout: 20000, agent: httpsAgent })
            return r.text()
        },
        // 2. AndroidTV + Cookies reales (CR-style preLogin)
        async () => {
            const cookies = await preLogin(new URL(url).origin)
            const r = await fetch(url, {
                headers: { 'User-Agent': UA_ANDROIDTV, 'Accept': 'text/html,*/*', 'Accept-Language': 'es,en;q=0.8', 'Cookie': cookies, 'Referer': BASE },
                redirect: 'follow', timeout: 20000, agent: httpsAgent,
            })
            return r.text()
        },
        // 3. Desktop + Google Referer
        async () => {
            const r = await fetch(url, {
                headers: { 'User-Agent': UA_DESKTOP, 'Accept': 'text/html,*/*', 'Referer': 'https://www.google.com/', 'Accept-Language': 'es,en;q=0.8' },
                redirect: 'follow', timeout: 20000, agent: httpsAgent,
            })
            return r.text()
        },
        // 4. AllOrigins proxy
        async () => {
            const r = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, {
                headers: { 'User-Agent': UA_ANDROID }, timeout: 25000,
            })
            if (!r.ok) throw new Error(`allorigins ${r.status}`)
            return r.text()
        },
        // 5. corsproxy.io
        async () => {
            const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, {
                headers: { 'User-Agent': UA_ANDROIDTV }, timeout: 25000,
            })
            if (!r.ok) throw new Error(`corsproxy ${r.status}`)
            return r.text()
        },
        // 6. thingproxy
        async () => {
            const r = await fetch(`https://thingproxy.freeboard.io/fetch/${url}`, {
                headers: { 'User-Agent': UA_ANDROID }, timeout: 25000,
            })
            if (!r.ok) throw new Error(`thingproxy ${r.status}`)
            return r.text()
        },
    ]

    let lastErr
    for (const fn of strategies) {
        try {
            const text = await fn()
            if (isCFBlock(text)) { lastErr = new Error('CF bloqueó'); continue }
            return text
        } catch (e) { lastErr = e }
    }
    throw lastErr || new Error('Todas las estrategias fallaron')
}

async function fetchBuffer(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA_ANDROID }, agent: httpsAgent, timeout: 20000 })
    return r.buffer()
}

// ─── Parser HTML con cheerio (basado en estructura real de HentaiLA) ─────────

// Parsea la página /media/slug — ya viene con todo renderizado
function parseSeriePage(html, slug) {
    const $ = cheerio.load(html)

    // Título: <h1 class="...text-lead">Título</h1>
    const title = $('h1.text-lead, h1.font-semibold').first().text().trim()
        || $('meta[property="og:title"]').attr('content')?.replace(/\s*[-–|].*$/, '').trim()
        || slug.replace(/-/g, ' ')

    // Descripción: <div class="entry ..."><p>...</p></div>
    const desc = $('.entry p').first().text().trim()
        || $('meta[property="og:description"]').attr('content')?.trim()
        || 'Sin descripción.'

    // Cover: cdn.hentaila.com/backdrops/ID.jpg desde og:image o img src
    const ogImg = $('meta[property="og:image"]').attr('content') || ''
    const cdnImg = $('img[src*="cdn.hentaila.com"]').first().attr('src') || ''
    const cover = ogImg.includes('cdn.hentaila.com') ? ogImg
        : cdnImg || ogImg || null

    // Géneros: <a href="/catalogo?genre=...">nombre</a>
    const generos = []
    $('a[href*="?genre="]').each((_, el) => {
        const g = $(el).text().trim()
        if (g && !generos.includes(g)) generos.push(g)
    })

    // Episodios: links /media/slug/N
    const epSet = new Set()
    $(`a[href^="/media/${slug}/"]`).each((_, el) => {
        const m = $(el).attr('href').match(/\/media\/[^/]+\/(\d+)/)
        if (m) epSet.add(Number(m[1]))
    })
    // Fallback regex en el HTML completo
    const epRe = new RegExp(`/media/${slug}/(\\d+)`, 'g')
    let m
    while ((m = epRe.exec(html)) !== null) epSet.add(Number(m[1]))

    const episodes = [...epSet].sort((a, b) => a - b)

    // Tipo (OVA, Serie, etc)
    const tipo = $('div.text-sm span').first().text().trim() || 'OVA'

    return { slug, title, cover, desc, episodes, generos, tipo }
}

// Parsea página de búsqueda /catalogo?search=query o /hub
function parseSearchPage(html) {
    const $ = cheerio.load(html)
    const results = []

    // Patrón principal: <a href="/media/slug">
    $('a[href^="/media/"]').each((_, el) => {
        const href = $(el).attr('href') || ''
        const parts = href.split('/media/')[1]?.split('/')
        if (!parts) return
        const slug = parts[0]
        if (!slug || /^\d+$/.test(slug) || results.find(r => r.slug === slug)) return
        // Buscar título en el elemento o sus hijos
        const titleEl = $(el).find('h1, h2, h3, .text-lead, [class*="title"]').first()
        const title = titleEl.text().trim() || slug.replace(/-/g, ' ')
        results.push({ slug, title })
    })

    // Fallback: JSON embebido en SvelteKit (__data.json inline)
    if (results.length === 0) {
        const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')
        const re = /"slug":"([^"]+)"(?:[^}]{0,300}?"title":"([^"]+)")?/g
        let m
        while ((m = re.exec(decoded)) !== null) {
            const slug = m[1], title = m[2] || m[1].replace(/-/g, ' ')
            if (slug && !results.find(r => r.slug === slug) && !slug.includes('/'))
                results.push({ slug, title })
        }
    }

    return results
}

// Parsea página de últimos episodios /hub
function parseLatestPage(html) {
    const $ = cheerio.load(html)
    const results = []

    // Artículos del hero/slider: <article>...<a href="/media/slug">
    $('article').each((_, el) => {
        const link = $(el).find('a[href^="/media/"]').last()
        const href = link.attr('href') || ''
        const slug = href.split('/media/')[1]?.split('/')[0]
        if (!slug || /^\d+$/.test(slug) || results.find(r => r.slug === slug)) return
        const title = $(el).find('h1.text-lead, h1.font-semibold').first().text().trim()
            || slug.replace(/-/g, ' ')
        // Buscar cover: cdn.hentaila.com/backdrops/
        const imgSrc = $(el).find('img[src*="cdn.hentaila.com"]').attr('src') || null
        // Géneros
        const generos = []
        $(el).find('a[href*="?genre="]').each((_, g) => generos.push($(g).text().trim()))
        results.push({ slug, title, cover: imgSrc, generos })
    })

    // Fallback: links de episodios recientes /media/slug/N
    if (results.length === 0) {
        const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')
        const re = /"slug":"([^"]+)"[^}]{0,200}?"episode":(\d+)(?:[^}]{0,200}?"title":"([^"]+)")?/g
        let m
        while ((m = re.exec(decoded)) !== null) {
            const slug = m[1], episode = m[2], title = m[3] || m[1].replace(/-/g, ' ')
            if (!results.find(r => r.slug === slug))
                results.push({ slug, title, episode, cover: null, generos: [] })
        }
    }

    return results.slice(0, 12)
}

// ─── Obtener info de serie ────────────────────────────────────────────────────
async function obtenerInfoSerie(slug) {
    const html = await fetchText(`${BASE}/media/${slug}`)
    return parseSeriePage(html, slug)
}

// ─── Búsqueda principal ───────────────────────────────────────────────────────
function generarSlugs(query) {
    const base = query.toLowerCase().trim()
    const slugs = new Set()
    const toSlug = s => s.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    slugs.add(toSlug(base))
    // Sin stop words
    const noStop = base.split(' ').filter(w => w.length > 2 && !['the','and','for','una','los','las','del','de','la','el'].includes(w))
    slugs.add(noStop.join('-').replace(/[^a-z0-9-]/g, ''))
    // Primeras 3, 2, 1 palabras
    for (let n = 3; n >= 1; n--)
        slugs.add(base.split(' ').slice(0, n).join('-').replace(/[^a-z0-9-]/g, ''))
    // Sin partículas japonesas
    const noJp = base.replace(/\b(wa|no|ga|wo|ni|ha|de|mo|ka)\b/g, '').trim()
    slugs.add(toSlug(noJp))
    return [...slugs].filter(s => s && s.length > 1)
}

async function buscarHentaiLA(query) {
    // 1. Slug directo (HEAD request, muy rápido)
    for (const slug of generarSlugs(query)) {
        try {
            const r = await fetch(`${BASE}/media/${slug}`, {
                method: 'HEAD', headers: { 'User-Agent': UA_ANDROID }, timeout: 6000, agent: httpsAgent,
            })
            if (r.status === 200) return [{ slug, title: slug.replace(/-/g, ' ') }]
        } catch { continue }
    }

    // 2. Verificar cover en CDN (si el slug existe habrá un backdrop)
    for (const slug of generarSlugs(query)) {
        try {
            // HentaiLA usa IDs numéricos para backdrops, pero a veces el slug en meta og:image
            // Intentar GET a la página directamente con fetchText
            const html = await fetchText(`${BASE}/media/${slug}`)
            if (html.includes(`/media/${slug}`) && !isCFBlock(html))
                return [{ slug, title: slug.replace(/-/g, ' ') }]
        } catch { continue }
    }

    // 3. Búsqueda por catálogo (fetchText con bypass)
    try {
        const html = await fetchText(`${BASE}/catalogo?search=${encodeURIComponent(query)}`)
        const results = parseSearchPage(html)
        if (results.length > 0) return results
    } catch { /* continuar */ }

    // 4. Búsqueda por hub (página principal renderizada)
    try {
        const html = await fetchText(`${BASE}/hub`)
        const results = parseLatestPage(html).filter(r =>
            r.title.toLowerCase().includes(query.toLowerCase().split(' ')[0]) ||
            r.slug.includes(query.toLowerCase().split(' ')[0])
        )
        if (results.length > 0) return results
    } catch { /* continuar */ }

    return []
}

async function obtenerUltimos() {
    const html = await fetchText(`${BASE}/hub`)
    return parseLatestPage(html)
}

// ─── Links de descarga ────────────────────────────────────────────────────────
async function obtenerLinksDescarga(mediaUrl) {
    const html  = await fetchText(mediaUrl)
    const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')

    const mega      = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mega\.nz\/file\/[^\s"'<\\]*/g)     || [])]
    const mediafire = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mediafire\.com\/file[^\s"'<\\]*/g) || [])]
    const fireload  = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*fireload\.com\/[^\s"'<\\]*/g)      || [])]
    const fichier   = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*1fichier\.com\/\?[^\s"'<\\]*/g)    || [])]
    const mp4upload = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mp4upload\.com\/[^\s"'<\\]*/g)     || [])]
    const yourupload= [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*yourupload\.com\/[^\s"'<\\]*/g)    || [])]
    const otros     = [...new Set(
        (decoded.match(/https?:\/\/[^\s"'<\\]{10,}/g) || []).filter(u =>
            !u.includes(BASE) && !mega.includes(u) && !mediafire.includes(u) &&
            !fireload.includes(u) && !fichier.includes(u) && !mp4upload.includes(u) &&
            !yourupload.includes(u) && /\.(mp4|mkv|avi|ts|m4v)(\?|$)/i.test(u)
        )
    )]

    return { mega, mediafire, fireload, fichier, mp4upload, yourupload, otros }
}

// ─── Resolvers de servicios ───────────────────────────────────────────────────
async function resolverMediafire(url) {
    const html  = await fetchText(url, url)
    const $     = cheerio.load(html)
    const direct = $('#downloadButton').attr('href')
        || html.match(/href="(https:\/\/download\d+\.mediafire\.com[^"]+)"/)?.[1]
    const name   = $('.promoDownloadName').first().attr('title')
        || $('.filename').first().text().trim()
        || url.split('/').pop().split('?')[0] || 'video.mp4'
    return { direct: direct || null, name: name.trim() }
}

async function resolverFireload(url) {
    const html  = await fetchText(url, url)
    const direct = html.match(/href="(https?:\/\/[^"]*fireload\.com\/d\/[^"]+)"/)?.[1]
        || html.match(/file:\s*"([^"]+)"/)?.[1]
        || html.match(/source\s+src="([^"]+)"/)?.[1]
    const name   = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() || 'video.mp4'
    return { direct: direct || null, name }
}

async function resolver1fichier(url) {
    const r    = await fetch('https://api.1fichier.com/v1/download/get_token.cgi', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA_ANDROID },
        body: JSON.stringify({ url }), timeout: 15000,
    })
    const json = await r.json().catch(() => null)
    return { direct: json?.download_url || null, name: json?.filename || 'video.mp4' }
}

async function resolverMp4upload(url) {
    const html  = await fetchText(url, url)
    const direct = html.match(/file:\s*"([^"]+\.mp4[^"]*)"/)?.[1]
        || html.match(/src:\s*"([^"]+\.mp4[^"]*)"/)?.[1]
        || html.match(/source\s+src="([^"]+)"/)?.[1]
    const name   = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() || 'video.mp4'
    return { direct: direct || null, name }
}

// ─── Descarga directa con progreso ───────────────────────────────────────────
async function descargarDirecto(directUrl, fileName, tempPath, updateStatus, label) {
    const head = await fetch(directUrl, { method: 'HEAD', headers: { 'User-Agent': UA_ANDROID }, timeout: 10000 })
    const sizeBytes = parseInt(head.headers.get('content-length') || '0')
    const sizeH = sizeBytes ? (sizeBytes / 1048576).toFixed(2) + ' MB' : '?'
    await updateStatus(`📥 *${label}:* ${fileName}\n⚖️ *Peso:* ${sizeH}\n⏬ _Descargando..._`)
    const { default: axios } = await import('axios')
    const response = await axios({ method: 'get', url: directUrl, responseType: 'stream', headers: { 'User-Agent': UA_ANDROID }, httpsAgent })
    let dld = 0
    response.data.on('data', chunk => {
        dld += chunk.length
        process.stdout.write(`\r[${label}] ${sizeBytes ? ((dld / sizeBytes) * 100).toFixed(1) : '?'}% (${(dld / 1048576).toFixed(1)} MB)`)
    })
    await pipeline(response.data, fs.createWriteStream(tempPath))
    console.log(`\n[${label}] ✅ Completo`)
    return sizeH
}

// ─── Enviar lista interactiva ─────────────────────────────────────────────────
async function enviarListaWA(conn, chat, m, titulo, descripcion, boton, seccion, filas, coverUrl = null) {
    const sessionKey = `${chat}|${m.sender}`
    global.hdlSessions[sessionKey] = { owner: m.sender, chat, expiry: Date.now() + 60000 }
    const now = Date.now()
    for (const k of Object.keys(global.hdlSessions)) {
        if (global.hdlSessions[k].expiry < now) delete global.hdlSessions[k]
    }

    const device   = getDevice(m.key.id)
    const isMobile = device !== 'desktop' && device !== 'web'

    if (isMobile) {
        try {
            let header
            if (coverUrl) {
                const media = await prepareWAMessageMedia({ image: { url: coverUrl } }, { upload: conn.waUploadToServer })
                header = { title: titulo, hasMediaAttachment: true, imageMessage: media.imageMessage }
            } else {
                header = { title: titulo, hasMediaAttachment: false }
            }
            const interactiveMessage = {
                body: { text: descripcion },
                footer: { text: global.wm || 'Rikka Bot' },
                header,
                nativeFlowMessage: {
                    buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({
                        title: boton,
                        sections: [{ title: seccion, highlight_label: '', rows: filas.map(r => ({
                            header: r.title, title: r.subtitle || r.title,
                            description: r.description || '', id: r.rowId,
                        })) }],
                    }) }],
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
        } catch (err) { console.error('[interactiveMessage]', err.message) }
    }

    // Fallback texto
    let txt = `✨ *${titulo}*\n_${descripcion}_\n\n`
    filas.forEach(r => {
        txt += `• *${r.rowId}* — ${r.title}`
        if (r.description) txt += ` _(${r.description})_`
        txt += '\n'
    })
    txt += '\n_Responde con el número._'
    return conn.sendMessage(chat, { text: txt }, { quoted: m })
}

// ─── Mostrar portada con info ─────────────────────────────────────────────────
async function enviarPortada(m, conn, info, extra = '') {
    const { title, cover, desc, episodes, generos, tipo } = info
    const total  = episodes.length
    const lastEp = episodes[total - 1] || '?'
    const rango  = total === 1 ? 'Episodio 1' : `Eps 1–${lastEp}`
    const tags   = generos.slice(0, 6).join(' • ') || 'N/A'
    const caption =
        `🔞 *${title}*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📖 ${desc}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📺 *Tipo:* ${tipo}\n` +
        `🎬 *Episodios:* ${total > 0 ? `${total} (${rango})` : '?'}\n` +
        `🏷️ *Géneros:* ${tags}\n` +
        (extra ? `━━━━━━━━━━━━━━━━━━━━\n${extra}` : '')

    if (cover) {
        try {
            const imgBuf = await fetchBuffer(cover)
            return conn.sendMessage(m.chat, { image: imgBuf, caption, mimetype: 'image/jpeg' }, { quoted: m })
        } catch { /* fallback texto */ }
    }
    return conn.sendMessage(m.chat, { text: caption }, { quoted: m })
}

// ─── Descargar y enviar episodio ──────────────────────────────────────────────
async function descargarYEnviar(m, conn, mediaUrl, title, episodio, updateStatus) {
    const links = await obtenerLinksDescarga(mediaUrl)
    const total = links.mega.length + links.mediafire.length + links.fireload.length +
                  links.fichier.length + links.mp4upload.length + links.yourupload.length + links.otros.length

    if (total === 0)
        return updateStatus(`❌ No se encontraron links de descarga.\n🔗 ${mediaUrl}`)

    const servidores = [
        ...links.mega.map(u => ({ tipo: 'mega', url: u })),
        ...links.mediafire.map(u => ({ tipo: 'mediafire', url: u })),
        ...links.fireload.map(u => ({ tipo: 'fireload', url: u })),
        ...links.fichier.map(u => ({ tipo: '1fichier', url: u })),
        ...links.mp4upload.map(u => ({ tipo: 'mp4upload', url: u })),
        ...links.yourupload.map(u => ({ tipo: 'yourupload', url: u })),
        ...links.otros.map(u => ({ tipo: 'directo', url: u })),
    ]

    let tempPath = null, fileName = `${title} - Ep ${episodio}.mp4`, sizeH = '?', exitoso = false

    for (const srv of servidores) {
        tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
        try {
            await updateStatus(`🔄 *${srv.tipo.toUpperCase()}...*\n⏳ Ep. ${episodio} de *${title}*`)

            if (srv.tipo === 'mega') {
                const file = MegaFile.fromURL(srv.url)
                await file.loadAttributes()
                fileName = file.name || fileName
                sizeH    = (file.size / 1048576).toFixed(2) + ' MB'
                tempPath = path.join(tmpdir(), `hent_${Date.now()}_${fileName.replace(/[/\\:*?"<>|]/g, '_')}`)
                await updateStatus(`📥 *MEGA:* ${fileName}\n⚖️ ${sizeH}\n⏬ _Descargando..._`)
                const stream = file.download()
                let dld = 0
                stream.on('data', c => { dld += c.length; process.stdout.write(`\r[MEGA] ${((dld/file.size)*100).toFixed(1)}%`) })
                await pipeline(stream, fs.createWriteStream(tempPath))
                console.log('\n[MEGA] ✅')

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
                const html   = await fetchText(srv.url, srv.url)
                const direct = html.match(/file:\s*"([^"]+)"/)?.[1] || html.match(/src="([^"]+\.mp4[^"]*)"/)?.[1]
                if (!direct) throw new Error('No se pudo resolver YourUpload')
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, 'YourUpload')

            } else {
                sizeH = await descargarDirecto(srv.url, fileName, tempPath, updateStatus, 'Directo')
            }

            exitoso = true
            break

        } catch (err) {
            console.error(`[${srv.tipo.toUpperCase()}] ❌ ${err.message}`)
            await updateStatus(`⚠️ *${srv.tipo.toUpperCase()} falló*, probando siguiente...`)
            if (tempPath && fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath) } catch { }
            tempPath = null
        }
    }

    if (!exitoso || !tempPath)
        return updateStatus(`❌ Todos los servidores fallaron para ep. ${episodio} de *${title}*.\n🔗 ${mediaUrl}`)

    try {
        await updateStatus(`✅ *Descarga completa!*\n📤 _Enviando..._`)
        const stats   = fs.statSync(tempPath)
        const ps      = new PassThrough()
        let uploaded  = 0, start = performance.now()
        ps.on('data', c => {
            uploaded += c.length
            const speed = (uploaded / 1048576 / Math.max((performance.now() - start) / 1000, 0.1)).toFixed(2)
            process.stdout.write(`\r[WA] ⬆️ ${((uploaded/stats.size)*100).toFixed(1)}% | ${speed} MB/s`)
        })
        fs.createReadStream(tempPath).pipe(ps)

        const epNum    = String(episodio).padStart(2, '0')
        const finalName = `${epNum} ${title.replace(/[/\\:*?"<>|]/g, '').trim()}.mp4`

        await conn.sendMessage(m.chat, {
            document: { url: tempPath }, fileName: finalName, mimetype: 'video/mp4',
            caption: `🔞 *${title}* — Ep. ${episodio}\n📁 ${finalName}\n⚖️ ${sizeH}\n🌐 HentaiLA`,
        }, { quoted: m })

        console.log('\n[BOT] ✨ Listo!')
        await updateStatus(`✅ *¡Enviado!* 🔞 ${title} — Ep. ${episodio}`)
    } finally {
        if (tempPath && fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath) } catch { }
    }
}

// ─── Flujo completo ───────────────────────────────────────────────────────────
async function flujoCompleto(m, conn, info, episodio, statusKey) {
    const updateStatus = async txt => {
        try { await conn.sendMessage(m.chat, { text: txt, edit: statusKey }) }
        catch { await conn.sendMessage(m.chat, { text: txt }, { quoted: m }) }
    }
    await updateStatus(`🖼️ _Cargando portada de *${info.title}*..._`)
    await enviarPortada(m, conn, info, `📥 Preparando descarga del episodio *${episodio}*...`)
    await updateStatus(`⬇️ *Descargando:* ${info.title} — Ep. ${episodio}\n_Espera, esto puede tardar..._`)
    await descargarYEnviar(m, conn, `${BASE}/media/${info.slug}/${episodio}`, info.title, episodio, updateStatus)
}

// ─── Handler principal ────────────────────────────────────────────────────────
const handler = async (m, { conn, text, usedPrefix, command }) => {
    const isLatest = /hlatest|hentailatest/i.test(command)

    if (!text && !isLatest)
        return m.reply(`🔞 *Uso:* ${usedPrefix}${command} <nombre> <episodio>\n\n*Ejemplo:* ${usedPrefix}${command} overflow 1\n\n💡 Usa \`${usedPrefix}hlatest\` para ver lo más nuevo.`)

    let statusKey
    try {
        const sent = await conn.sendMessage(m.chat, { text: `🔍 _Buscando en HentaiLA..._` }, { quoted: m })
        statusKey = sent.key
    } catch { statusKey = null }

    const updateStatus = async txt => {
        try { if (statusKey) await conn.sendMessage(m.chat, { text: txt, edit: statusKey }) }
        catch { await conn.sendMessage(m.chat, { text: txt }, { quoted: m }) }
    }

    try {
        // ── .hlatest ───────────────────────────────────────────────────────
        if (isLatest) {
            const ultimos = await obtenerUltimos()
            if (!ultimos.length) return updateStatus(`❌ No se pudieron obtener los últimos lanzamientos.`)

            const filas = ultimos.map(item => ({
                rowId: `${usedPrefix}hdl ${item.slug}`,
                title: item.title,
                description: item.episode ? `Ep. ${item.episode}` : (item.generos?.[0] || ''),
            }))
            await enviarListaWA(conn, m.chat, m, '🔞 Últimos en HentaiLA', 'Elige un título:', '📋 Ver', 'Recién subidos', filas)
            await updateStatus(`✅ _${ultimos.length} títulos disponibles. Elige uno._`)
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
        const cleanQuery  = query.replace(/[?!¡¿]/g, '').trim()
        const slugIntent  = cleanQuery.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

        // ── Intento directo ────────────────────────────────────────────────
        const direct = await fetch(`${BASE}/media/${slugIntent}`, {
            method: 'HEAD', headers: { 'User-Agent': UA_ANDROID }, timeout: 8000, agent: httpsAgent,
        }).catch(() => ({ status: 0 }))

        let info = null

        if (direct.status === 200) {
            await updateStatus(`✅ _Encontrado! Cargando info..._`)
            info = await obtenerInfoSerie(slugIntent)
        } else {
            await updateStatus(`🔎 _Buscando "${cleanQuery}"..._`)
            const results = await buscarHentaiLA(cleanQuery)

            if (!results.length)
                return updateStatus(`❌ No se encontraron resultados para *"${cleanQuery}"*.\n\n💡 Intenta con el nombre en inglés o las primeras palabras.`)

            if (results.length === 1) {
                await updateStatus(`✅ _Encontrado! Cargando info..._`)
                info = await obtenerInfoSerie(results[0].slug)
            } else {
                const filas = results.slice(0, 8).map(r => ({
                    rowId: episodio ? `${usedPrefix}hdl ${r.slug} ${episodio}` : `${usedPrefix}hdl ${r.slug}`,
                    title: r.title,
                }))
                await enviarListaWA(conn, m.chat, m, `🔞 Resultados: "${cleanQuery}"`, `${results.length} títulos. Elige uno:`, '📋 Ver opciones', 'Títulos', filas)
                await updateStatus(`🔎 _${results.length > 8 ? 8 : results.length} resultados. Elige un título._`)
                return
            }
        }

        // ── Sin episodio: mostrar portada + lista ──────────────────────────
        if (!episodio) {
            const epList = info.episodes.length > 0 ? info.episodes.slice(0, 20) : [1, 2, 3]
            const filas  = epList.map(ep => ({ rowId: `${usedPrefix}hdl ${info.slug} ${ep}`, title: `Episodio ${ep}` }))
            const desc   = `${info.desc}\n\n🎬 *Eps:* ${info.episodes.length || '?'} (${info.episodes.length === 1 ? 'Ep 1' : `Eps 1-${info.episodes[info.episodes.length-1]}`})\n🏷️ ${info.generos.slice(0,4).join(' · ') || 'N/A'}`
            await enviarListaWA(conn, m.chat, m, `🎬 ${info.title}`, desc, '📺 Elegir episodio', 'Episodios', filas, info.cover || null)
            await updateStatus(`💬 Elige un episodio de *${info.title}*`)
            return
        }

        await flujoCompleto(m, conn, info, episodio, statusKey)

    } catch (err) {
        console.error('[HentaiDL]', err.message)
        await updateStatus(`❌ *Error:* ${err.message}`)
    }
}

handler.before = async function (m, { conn }) {
    // nativeFlow (botones interactivos)
    const nativeFlow = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage
    if (nativeFlow) {
        try {
            const params     = JSON.parse(nativeFlow.paramsJson || '{}')
            const selectedId = params?.id || null
            if (selectedId) {
                const sessionKey = `${m.chat}|${m.sender}`
                const session    = global.hdlSessions?.[sessionKey]
                if (!session || session.owner !== m.sender || Date.now() > session.expiry) return true
                delete global.hdlSessions[sessionKey]
                const usedPrefix = selectedId[0]
                const [command, ...argParts] = selectedId.slice(1).trim().split(' ')
                const text = argParts.join(' ')
                try { await handler.call(conn, m, { conn, text, usedPrefix, command }) } catch (e) { console.error('[HDL before]', e.message) }
                return true
            }
        } catch { }
        return false
    }

    // listResponseMessage
    const listResp = m.message?.listResponseMessage
    if (listResp) {
        const rawInput = listResp.singleSelectReply?.selectedRowId
        if (rawInput) {
            const sessionKey = `${m.chat}|${m.sender}`
            const session    = global.hdlSessions?.[sessionKey]
            if (session && session.owner === m.sender && Date.now() <= session.expiry) {
                delete global.hdlSessions[sessionKey]
                const usedPrefix = rawInput[0]
                const [command, ...argParts] = rawInput.slice(1).trim().split(' ')
                try { await handler.call(conn, m, { conn, text: argParts.join(' '), usedPrefix, command }) } catch (e) { console.error('[HDL list]', e.message) }
                return true
            }
        }
    }

    return false
}

handler.help    = ['hdl <nombre> <episodio>', 'hlatest']
handler.tags    = ['nsfw']
handler.command = /^(hdl|hentaidl|hlatest|hentailatest)$/i

export default handler
