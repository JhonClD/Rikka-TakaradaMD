import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { pipeline } from 'stream/promises'
import { File as MegaFile } from 'megajs'
import { fetchText } from './Hentai-DL.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-419,es;q=0.9,en;q=0.8',
}

const isJKAnimeUrl = url => {
  try { return /(^|\.)jkanime\.net$/i.test(new URL(url).hostname) } catch (_) { return false }
}


export async function request(url, options = {}) {
  if (isJKAnimeUrl(url)) {
    try {
      if (/\/ajax\//i.test(new URL(url).pathname)) {
        try {
          return await axios.get(url, { ...options, headers: { ...HEADERS, ...options.headers }, timeout: options.timeout || 15000 })
        } catch (_) { /* Si JKAnime bloquea el acceso directo, probar la cadena de Hentai-DL. */ }
      }
      let data = await fetchText(url)
      if (/\/ajax\//i.test(new URL(url).pathname)) {
        try { data = JSON.parse(data) } catch (_) {}
      }
      return { data, status: 200 }
    } catch (err) {
      const blocked = new Error(`No se pudo acceder a JKAnime ni con la cadena de solicitudes de Hentai-DL: ${err.message}`)
      blocked.code = 'JKANIME_FETCH_FAILED'
      throw blocked
    }
  }

  let retries = 3
  while (retries > 0) {
    try {
      return await axios.get(url, { ...options, headers: { ...HEADERS, ...options.headers } })
    } catch (err) {
      retries--
      if (retries === 0) throw err
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}
export function zeroPad(n) { return String(n).padStart(2, '0') }
function safeFile(s) { return s.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() }
export function buildFileName(titulo, epNum) { return `${zeroPad(epNum)} ${safeFile(titulo)}.mp4` }
function detectarServNombre(url) {
  const u = url.toLowerCase()
  if (u.includes('mediafire')) return 'mediafire'
  if (u.includes('mega.nz')) return 'mega'
  if (u.includes('voe')) return 'voe'
  if (u.includes('filemoon')) return 'filemoon'
  if (u.includes('mp4upload')) return 'mp4upload'
  if (u.includes('streamwish')) return 'streamwish'
  if (u.includes('streamtape')) return 'streamtape'
  if (u.includes('dood')) return 'doodstream'
  if (u.includes('ok.ru')) return 'okru'
  if (u.includes('vidhide')) return 'vidhide'
  if (u.includes('mixdrop')) return 'mixdrop'
  return 'embed'
}

const PREFS_EMBED = ['mp4upload', 'filemoon', 'streamwish', 'streamtape', 'doodstream', 'voe', 'vidhide', 'okru', 'mixdrop']

export function ordenarServidores(srvs) {
  const mega = srvs.filter(s => s.nombre === 'mega')
  const mediafire = srvs.filter(s => s.nombre === 'mediafire')
  const otros = srvs.filter(s => s.directo && s.nombre !== 'mega' && s.nombre !== 'mediafire')
  const embeds = [...srvs.filter(s => !s.directo)].sort((a, b) => {
    const ia = PREFS_EMBED.findIndex(p => a.nombre.includes(p) || a.url.includes(p))
    const ib = PREFS_EMBED.findIndex(p => b.nombre.includes(p) || b.url.includes(p))
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })
  return [...mega, ...mediafire, ...otros, ...embeds]
}
export async function descargarMega(megaUrl, outputDir, fileName) {
  let url = megaUrl
  const m1 = megaUrl.match(/mega\.nz\/(?:embed\/)?[#!]*([A-Za-z0-9_-]{8,})!([A-Za-z0-9_-]{40,})/)
  if (m1) url = `https://mega.nz/file/${m1[1]}#${m1[2]}`
  const m2 = megaUrl.match(/mega\.nz\/file\/([A-Za-z0-9_-]+)!([A-Za-z0-9_-]+)/)
  if (m2) url = `https://mega.nz/file/${m2[1]}#${m2[2]}`

  const file = MegaFile.fromURL(url)
  await file.loadAttributes()

  const destPath = path.join(outputDir, fileName)
  const fileStream = file.download()

  let downloaded = 0
  fileStream.on('data', chunk => { downloaded += chunk.length })

  try {
    await pipeline(fileStream, fs.createWriteStream(destPath))
  } catch (err) {
    throw new Error(`Mega: fallo durante la escritura — ${err.message}`)
  }
  return destPath
}

export async function descargarMediaFire(mfUrl, outputDir, fileName) {
  let mfPage
  try {
    const res = await request(mfUrl, { timeout: 12000 })
    mfPage = res.data
  } catch (err) {
    throw new Error(`MediaFire: error al obtener página — ${err.message}`)
  }

  const mfLink =
    mfPage.match(/href=["'](https?:\/\/download\d+\.mediafire\.com[^"']+)["']/)?.[1] ||
    mfPage.match(/id="downloadButton"[^>]+href=["']([^"']+)["']/)?.[1] ||
    mfPage.match(/"(https?:\/\/download\d*\.mediafire\.com\/[^"]+)"/)?.[1]

  if (!mfLink) throw new Error('MediaFire: no encontré link de descarga directa')

  let mfRes
  try {
    mfRes = await axios.get(mfLink, {
      responseType: 'stream',
      headers: { ...HEADERS, Referer: 'https://www.mediafire.com/' },
      timeout: DL_TIMEOUT,
    })
  } catch (err) {
    throw new Error(`MediaFire: error al iniciar stream — ${err.message}`)
  }

  const destPath = path.join(outputDir, fileName)
  try {
    await pipeline(mfRes.data, fs.createWriteStream(destPath))
  } catch (err) {
    throw new Error(`MediaFire: fallo durante la escritura — ${err.message}`)
  }
  return destPath
}

function jsUnpack(packed) {
  try {
    const m = packed.match(/}\s*\('(.*)',\s*(.*?),\s*(\d+),\s*'(.*?)'\.split\('\|'\)/)
    if (!m) return null
    const payload = m[1].replace(/\\'/g, "'")
    const radix = parseInt(m[2]) || 36
    const symtab = m[4].split('|')
    return payload.replace(/\b[a-zA-Z0-9_]+\b/g, word => {
      const idx = parseInt(word, radix)
      return (symtab[idx] && symtab[idx] !== '') ? symtab[idx] : word
    })
  } catch (_) { return null }
}

function extraerUrlVideo(code) {
  const patrones = [
    /sources\s*:\s*\[{[^}]*file\s*:\s*["']([^"']+)["']/,
    /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /src\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["']([^"']+\.m3u8[^"']*)["']/i,
  ]
  for (const re of patrones) {
    const m = code.match(re)
    if (m?.[1]?.startsWith('http')) return m[1]
  }
  return null
}

async function resolverEmbed(embedUrl) {
  const u = embedUrl.toLowerCase()
  if (u.includes('voe.sx') || u.match(/voe\d*\.sx/)) {
    try {
      const { data } = await request(embedUrl.replace(/\/e\//, '/'), { headers: { Referer: embedUrl }, timeout: 15000 })
      const mHls = data.match(/["']hls["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/)
      if (mHls?.[1]) return mHls[1]
      const mAny = data.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/)
      if (mAny?.[1]) return mAny[1]
    } catch (_) {}
    return null
  }
  if (u.includes('filemoon') || u.includes('moonplayer')) {
    try {
      const { data } = await request(embedUrl, { headers: { Referer: embedUrl }, timeout: 15000 })
      const packed = data.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
      const unpacked = packed ? jsUnpack(packed[0]) : null
      return extraerUrlVideo(unpacked || data)
    } catch (_) {}
    return null
  }
  if (u.includes('mp4upload')) {
    try {
      const idMatch = embedUrl.match(/mp4upload\.com\/(?:embed-)?([A-Za-z0-9]+)/)
      const url = idMatch ? `https://www.mp4upload.com/embed-${idMatch[1]}.html` : embedUrl
      const { data } = await request(url, { headers: { Referer: 'https://www.mp4upload.com/' }, timeout: 15000 })
      const packed = data.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
      const code = packed ? jsUnpack(packed[0]) : data
      const m1 = (code || data).match(/player\.src\("([^"]+)"/)
      if (m1?.[1]) return m1[1]
      return extraerUrlVideo(code || data)
    } catch (_) {}
    return null
  }
  if (u.includes('dood') || u.includes('ds2play')) {
    try {
      const url = embedUrl.replace(/\/(d|watch)\//, '/e/')
      const res = await request(url, { headers: { Referer: 'https://dood.wf/' }, timeout: 15000 })
      const text = res.data
      const host = new URL(res.request?.res?.responseUrl || url).origin
      const pass = text.match(/\/pass_md5\/[^'"<\s]*/)?.[0]
      if (!pass) return null
      const token = pass.split('/').pop()
      const r2 = await request(host + pass, { headers: { Referer: url }, timeout: 15000 })
      const rand = Array.from({ length: 10 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('')
      return `${r2.data}${rand}?token=${token}&expiry=${Date.now()}`
    } catch (_) {}
    return null
  }
  if (u.includes('streamwish') || u.includes('wishembed') || u.includes('vidhide') || u.includes('filelions')) {
    try {
      const { data } = await request(embedUrl, { headers: { 'Sec-Fetch-Dest': 'document' }, timeout: 15000 })
      const packed = data.match(/eval\(function\(p,a,c,k,e[,\w]*\)[\s\S]+?\)\)/)
      if (packed) {
        const code = jsUnpack(packed[0])
        const src = code ? extraerUrlVideo(code) : null
        if (src) return src
      }
      return extraerUrlVideo(data)
    } catch (_) {}
    return null
  }
  return null
}

export async function descargarEmbed(embedUrl, outputDir, fileName, referer = 'https://jkanime.net') {
  const u = embedUrl.toLowerCase()
  if (u.includes('hqq.tv') || u.includes('netu.tv') || u.includes('netu.ac') || u.includes('biribup.com'))
    throw new Error(`Servidor sin soporte: ${embedUrl.split('/')[2]}`)

  let videoUrl = embedUrl
  const resuelto = await resolverEmbed(embedUrl)
  if (resuelto) {
    videoUrl = resuelto
  } else {
    try {
      const { data } = await request(embedUrl, { headers: { Referer: referer }, timeout: 12000 })
      const dm = data.match(/file\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i) ||
        data.match(/"(https?:\/\/[^"]+\.(?:mp4|m3u8)[^"]*)"/)
      if (dm?.[1]) videoUrl = dm[1]
    } catch (_) {}
  }

  const outTemplate = path.join(outputDir, 'video.%(ext)s')
  const cmdArgs = [
    '--no-check-certificate', '--no-warnings',
    '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--add-header', `User-Agent: ${UA}`,
    '--add-header', `Referer: ${referer}/`,
    '-o', outTemplate,
    videoUrl,
  ]

  await new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let errBuf = ''
    proc.stderr.on('data', d => { errBuf += d.toString() })
    const timer = setTimeout(() => { proc.kill(); reject(new Error('yt-dlp timeout')) }, DL_TIMEOUT)
    proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(errBuf.trim() || `código ${code}`)) })
    proc.on('error', err => { clearTimeout(timer); reject(err) })
  })

  const archivos = fs.readdirSync(outputDir).filter(f => /\.(mp4|mkv|webm)$/i.test(f))
  if (!archivos.length) throw new Error('yt-dlp no generó ningún archivo')

  const srcPath = path.join(outputDir, archivos[0])
  const destPath = path.join(outputDir, fileName)
  fs.renameSync(srcPath, destPath)
  return destPath
}
