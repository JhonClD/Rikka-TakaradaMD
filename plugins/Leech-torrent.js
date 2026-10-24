import { spawn } from 'node:child_process'
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

const ARIA2_BIN = process.env.ARIA2_BIN || 'aria2c'
const DL_DIR = process.env.LEECH_DIR || `${process.env.HOME}/leech_downloads`
const MAX_WA_SIZE = 200 * 1024 * 1024
const POLL_MS = 5_000
const DOWNLOAD_TIMEOUT_MS = Number(process.env.LEECH_TIMEOUT_MS || 6 * 60 * 60 * 1000)
const tasks = new Map()
let taskCounter = 0
let trackerCache = null

const fmtBytes = (b = 0) => {
  if (b <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (b >= 1024 && i < 4) { b /= 1024; i++ }
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

const stripAnsi = value => String(value || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')

function parseAria2Line(line) {
  const clean = stripAnsi(line)
  const match = clean.match(/([\d.]+\s*[KMGT]?i?B)\/([\d.]+\s*[KMGT]?i?B)\((\d+)%\)/i)
  if (!match) return null
  const toBytes = value => {
    const m = value.match(/([\d.]+)\s*([KMGT]?i?B)/i)
    if (!m) return 0
    const units = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 }
    return Math.round(Number(m[1]) * (units[m[2].toUpperCase()] || 1))
  }
  const speed = clean.match(/DL:([\d.]+\s*[KMGT]?i?B)/i)
  const seeds = clean.match(/(?:SEED|SD):\s*(\d+)/i)
  const peers = clean.match(/(?:PEER|CN):\s*(\d+)/i)
  return {
    current: toBytes(match[1]),
    total: toBytes(match[2]),
    speed: speed ? toBytes(speed[1]) : 0,
    seeds: seeds ? Number(seeds[1]) : 0,
    peers: peers ? Number(peers[1]) : 0,
  }
}

async function getTrackers() {
  if (trackerCache !== null) return trackerCache
  try {
    const response = await fetch('https://cf.trackerslist.com/best_aria2.txt', {
      signal: AbortSignal.timeout(5_000),
      headers: { 'user-agent': 'Rikka-TakaradaMD-Torrent/1.0' },
    })
    const text = await response.text()
    trackerCache = text.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .join(',')
  } catch {
    trackerCache = ''
  }
  return trackerCache
}

function buildAria2Args(source, jobDir, trackers) {
  const args = [
    '--dir', jobDir,
    '--continue=true',
    '--seed-time=0',
    '--follow-torrent=true',
    '--bt-enable-lpd=true',
    '--enable-peer-exchange=true',
    '--enable-dht=true',
    '--max-connection-per-server=16',
    '--split=16',
    '--min-split-size=1M',
    '--bt-max-peers=100',
    '--max-tries=5',
    '--retry-wait=3',
    '--connect-timeout=10',
    '--timeout=30',
    '--summary-interval=1',
    '--console-log-level=notice',
    '--show-console-readout=true',
    '--file-allocation=none',
  ]
  if (trackers) args.push(`--bt-tracker=${trackers}`)
  args.push(source)
  return args
}

function listFiles(root) {
  const result = []
  const visit = dir => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (!entry.name.endsWith('.aria2') && !entry.name.endsWith('.torrent')) result.push(full)
    }
  }
  visit(root)
  return result.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)
}

function checkAria2() {
  return new Promise(resolve => {
    const child = spawn(ARIA2_BIN, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] })
    child.once('error', () => resolve(false))
    child.once('close', code => resolve(code === 0))
  })
}

