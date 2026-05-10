import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const envPath = path.resolve(__dirname, '../.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const idx = t.indexOf('=')
    if (idx === -1) continue
    const k = t.slice(0, idx).trim(), v = t.slice(idx + 1).trim()
    if (k && !(k in process.env)) process.env[k] = v
  }
}

const ARIA2_RPC    = `http://localhost:${process.env.ARIA2_PORT || 6800}/jsonrpc`
const ARIA2_SECRET = `token:${process.env.ARIA2_SECRET || 'rikka'}`
const DL_DIR       = process.env.LEECH_DIR || `${process.env.HOME}/leech_downloads`
const MAX_WA_SIZE  = 200 * 1024 * 1024
const POLL_MS      = 5_000

const tasks = new Map()

const fmtBytes = (b = 0) => {
  if (b <= 0) return '0 B'
  const u = ['B','KB','MB','GB','TB']
  let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++ }
  return `${b.toFixed(2)} ${u[i]}`
}

const fmtTime = (s = 0) => {
  if (!s || !isFinite(s) || s < 0) return '∞'
  s = Math.floor(s)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60
  return h ? `${h}h ${m}m` : m ? `${m}m ${ss}s` : `${ss}s`
}

const pBar = (pct = 0, w = 14) => {
  pct = Math.min(100, Math.max(0, pct))
  const f = Math.round((pct / 100) * w)
  return `[${'█'.repeat(f)}${'░'.repeat(w - f)}] ${pct.toFixed(1)}%`
}

let _id = 0
async function rpc(method, params = []) {
  const res = await fetch(ARIA2_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params: [ARIA2_SECRET, ...params] }),
    signal: AbortSignal.timeout(6_000)
  })
  const d = await res.json()
  if (d.error) throw new Error(d.error.message)
  return d.result
}

async function checkAria2() {
  try { await rpc('aria2.getVersion'); return true } catch { return false }
}

async function addMagnet(magnet) {
  fs.mkdirSync(DL_DIR, { recursive: true })
  return rpc('aria2.addUri', [[magnet], {
    dir: DL_DIR,
    'bt-save-metadata': 'true',
    'bt-tracker': await getTrackers(),
    'max-connection-per-server': '16',
    'seed-time': '0'
  }])
}

async function addTorrentFile(buf) {
  fs.mkdirSync(DL_DIR, { recursive: true })
  const b64 = buf.toString('base64')
  return rpc('aria2.addTorrent', [b64, [], {
    dir: DL_DIR,
    'bt-tracker': await getTrackers(),
    'seed-time': '0'
  }])
}

async function getStatus(gid) {
  return rpc('aria2.tellStatus', [gid, [
    'status','totalLength','completedLength','downloadSpeed',
    'numSeeders','connections','files','bittorrent','errorMessage'
  ]])
}

async function removeTask(gid) {
  try { await rpc('aria2.forceRemove', [gid]) } catch {}
  try { await rpc('aria2.removeDownloadResult', [gid]) } catch {}
}

let _trackerCache = ''
async function getTrackers() {
  if (_trackerCache) return _trackerCache
  try {
    const r = await fetch('https://cf.trackerslist.com/best_aria2.txt', { signal: AbortSignal.timeout(5_000) })
    _trackerCache = (await r.text()).replace(/\n/g, ',').trim()
  } catch {
    _trackerCache = ''
  }
  return _trackerCache
}

function buildProgressMsg(st, torrentName) {
  const total    = parseInt(st.totalLength || 0)
  const done     = parseInt(st.completedLength || 0)
  const speed    = parseInt(st.downloadSpeed || 0)
  const seeders  = parseInt(st.numSeeders || 0)
  const peers    = parseInt(st.connections || 0)
  const pct      = total > 0 ? (done / total) * 100 : 0
  const eta      = speed > 0 && total > done ? (total - done) / speed : 0
  const name     = torrentName || st.bittorrent?.info?.name || 'Cargando metadata...'

  const files = (st.files || []).filter(f => f.selected === 'true' || !f.selected)
  const fileLines = files.slice(0, 5).map(f => `  • \`${path.basename(f.path || 'archivo')}\``).join('\n')
  const moreFiles = files.length > 5 ? `\n  _...y ${files.length - 5} más_` : ''

  return `🌀 *Descargando Torrent*\n\n` +
    `📁 *${name}*\n\n` +
    `${pBar(pct)}\n\n` +
    `💾 ${fmtBytes(done)} / ${fmtBytes(total)}\n` +
    `⚡ ${fmtBytes(speed)}/s   ⏳ ${fmtTime(eta)}\n` +
    `🌱 Seeders: ${seeders}   👥 Peers: ${peers}\n\n` +
    (fileLines ? `📂 *Archivos:*\n${fileLines}${moreFiles}\n\n` : '') +
    `_Escribe_ \`cancelar\` _para detener_`
}

async function sendFile(conn, chat, filePath, m) {
  const buf  = fs.readFileSync(filePath)
  const name = path.basename(filePath)
  const size = buf.length
  const ext  = name.split('.').pop().toLowerCase()
  const cap  = `📁 *${name}*\n📦 ${fmtBytes(size)}`

  if (/mp4|mkv|webm|mov|avi/.test(ext)) {
    await conn.sendMessage(chat, { video: buf, caption: cap, mimetype: 'video/mp4', fileName: name }, { quoted: m })
  } else if (/mp3|m4a|flac|wav|ogg|aac/.test(ext)) {
    await conn.sendMessage(chat, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: name }, { quoted: m })
  } else {
    await conn.sendMessage(chat, { document: buf, mimetype: 'application/octet-stream', fileName: name, caption: cap }, { quoted: m })
  }
}

