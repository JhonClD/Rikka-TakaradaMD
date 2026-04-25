// ╔══════════════════════════════════════════════════════════════╗
// ║             HENTAI-DL.js — HentaiLA Downloader              ║
// ║  Comandos:                                                   ║
// ║   .hdl <nombre> <episodio>  → busca, portada y descarga     ║
// ║   .hdl overflow 1           → ejemplo                       ║
// ║   .hlatest                  → últimos lanzamientos          ║
// ╚══════════════════════════════════════════════════════════════╝

import fetch from 'node-fetch'
import { prepareWAMessageMedia, generateWAMessageFromContent, getDevice } from 'baileys'
import * as cheerio from 'cheerio'
import { File as MegaFile } from 'megajs'
import { lookup as mimeLookup } from 'mime-types'
import { pipeline } from 'stream/promises'
import { PassThrough } from 'stream'
import { performance } from 'perf_hooks'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import https from 'https'
import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

puppeteerExtra.use(StealthPlugin())

const httpsAgent = new https.Agent({ keepAlive: true, maxFreeSockets: 10 })
global.activeDownloads = global.activeDownloads || new Map()
global.hentaiSelection = global.hentaiSelection || {}
global.hdlSessions = global.hdlSessions || {}   // { "chatId|sender": { owner, expiry } }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const BASE = 'https://hentaila.com'

// ─── Helper: enviar lista interactiva de WhatsApp ─────────────────────────

async function enviarListaWA(conn, chat, m, titulo, descripcion, boton, seccion, filas, coverUrl = null) {
    // Registrar sesión: solo el sender original puede usar estos botones (5 min)
    const sessionKey = `${chat}|${m.sender}`
    global.hdlSessions[sessionKey] = {
        owner: m.sender,
        chat,
        expiry: Date.now() + 1 * 60 * 1000,
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
            // Preparar header: con imagen si hay coverUrl, sin ella si no
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
                header = {
                    title: titulo,
                    hasMediaAttachment: false,
                }
            }

            const interactiveMessage = {
                body: { text: descripcion },
                footer: { text: global.wm || 'Kana Arima Bot' },
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
                                    id: r.rowId,           // rowId = comando completo o clave
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

    // Fallback: texto plano para desktop/web o si falla interactiveMessage
    let txt = `✨ *${titulo}*
_${descripcion}_

`
    filas.forEach(r => {
        txt += `• *${r.rowId}* — ${r.title}`
        if (r.description) txt += ` _(${r.description})_`
        txt += `\n`
    })
    txt += `\n_Responde con el número._`
    return conn.sendMessage(chat, { text: txt }, { quoted: m })
}

// ─── Fetch helpers ─────────────────────────────────────────────────────────

async function fetchText(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' },
        agent: httpsAgent, timeout: 20000,
    })
    return res.text()
}

async function fetchBuffer(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, agent: httpsAgent, timeout: 20000 })
    return res.buffer()
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
    let m
    while ((m = epRe.exec(html)) !== null) epSet.add(Number(m[1]))
    const episodes = [...epSet].sort((a, b) => a - b)

    const $ = cheerio.load(html)
    const generos = []
    $('a[href*="?genre="]').each((_, el) => generos.push($(el).text().trim()))

    return { slug, title, cover, desc, episodes, generos }
}

// ─── Generar variaciones de slug a probar directamente ────────────────────

function generarSlugVariaciones(query) {
    const base = query.toLowerCase().trim()
    const variaciones = new Set()

    // Variación directa completa
    const full = base.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    variaciones.add(full)

    // Sin palabras cortas (the, wa, no, de, la, el, a)
    const sinStop = base.split(' ').filter(w => w.length > 2 && !['the', 'and', 'for', 'with', 'una', 'los', 'las', 'del'].includes(w))
    variaciones.add(sinStop.join('-').replace(/[^a-z0-9-]/g, ''))

    // Solo primeras 3 palabras
    const primeras3 = base.split(' ').slice(0, 3).join('-').replace(/[^a-z0-9-]/g, '')
    variaciones.add(primeras3)

    // Solo primeras 2 palabras
    const primeras2 = base.split(' ').slice(0, 2).join('-').replace(/[^a-z0-9-]/g, '')
    variaciones.add(primeras2)

    // Primera palabra sola
    const primera = base.split(' ')[0].replace(/[^a-z0-9-]/g, '')
    variaciones.add(primera)

    // Sin números romanos y partículas japonesas comunes (wa, no, ga, wo, ni)
    const sinParticulas = base.replace(/\b(wa|no|ga|wo|ni|ha|wo|de|mo|ka)\b/g, '').replace(/\s+/g, ' ').trim()
    variaciones.add(sinParticulas.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''))

    return [...variaciones].filter(v => v && v.length > 1)
}