function buildProgressMsg(st, torrentName, taskId, startedAt, stage = 'Descargando') {
  const total = Number(st.total || 0)
  const done = Number(st.current || 0)
  const speed = Number(st.speed || 0)
  const seeders = st.seeds ?? '—'
  const peers = st.peers ?? '—'
  const pct = total > 0 ? (done / total) * 100 : 0
  const eta = speed > 0 && total > done ? (total - done) / speed : 0
  const name = torrentName || 'Cargando metadata...'
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  return `🌀 *Descargando Torrent*\n\n` +
    `📁 *${name}*\n\n` +
    `${pBar(pct)}\n\n` +
    `💾 ${fmtBytes(done)} / ${fmtBytes(total)}\n` +
    `⚡ ${fmtBytes(speed)}/s   ⏳ ${fmtTime(eta)}\n` +
    `📌 *Estado:* ${stage} · Cola: directa\n` +
    `🌱 Seeders: ${seeders}   👥 Peers: ${peers}\n` +
    `⏱️ Tiempo: ${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, '0')}s\n\n` +
    `_Cancelar:_ \`cancelar\` · ID \`${taskId}\``
}

async function runDownload(source, conn, m, progressKey, torrentName, jobDir) {
  const taskId = `T${String(++taskCounter).padStart(4, '0')}`
  const startedAt = Date.now()
  const task = { cancelled: false, child: null, chat: m.chat, taskId }
  tasks.set(taskId, task)
  const trackers = await getTrackers()
  const args = buildAria2Args(source, jobDir, trackers)

  return new Promise((resolve, reject) => {
    const child = spawn(ARIA2_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    task.child = child
    let lastUpdate = 0
    let tail = ''
    let lastStatus = { current: 0, total: 0, speed: 0, seeds: 0, peers: 0 }
    const emit = async stage => {
      const now = Date.now()
      if (stage === 'Descargando' && now - lastUpdate < POLL_MS) return
      lastUpdate = now
      await conn.sendMessage(m.chat, {
        edit: { key: progressKey, message: buildProgressMsg(lastStatus, torrentName, taskId, startedAt, stage) },
      }).catch(() => {})
    }
    const onLine = line => {
      tail = `${tail}\n${line}`.slice(-4000)
      const parsed = parseAria2Line(line)
      if (parsed) {
        lastStatus = parsed
        void emit('Descargando')
      }
    }
    child.stdout.on('data', chunk => String(chunk).split(/\r?\n/).forEach(onLine))
    child.stderr.on('data', chunk => String(chunk).split(/\r?\n/).forEach(onLine))
    const timeout = setTimeout(() => {
      task.cancelled = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, DOWNLOAD_TIMEOUT_MS)
    child.once('error', error => {
      clearTimeout(timeout)
      tasks.delete(taskId)
      reject(new Error(`No se pudo iniciar aria2c (${ARIA2_BIN}): ${error.message}`))
    })
    child.once('close', code => {
      clearTimeout(timeout)
      tasks.delete(taskId)
      if (task.cancelled) return reject(new Error('Cancelado'))
      if (code !== 0) return reject(new Error(tail.trim().slice(-1200) || `aria2c terminó con código ${code}`))
      resolve({ files: listFiles(jobDir), name: torrentName, taskId })
    })
  })
}

async function sendFile(conn, chat, filePath, m) {
  const name = path.basename(filePath)
  const size = fs.statSync(filePath).size
  const ext = name.split('.').pop().toLowerCase()
  const cap = `📁 *${name}*\n📦 ${fmtBytes(size)}`
  if (/mp4|mkv|webm|mov|avi/.test(ext)) {
    await conn.sendMessage(chat, { video: { url: filePath }, caption: cap, mimetype: 'video/mp4', fileName: name }, { quoted: m })
  } else if (/mp3|m4a|flac|wav|ogg|aac/.test(ext)) {
    await conn.sendMessage(chat, { audio: { url: filePath }, mimetype: 'audio/mpeg', ptt: false, fileName: name }, { quoted: m })
  } else {
    await conn.sendMessage(chat, { document: { url: filePath }, mimetype: 'application/octet-stream', fileName: name, caption: cap }, { quoted: m })
  }
}

const handler = async (m, { conn, text, args, command }) => {
  if (command === 'tcancel') {
    let n = 0
    for (const [taskId, task] of tasks.entries()) {
      if (task.chat === m.chat) {
        task.cancelled = true
        task.child?.kill('SIGTERM')
        n++
      }
    }
    return m.reply(n ? `✅ Cancelando ${n} descarga(s)...` : '❌ No hay descargas activas en este chat.')
  }

  const input = (text || args?.join(' ') || '').trim()
  const magnet = input.match(/(magnet:\?[^\s]+)/)?.[1] || m.quoted?.text?.match(/(magnet:\?[^\s]+)/)?.[1] || null
  const torrentUrl = /^https?:\/\/\S+\.torrent(?:\?\S*)?$/i.test(input) ? input : null
  const hasTorrentDoc = m.mimetype === 'application/x-bittorrent' || m.quoted?.mimetype === 'application/x-bittorrent' || m.filename?.toLowerCase().endsWith('.torrent') || m.quoted?.filename?.toLowerCase().endsWith('.torrent')

  if (!magnet && !torrentUrl && !hasTorrentDoc) {
    return m.reply(`🌀 *Descargador de Torrents*\n\n*Uso:*\n• \.torrent magnet:?xt=...\n• \.torrent https://servidor/archivo.torrent\n• Envía o responde a un \.torrent\n\n*Cancelar:* \.tcancel`)
  }
  if (!await checkAria2()) return m.reply(`❌ *aria2c no está disponible en PATH.*\nConfigura ARIA2_BIN o instala aria2c.`)

  await conn.sendMessage(m.chat, { react: { text: '⏳', key: m.key } })
  const sentMsg = await conn.sendMessage(m.chat, { text: '⏳ *Preparando descarga torrent...*' }, { quoted: m })
  const progressKey = sentMsg.key
  const jobDir = path.join(DL_DIR, `torrent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(jobDir, { recursive: true })
  let source = magnet || torrentUrl
  let temporaryTorrent = null
  try {
    if (!source) {
      const src = hasTorrentDoc && m.mimetype ? m : m.quoted
      const buf = await conn.downloadMediaMessage(src)
      temporaryTorrent = path.join(jobDir, 'source.torrent')
      fs.writeFileSync(temporaryTorrent, buf)
      source = temporaryTorrent
    }
    await conn.sendMessage(m.chat, { edit: { key: progressKey, message: '⏳ *Iniciando aria2c...*' } }).catch(() => {})
    const result = await runDownload(source, conn, m, progressKey, 'Cargando metadata...', jobDir)
    const { files, name } = result
    const toSend = files.filter(file => fs.existsSync(file) && fs.statSync(file).size <= MAX_WA_SIZE)
    const tooLarge = files.filter(file => fs.existsSync(file) && fs.statSync(file).size > MAX_WA_SIZE)
    await conn.sendMessage(m.chat, { edit: { key: progressKey, message: `✅ *Completo:* ${name || 'Torrent'}\n📤 Subiendo...` } }).catch(() => {})
    let sent = 0
    for (const file of toSend) {
      try { await sendFile(conn, m.chat, file, m); sent++ } catch (error) { console.error(error) }
    }
    if (tooLarge.length) {
      const list = tooLarge.map(file => `• \`${path.basename(file)}\` (${fmtBytes(fs.statSync(file).size)})`).join('\n')
      await conn.sendMessage(m.chat, { text: `⚠️ *Archivos grandes (>200 MB):*\n\n${list}` }, { quoted: m })
    }
    if (sent > 0) {
      await conn.sendMessage(m.chat, { react: { text: '✅', key: m.key } })
      await conn.sendMessage(m.chat, { delete: progressKey }).catch(() => {})
    }
  } catch (error) {
    await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {})
    await conn.sendMessage(m.chat, { edit: { key: progressKey, message: `❌ *Fallo:* ${String(error.message || error).slice(-1500)}` } }).catch(() => {})
  } finally {
    if (temporaryTorrent) fs.rmSync(temporaryTorrent, { force: true })
    fs.rmSync(jobDir, { recursive: true, force: true })
  }
}

handler.before = async m => {
  if (/^cancelar$/i.test(m.text?.trim())) {
    for (const task of tasks.values()) {
      if (task.chat === m.chat) {
        task.cancelled = true
        task.child?.kill('SIGTERM')
        await m.reply('✅ Cancelando...').catch(() => {})
        return true
      }
    }
  }
  return false
}

handler.help = ['torrent']
handler.tags = ['downloader']
handler.command = ['torrent', 'bt', 'tcancel']

export default handler
