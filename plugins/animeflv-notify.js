// plugins/animeflv-notify.js
// Notificador automático de nuevos episodios — AnimeFLV (m.animeflv.net)

import axios        from 'axios'
import * as cheerio from 'cheerio'
import fs           from 'fs'
import path         from 'path'

// ─── Constantes ───────────────────────────────────────────────────────────────

const ANIMEFLV_URL = 'https://m.animeflv.net'
const DB_DIR = path.join(process.cwd(), 'database')
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const SEEN_FILE = path.join(DB_DIR, 'animeflv_seen.json')
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
  const { data } = await axios.get(ANIMEFLV_URL, { headers: HEADERS, timeout: 15000 })
  const $ = cheerio.load(data)
  const lista = []

  // AnimeFLV móvil usa una lista de enlaces con imágenes
  $('ul.ListEpisodios li a, #Tbepisodes a').each((_, el) => {
    const href = $(el).attr('href') || ''
    if (!href.includes('/ver/')) return

    const m = href.match(/\/ver\/(.+?)-(\d+)\/?$/)
    if (!m) return

    const slug = m[1]
    const epNum = parseInt(m[2])
    const titulo = $(el).find('h2').text().trim() || slug.replace(/-/g, ' ')
    const imgEl = $(el).find('img').first()
    const imgSrc = imgEl.attr('src') || imgEl.attr('data-src') || ''
    const imgUrl = imgSrc ? (imgSrc.startsWith('http') ? imgSrc : ANIMEFLV_URL + imgSrc) : ''
    const epUrl = href.startsWith('http') ? href : ANIMEFLV_URL + href
    const id = `flv-${slug}-${epNum}`

    if (!lista.find(e => e.id === id)) lista.push({ id, slug, titulo, epNum, epUrl, imgUrl })
  })

  return lista
}

async function scrapeServidores(epUrl) {
  const { data } = await axios.get(epUrl, { headers: { ...HEADERS, Referer: ANIMEFLV_URL }, timeout: 15000 })
  const srvs = []

  // En AnimeFLV los servidores están en una variable JS 'videos'
  const videoMatch = data.match(/var\s+videos\s*=\s*({.*?});/)
  if (videoMatch) {
    try {
      const videoData = JSON.parse(videoMatch[1])
      // videoData suele tener una clave "SUB" o "LAT" que contiene un array de servidores
      const sources = videoData.SUB || videoData.LAT || []
      for (const s of sources) {
        const url = s.url || s.code || ''
        const nombre = (s.title || s.server || 'server').toLowerCase()
        if (url) {
          srvs.push({ 
            nombre: nombre, 
            url: url.startsWith('http') ? url : url.replace(/^\/\//, 'https://'), 
            directo: nombre === 'mega' 
          })
        }
      }
    } catch (e) {}
  }

  return srvs
}

// ─── Lógica Principal ─────────────────────────────────────────────────────────

let handler = async (m, { conn }) => {
  const seen = loadSeen()
  const episodes = await fetchLatestEpisodes()
  
  for (const ep of episodes) {
    if (seen[ep.id]) continue
    
    const srvs = await scrapeServidores(ep.epUrl)
    const srvText = srvs.map(s => `• ${s.nombre.toUpperCase()}: ${s.url}`).join('\n')
    
    const message = `🎬 *NUEVO EPISODIO EN ANIMEFLV*\n\n` +
                    `📖 *Título:* ${ep.titulo}\n` +
                    `🔢 *Episodio:* ${ep.epNum}\n` +
                    `🔗 *Enlace:* ${ep.epUrl}\n\n` +
                    `📥 *Servidores:*\n${srvText || 'No se encontraron enlaces.'}`

    if (ep.imgUrl) {
      await conn.sendMessage(m.chat, { image: { url: ep.imgUrl }, caption: message }, { quoted: m })
    } else {
      await conn.sendMessage(m.chat, { text: message }, { quoted: m })
    }
    
    seen[ep.id] = true
  }
  
  saveSeen(seen)
}

handler.command = /^(flvnotify)$/i
handler.owner = true

export default handler