// ─── Búsqueda por API interna / JSON del sitio ────────────────────────────

async function buscarPorAPI(query) {
    // HentaiLA tiene endpoints JSON para búsqueda en algunos casos
    const endpoints = [
        `${BASE}/api/search?q=${encodeURIComponent(query)}`,
        `${BASE}/api/anime/search?q=${encodeURIComponent(query)}`,
        `${BASE}/_app/search?q=${encodeURIComponent(query)}`,
    ]
    for (const url of endpoints) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                timeout: 8000,
            })
            if (!res.ok) continue
            const ct = res.headers.get('content-type') || ''
            if (!ct.includes('json')) continue
            const json = await res.json()
            // Intentar extraer resultados de distintas estructuras
            const items = json?.results || json?.data || json?.anime || json || []
            if (!Array.isArray(items) || items.length === 0) continue
            return items.map(i => ({
                slug: i.slug || i.id || '',
                title: i.title || i.name || i.slug || '',
            })).filter(i => i.slug)
        } catch (_) { continue }
    }
    return []
}

// ─── Búsqueda con fetch simple (sin JS) ──────────────────────────────────

async function buscarPorFetch(query) {
    try {
        const res = await fetch(`${BASE}/busqueda?q=${encodeURIComponent(query)}`, {
            headers: { 'User-Agent': UA, 'Accept-Language': 'es-419,es;q=0.9' },
            timeout: 15000,
        })
        const html = await res.text()
        const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')

        // Buscar slugs en el HTML/JS embebido
        const results = []
        const re = /"slug":"([^"]+)"(?:[^}]{0,300}?"title":"([^"]+)")?/g
        let m
        while ((m = re.exec(decoded)) !== null) {
            const slug = m[1], title = m[2] || m[1].replace(/-/g, ' ')
            if (slug && !results.find(r => r.slug === slug) && !slug.includes('/'))
                results.push({ slug, title })
        }

        // También buscar links /media/ en el HTML
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

// ─── Búsqueda con Puppeteer (fallback final) ──────────────────────────────

async function buscarConPuppeteer(query) {
    const browser = await puppeteerExtra.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    })
    const page = await browser.newPage()
    await page.setUserAgent(UA)
    try {
        await page.goto(`${BASE}/busqueda?q=${encodeURIComponent(query)}`, {
            waitUntil: 'networkidle2', timeout: 50000,
        })
        await new Promise(r => setTimeout(r, 4000))

        // Capturar el HTML renderizado y buscar slugs
        const content = await page.content()
        const decoded = content.replace(/\\u002F/g, '/').replace(/\\"/g, '"')

        const links = await page.evaluate(() => {
            const results = []
            document.querySelectorAll('a[href*="/media/"]').forEach(a => {
                const href = a.href || ''
                const parts = href.split('/media/')[1]?.split('/')
                if (!parts) return
                const slug = parts[0]
                if (!slug || /^\d+$/.test(slug) || results.find(r => r.slug === slug)) return
                const titleEl = a.querySelector('h3, h2, .title, [class*="title"], p') || a
                const title = titleEl.innerText?.trim() || slug.replace(/-/g, ' ')
                results.push({ slug, title })
            })
            return results
        })

        // También buscar en el HTML serializado por si Svelte lo embebió
        const extraRe = /"slug":"([^"]+)"(?:[^}]{0,300}?"title":"([^"]+)")?/g
        let m
        while ((m = extraRe.exec(decoded)) !== null) {
            const slug = m[1], title = m[2] || m[1].replace(/-/g, ' ')
            if (slug && !links.find(r => r.slug === slug) && !slug.includes('/'))
                links.push({ slug, title })
        }

        await browser.close()
        return links
    } catch (err) {
        await browser.close()
        console.error('[Puppeteer]', err.message)
        return []
    }
}