async function runDownload(gid, conn, m, progressKey) {
  const task = { chat: m.chat, msgKey: progressKey, cancelled: false }
  tasks.set(gid, task)
  let torrentName = ''

  return new Promise((resolve, reject) => {
    const poll = setInterval(async () => {
      try {
        if (task.cancelled) {
          clearInterval(poll)
          await removeTask(gid)
          tasks.delete(gid)
          return reject(new Error('Cancelado'))
        }

        const st = await getStatus(gid)
        if (!torrentName && st.bittorrent?.info?.name) torrentName = st.bittorrent.info.name

        const txt = buildProgressMsg(st, torrentName)
        await conn.sendMessage(m.chat, { edit: { key: progressKey, message: txt } }).catch(() => {})

        if (st.status === 'complete') {
          clearInterval(poll)
          tasks.delete(gid)
          const files = (st.files || []).map(f => f.path).filter(Boolean)
          resolve({ files, name: torrentName })
        } else if (st.status === 'error') {
          clearInterval(poll)
          tasks.delete(gid)
          reject(new Error(st.errorMessage || 'Error desconocido'))
        } else if (st.status === 'removed') {
          clearInterval(poll)
          tasks.delete(gid)
          reject(new Error('Descarga removida'))
        }
      } catch (e) {
        clearInterval(poll)
        tasks.delete(gid)
        reject(e)
      }
    }, POLL_MS)
  })
}

const handler = async (m, { conn, text, args, command }) => {
  if (command === 'tcancel') {
    let n = 0
    for (const [gid, task] of tasks.entries()) {
      if (task.chat === m.chat) { task.cancelled = true; n++ }
    }
    return m.reply(n ? `✅ Cancelando ${n} descarga(s)...` : '❌ No hay descargas activas en este chat.')
  }

  const input = (text || args?.join(' ') || '').trim()
  const magnet = input.match(/(magnet:\?[^\s]+)/)?.[1]
    || m.quoted?.text?.match(/(magnet:\?[^\s]+)/)?.[1]
    || null

  const hasTorrentDoc = m.mimetype === 'application/x-bittorrent'
    || m.quoted?.mimetype === 'application/x-bittorrent'
    || m.filename?.endsWith('.torrent')
    || m.quoted?.filename?.endsWith('.torrent')

  if (!magnet && !hasTorrentDoc) {
    return m.reply(`🌀 *Descargador de Torrents*\n\n*Uso:*\n• \`.torrent magnet:?xt=...\`\n• Envía o responde a un \`.torrent\`\n\n*Cancelar:* \`.tcancel\``)
  }

  if (!await checkAria2()) {
    return m.reply(`❌ *aria2c no está corriendo.*`)
  }

  await conn.sendMessage(m.chat, { react: { text: '⏳', key: m.key } })
  const sentMsg = await conn.sendMessage(m.chat, { text: `⏳ *Agregando torrent...*` }, { quoted: m })
  const progressKey = sentMsg.key

  let gid
  try {
    if (magnet) {
      await conn.sendMessage(m.chat, { edit: { key: progressKey, message: `⏳ *Procesando magnet link...*` } }).catch(() => {})
      gid = await addMagnet(magnet)
    } else {
      const src = hasTorrentDoc && m.mimetype ? m : m.quoted
      const buf  = await conn.downloadMediaMessage(src)
      gid = await addTorrentFile(buf)
    }
  } catch (e) {
    await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } })
    await conn.sendMessage(m.chat, { edit: { key: progressKey, message: `❌ Error: ${e.message}` } }).catch(() => {})
    return
  }

  let result
  try {
    result = await runDownload(gid, conn, m, progressKey)
  } catch (e) {
    await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } })
    await conn.sendMessage(m.chat, { edit: { key: progressKey, message: `❌ *Fallo:* ${e.message}` } }).catch(() => {})
    return
  }

  const { files, name } = result
  const toSend   = files.filter(f => fs.existsSync(f) && fs.statSync(f).size <= MAX_WA_SIZE)
  const tooLarge = files.filter(f => fs.existsSync(f) && fs.statSync(f).size > MAX_WA_SIZE)

  await conn.sendMessage(m.chat, { edit: { key: progressKey, message: `✅ *Completo:* ${name}\n📤 Subiendo...` } }).catch(() => {})

  let sent = 0
  for (const fp of toSend) {
    try {
      await sendFile(conn, m.chat, fp, m)
      sent++
    } catch (e) {
      console.error(e)
    } finally {
      try { fs.unlinkSync(fp) } catch {}
    }
  }

  if (tooLarge.length > 0) {
    const lista = tooLarge.map(f => `• \`${path.basename(f)}\` (${fmtBytes(fs.statSync(f).size)})`).join('\n')
    await conn.sendMessage(m.chat, { text: `⚠️ *Archivos grandes:*\n\n${lista}` }, { quoted: m })
  }

  if (sent > 0) {
    await conn.sendMessage(m.chat, { react: { text: '✅', key: m.key } })
    await conn.sendMessage(m.chat, { delete: progressKey }).catch(() => {})
  }
}

handler.before = async (m) => {
  if (/^cancelar$/i.test(m.text?.trim())) {
    for (const [gid, task] of tasks.entries()) {
      if (task.chat === m.chat) {
        task.cancelled = true
        await m.reply('✅ Cancelando...').catch(() => {})
        return true
      }
    }
  }
  return false
}

handler.help        = ['torrent']
handler.tags        = ['downloader']
handler.command     = ['torrent', 'bt', 'tcancel']

export default handler

