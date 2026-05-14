// plugins/monoschinos2-notify.js
// Notificador automático de nuevos episodios — MonosChinos2

import axios        from 'axios'
import * as cheerio from 'cheerio'
import fs           from 'fs'
import path         from 'path'

// ─── Constantes ───────────────────────────────────────────────────────────────

const MONOSCHINOS_URL = 'https://monoschinos2.com'
const DB_DIR = path.join(process.cwd(), 'database')
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const SEEN_FILE = path.join(DB_DIR, 'monoschinos_seen.json')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
}

// ─── Persistencia ─────────────────────────────────────────────────────────────

function loadSeen() { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8')) } catch (_) { return {} } }
function saveSeen(d) { try { fs.writeFileSync(SEEN_FILE, JSON.stringify(d, null, 2)) } catch (_) {} }

// ─── Scraping ─────────────────────────────────────────────────────────────────

async function fetchLatestEpisodes() {
  const { data } = await axios.get(MONOSCHINOS_URL, { headers: HEADERS, timeout: 15000 })
  const $ = cheerio.load(data)
  const lista = []

  $('.row.row-cols-2 .col').each((_, el) => {
    const $el = $(el)
    const aTag = $el.find('a').first()
    const href = aTag.attr('href') || ''
    if (!href) return

    // URL format: https://monoschinos2.com/ver/slug-episodio-N
    const m = href.match(/\/ver\/(.+?)-episodio-(\d+)\/?$/)
    if (!m) return

    const slug = m[1]
    const epNum = parseInt(m[2])
    const titulo = $el.find('h2').text().trim() || slug.replace(/-/g, ' ')
    const imgEl = $el.find('img').first()
    const imgSrc = imgEl.attr('src') || imgEl.attr('data-src') || ''
    const imgUrl = imgSrc.startsWith('http') ? imgSrc : MONOSCHINOS_URL + imgSrc
    const epUrl = href.startsWith('http') ? href : MONOSCHINOS_URL + href
    const id = `monos-${slug}-${epNum}`

    if (!lista.find(e => e.id === id)) lista.push({ id, slug, titulo, epNum, epUrl, imgUrl })
  })

  return lista
}

async function scrapeServidores(epUrl) {
  const { data } = await axios.get(epUrl, { headers: { ...HEADERS, Referer: MONOSCHINOS_URL }, timeout: 15000 })
  const $ = cheerio.cheerio.load(data)
  const srvs = []

  // Descargas directas (Gofile, Mediafire, etc)
  $('.dropdown-menu a').each((_, el) => {
    const href = $(el).attr('href') || ''
    const label = $(el).text().trim().toLowerCase()
    if (!href.startsWith('http')) return
    
    const esMega = href.includes('mega.nz')
    const esMediafire = href.includes('mediafire.com')
    const esOtro = href.includes('gofile.io') || href.includes('pixeldrain.com')
    
    if (esMega || esMediafire || esOtro) {
      srvs.push({ 
        nombre: esMega ? 'mega' : esMediafire ? 'mediafire' : label || 'descarga', 
        url: href, 
        directo: true 
      })
    }
  })

  // Botones de servidores de streaming (generalmente cargan por JS, pero a veces el data-url está presente)
  $('button[data-url]').each((_, el) => {
    const url = $(el).attr('data-url')
    const nombre = $(el).text().trim().toLowerCase()
    if (url && url.startsWith('http')) {
      srvs.push({ nombre, url, directo: false })
    }
  })

  return srvs
}

// ─── Lógica Principal ─────────────────────────────────────────────────────────

let handler = async (m, { conn }) => {
  // Este plugin se ejecuta automáticamente en un intervalo, pero también puede ser manual
  const seen = loadSeen()
  const episodes = await fetchLatestEpisodes()
  
  for (const ep of episodes) {
    if (seen[ep.id]) continue
    
    const srvs = await scrapeServidores(ep.epUrl)
    const srvText = srvs.map(s => `• ${s.nombre.toUpperCase()}: ${s.url}`).join('\n')
    
    const message = `🎬 *NUEVO EPISODIO EN MONOSCHINOS*\n\n` +
                    `📖 *Título:* ${ep.titulo}\n` +
                    `🔢 *Episodio:* ${ep.epNum}\n` +
                    `🔗 *Enlace:* ${ep.epUrl}\n\n` +
                    `📥 *Servidores:*\n${srvText || 'No se encontraron enlaces directos.'}`

    if (ep.imgUrl) {
      await conn.sendMessage(m.chat, { image: { url: ep.imgUrl }, caption: message }, { quoted: m })
    } else {
      await conn.sendMessage(m.chat, { text: message }, { quoted: m })
    }
    
    seen[ep.id] = true
  }
  
  saveSeen(seen)
}

handler.command = /^(monosnotify)$/i
handler.owner = true

export default handler