// ─── Búsqueda principal: combina todos los métodos ────────────────────────

async function buscarHentaiLA(query) {
    // 1. Probar slugs generados directamente (HEAD request, muy rápido)
    const variaciones = generarSlugVariaciones(query)
    for (const slug of variaciones) {
        try {
            const res = await fetch(`${BASE}/media/${slug}`, {
                method: 'HEAD', headers: { 'User-Agent': UA }, timeout: 6000,
            })
            if (res.status === 200) {
                console.log(`[SLUG] ✅ Encontrado directo: ${slug}`)
                return [{ slug, title: slug.replace(/-/g, ' ') }]
            }
        } catch (_) { continue }
    }

    // 2. Intentar API JSON
    const apiResults = await buscarPorAPI(query)
    if (apiResults.length > 0) {
        console.log(`[API] ✅ ${apiResults.length} resultados`)
        return apiResults
    }

    // 3. Fetch simple (extrae JSON embebido en el HTML/JS de SvelteKit)
    const fetchResults = await buscarPorFetch(query)
    if (fetchResults.length > 0) {
        console.log(`[FETCH] ✅ ${fetchResults.length} resultados`)
        return fetchResults
    }

    // 4. Puppeteer como último recurso
    console.log(`[PUPPETEER] Iniciando búsqueda navegador...`)
    const puppResults = await buscarConPuppeteer(query)
    return puppResults
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
// Extrae TODOS los servidores disponibles con fallback priorizado

async function obtenerLinksDescarga(mediaUrl) {
    const html = await fetchText(mediaUrl)
    const decoded = html.replace(/\\u002F/g, '/').replace(/\\"/g, '"')

    const mega = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mega\.nz\/file\/[^\s"'<\\]*/g) || [])]
    const mediafire = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mediafire\.com\/file[^\s"'<\\]*/g) || [])]
    const fireload = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*fireload\.com\/[^\s"'<\\]*/g) || [])]
    const fichier = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*1fichier\.com\/\?[^\s"'<\\]*/g) || [])]
    const mp4upload = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*mp4upload\.com\/[^\s"'<\\]*/g) || [])]
    const yourupload = [...new Set(decoded.match(/https?:\/\/[^\s"'<\\]*yourupload\.com\/[^\s"'<\\]*/g) || [])]
    // Catch-all: cualquier otro link de descarga genérico que no sea de la propia web
    const otros = [...new Set(
        (decoded.match(/https?:\/\/[^\s"'<\\]{10,}/g) || [])
            .filter(u =>
                !u.includes(BASE) &&
                !mega.includes(u) &&
                !mediafire.includes(u) &&
                !fireload.includes(u) &&
                !fichier.includes(u) &&
                !mp4upload.includes(u) &&
                !yourupload.includes(u) &&
                /\.(mp4|mkv|avi|ts|m4v)(\?|$)/i.test(u)
            )
    )]

    return { mega, mediafire, fireload, fichier, mp4upload, yourupload, otros }
}

// ─── Resolver MediaFire → URL directa ────────────────────────────────────

async function resolverMediafire(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 15000 })
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

// ─── Resolver FireLoad → URL directa ─────────────────────────────────────

async function resolverFireload(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 15000 })
    const html = await res.text()
    const direct =
        html.match(/href="(https?:\/\/[^"]*fireload\.com\/d\/[^"]+)"/)?.[1] ||
        html.match(/file:\s*"([^"]+)"/)?.[1] ||
        html.match(/source\s+src="([^"]+)"/)?.[1]
    const name = html.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() || 'video.mp4'
    return { direct: direct || null, name }
}

// ─── Resolver 1Fichier → URL directa ─────────────────────────────────────

async function resolver1fichier(url) {
    // 1Fichier requiere POST para obtener link directo
    const res = await fetch('https://api.1fichier.com/v1/download/get_token.cgi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ url }),
        timeout: 15000,
    })
    const json = await res.json().catch(() => null)
    const direct = json?.download_url || null
    return { direct, name: json?.filename || 'video.mp4' }
}

// ─── Resolver MP4Upload → URL directa ────────────────────────────────────

async function resolverMp4upload(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, timeout: 15000 })
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
    const head = await fetch(directUrl, { method: 'HEAD', headers: { 'User-Agent': UA }, timeout: 10000 })
    const sizeBytes = parseInt(head.headers.get('content-length') || '0')
    const sizeH = sizeBytes ? (sizeBytes / 1048576).toFixed(2) + ' MB' : '?'

    await updateStatus(`📥 *${label}:* ${fileName}\n⚖️ *Peso:* ${sizeH}\n⏬ _Descargando..._`)

    const { default: axios } = await import('axios')
    const response = await axios({
        method: 'get', url: directUrl, responseType: 'stream',
        headers: { 'User-Agent': UA }, httpsAgent,
    })
    let dld = 0
    response.data.on('data', chunk => {
        dld += chunk.length
        process.stdout.write(`\r[${label}] ${sizeBytes ? ((dld / sizeBytes) * 100).toFixed(1) : '?'}% (${(dld / 1048576).toFixed(1)} MB)`)
    })
    await pipeline(response.data, fs.createWriteStream(tempPath))
    console.log(`\n[${label}] ✅ Completo`)
    return sizeH
}

// ─── Enviar Msg 2: portada con info ───────────────────────────────────────

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
            await conn.sendMessage(m.chat, {
                image: imgBuf, caption, mimetype: 'image/jpeg',
            }, { quoted: m })
            return
        } catch (_) { /* fallback a texto */ }
    }
    await conn.sendMessage(m.chat, { text: caption }, { quoted: m })
}

// ─── Descarga + envío del archivo (Msg 3) ─────────────────────────────────
// Intenta cada servidor en orden: MEGA → MediaFire → FireLoad → 1Fichier → MP4Upload → YourUpload → otros

async function descargarYEnviar(m, conn, mediaUrl, title, episodio, updateStatus) {
    const links = await obtenerLinksDescarga(mediaUrl)

    const totalLinks =
        links.mega.length + links.mediafire.length + links.fireload.length +
        links.fichier.length + links.mp4upload.length + links.yourupload.length + links.otros.length

    if (totalLinks === 0) {
        return updateStatus(`❌ No se encontraron links de descarga.\n🔗 ${mediaUrl}`)
    }

    // Lista priorizada de servidores a intentar
    const servidores = [
        ...links.mega.map(u => ({ tipo: 'mega', url: u })),
        ...links.mediafire.map(u => ({ tipo: 'mediafire', url: u })),
        ...links.fireload.map(u => ({ tipo: 'fireload', url: u })),
        ...links.fichier.map(u => ({ tipo: '1fichier', url: u })),
        ...links.mp4upload.map(u => ({ tipo: 'mp4upload', url: u })),
        ...links.yourupload.map(u => ({ tipo: 'yourupload', url: u })),
        ...links.otros.map(u => ({ tipo: 'directo', url: u })),
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
                // YourUpload generalmente tiene embed con src directo
                const res = await fetch(srv.url, { headers: { 'User-Agent': UA }, timeout: 15000 })
                const html = await res.text()
                const direct = html.match(/file:\s*"([^"]+)"/)?.[1] || html.match(/src="([^"]+\.mp4[^"]*)"/)?.[1]
                if (!direct) throw new Error('No se pudo resolver YourUpload')
                sizeH = await descargarDirecto(direct, fileName, tempPath, updateStatus, 'YourUpload')

            } else {
                // URL directa
                sizeH = await descargarDirecto(srv.url, fileName, tempPath, updateStatus, 'Directo')
            }

            // Si llegamos aquí la descarga fue exitosa
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
        console.log('[BOT] Subiendo...')

        const stats = fs.statSync(tempPath)
        let uploaded = 0, start = performance.now()
        const ps = new PassThrough()
        ps.on('data', chunk => {
            uploaded += chunk.length
            const elapsed = (performance.now() - start) / 1000
            const speed = (uploaded / 1048576 / Math.max(elapsed, 0.1)).toFixed(2)
            process.stdout.write(`\r[WA] ⬆️ ${((uploaded / stats.size) * 100).toFixed(1)}% | ${speed} MB/s`)
        })
        fs.createReadStream(tempPath).pipe(ps)

        // Renombrar al formato limpio: "01 Titulo.mp4"
        const epNum = String(episodio).padStart(2, '0')
        const cleanTitle = title.replace(/[/\\:*?"<>|]/g, '').trim()
        const finalName = `${epNum} ${cleanTitle}.mp4`

        // Msg 3: el archivo
        await conn.sendMessage(m.chat, {
            document: { url: tempPath },
            fileName: finalName,
            mimetype: 'video/mp4',
            caption:
                `🔞 *${title}* — Ep. ${episodio}\n` +
                `📁 ${finalName}\n` +
                `⚖️ ${sizeH}\n` +
                `🌐 HentaiLA`,
        }, { quoted: m })

        console.log('\n[BOT] ✨ Listo!')
        await updateStatus(`✅ *¡Enviado!* 🔞 ${title} — Ep. ${episodio}`)

    } finally {
        if (tempPath && fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath) } catch (_) { }
        }
    }
}

// ─── Flujo completo: buscar → portada → descargar ─────────────────────────

async function flujoCompleto(m, conn, info, episodio, statusKey) {
    const updateStatus = async txt => conn.sendMessage(m.chat, { text: txt, edit: statusKey })

    // Msg 2: portada con info
    await updateStatus(`🖼️ _Cargando portada de *${info.title}*..._`)
    await enviarPortada(m, conn, info, episodio,
        `📥 Preparando descarga del episodio *${episodio}*...`
    )

    // Msg 1 actualizado: descargando
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

    // Msg 1: estado inicial
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
        const direct = await fetch(`${BASE}/media/${slugIntent}`, {
            method: 'HEAD', headers: { 'User-Agent': UA }, timeout: 8000,
        }).catch(() => ({ status: 0 }))

        let info = null

        if (direct.status === 200) {
            await updateStatus(`✅ _Encontrado! Cargando info..._`)
            info = await obtenerInfoSerie(slugIntent)
        } else {
            await updateStatus(`🔎 _Buscando "${cleanQuery}"..._`)
            const results = await buscarHentaiLA(cleanQuery)

            if (results.length === 0)
                return updateStatus(
                    `❌ No se encontraron resultados para *"${cleanQuery}"*.\n\n` +
                    `💡 Intenta con el nombre en inglés o japonés, o solo las primeras palabras.\n` +
                    `Ej: \`.hdl seihou shouka\` o \`.hdl saint lime\``
                )

            if (results.length === 1) {
                await updateStatus(`✅ _Encontrado! Cargando info..._`)
                info = await obtenerInfoSerie(results[0].slug)
            } else {
                // Menú de selección con botones de lista
                const top = results.slice(0, 8)
                const filas = top.map((r) => ({
                    rowId: episodio
                        ? `${usedPrefix}hdl ${r.slug} ${episodio}`
                        : `${usedPrefix}hdl ${r.slug}`,
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

        // ── Si no especificó episodio: mostrar portada + lista de episodios ──
        if (!episodio) {
            const epList = info.episodes.length > 0 ? info.episodes.slice(0, 20) : [1, 2, 3]
            const filasEp = epList.map(ep => ({
                rowId: `${usedPrefix}hdl ${info.slug} ${ep}`,
                title: `Episodio ${ep}`,
            }))
            await enviarListaWA(
                conn, m.chat, m,
                `🎬 ${info.title}`,
                `${info.desc}\n\n🎬 *Eps:* ${info.episodes.length > 0 ? info.episodes.length + " (" + (info.episodes.length === 1 ? "Episodio 1" : "Eps 1-" + info.episodes[info.episodes.length-1]) + ")" : "?"}\n🏷️ *Géneros:* ${info.generos.length > 0 ? info.generos.slice(0,4).join(" · ") : "N/A"}`,
                '📺 Elegir episodio',
                'Episodios disponibles',
                filasEp,
                info.cover || null
            )
            await updateStatus(`💬 Elige un episodio de *${info.title}*`)
            return
        }

        // ── Tiene episodio: flujo completo ────────────────────────────────
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
                // Verificar que quien toca el botón sea el dueño de la sesión
                const sessionKey = `${m.chat}|${m.sender}`
                const session = global.hdlSessions?.[sessionKey]

                if (!session || session.owner !== m.sender || Date.now() > session.expiry) {
                    // No es el dueño o expiró → bloquear silenciosamente (solo log en terminal)
                    console.log(`[HDL] Botón ignorado: @${m.sender.split('@')[0]} no es el dueño de la sesión`)
                    return true // Consumir el mensaje sin ejecutar
                }

                // Es el dueño → limpiar sesión y ejecutar comando
                delete global.hdlSessions[sessionKey]
                m.text = selectedId
            }
        } catch (_) {}
        return false
    }

    // ── Fallback: texto plano numérico (para desktop/web) ───────────────────
    let rawInput = null

    const listResp = m.message?.listResponseMessage
    if (listResp) {
        rawInput = listResp.singleSelectReply?.selectedRowId || null
    }

    if (!rawInput) {
        if (!m.text || !/^\d+$/.test(m.text.trim())) return false
        rawInput = m.text.trim()
    }

    if (!/^\d+$/.test(rawInput)) return false

    // Verificar si este usuario tiene una selección activa (fallback desktop)
    const sel = global.hentaiSelection?.[m.sender]
    if (!sel) return false

    const input = parseInt(rawInput)

    // ── Método 1: verificar si responde a alguno de nuestros mensajes ──────
    // ── Método 2 (fallback): si el usuario tiene selección activa, aceptar cualquier número válido

    // Intentar extraer texto del mensaje citado (si existe)
    const quotedText = m.quoted
        ? (m.quoted.text || m.quoted.body || m.quoted.caption || m.quoted.message?.conversation || '')
        : ''

    const esListaTitulos = /n.mero para ver portada|Últimos lanzamientos|Resultados para|n.mero del t.tulo/i.test(quotedText)
    const esListaEpisodios = /n.mero de episodio/i.test(quotedText)

    // Si el usuario respondió un mensaje pero no es nuestro → ignorar
    if (m.quoted && !esListaTitulos && !esListaEpisodios) {
        // Último recurso: verificar por msgId guardado
        const quotedId = m.quoted?.key?.id || m.quoted?.id
        const esMsgGuardado = quotedId && sel.msgId && quotedId === sel.msgId
        if (!esMsgGuardado) return false
    }

    // Si no hay quoted en absoluto, aceptar si tiene selección activa (el usuario escribió el número directo)
    // Esto permite responder tanto citando como escribiendo solo el número

    // ── Selección de título / latest ──────────────────────────────────────
    if (sel.type === 'selectTitle' || sel.type === 'latest') {
        const index = input - 1
        if (index < 0 || index >= sel.results.length) {
            await conn.sendMessage(m.chat, {
                text: `❌ Número inválido. Elige entre 1 y ${sel.results.length}.`
            }, { quoted: m })
            return true
        }
        delete global.hentaiSelection[m.sender]

        const item = sel.results[index]
        const episodio = item.episode || sel.episodio || null

        let statusKey
        try {
            const sent = await conn.sendMessage(m.chat,
                { text: `✅ _Cargando info de *${item.title || item.slug}*..._` },
                { quoted: m }
            )
            statusKey = sent.key
        } catch (_) {
            statusKey = null
        }

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
            const pfx = global.prefix || '.'
            const epList = info.episodes.length > 0 ? info.episodes.slice(0, 20) : [1, 2, 3]
            const filasEp = epList.map(ep => ({
                rowId: `${pfx}hdl ${info.slug} ${ep}`,
                title: `Episodio ${ep}`,
            }))
            await enviarListaWA(
                conn, m.chat, m,
                `🎬 ${info.title}`,
                `${info.desc}\n\n🎬 *Eps:* ${info.episodes.length > 0 ? info.episodes.length + " (" + (info.episodes.length === 1 ? "Episodio 1" : "Eps 1-" + info.episodes[info.episodes.length-1]) + ")" : "?"}\n🏷️ *Géneros:* ${info.generos.length > 0 ? info.generos.slice(0,4).join(" · ") : "N/A"}`,
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

    // ── Selección de episodio ─────────────────────────────────────────────
    if (sel.type === 'selectEp') {
        const episodio = rawInput
        const { slug, title } = sel
        delete global.hentaiSelection[m.sender]

        let statusKey
        try {
            const sent = await conn.sendMessage(m.chat,
                { text: `⬇️ _Descargando episodio *${episodio}* de *${title}*..._` },
                { quoted: m }
            )
            statusKey = sent.key
        } catch (_) {
            statusKey = null
        }

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