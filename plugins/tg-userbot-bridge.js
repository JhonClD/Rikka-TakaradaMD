/**
 * tg-userbot-bridge.js — Puente Telegram (Userbot) → WhatsApp
 * ─────────────────────────────────────────────────────────────
 * Usa TU PROPIA CUENTA de Telegram (no un bot) para leer canales
 * sin necesitar ser administrador.
 *
 * Librería: gramjs  →  npm install telegram
 *
 * Config en .env:
 *   TG_API_ID          — Número de my.telegram.org/apps
 *   TG_API_HASH        — Hash de my.telegram.org/apps
 *   TG_PHONE           — Tu número de Telegram (ej: +51925092348)
 *   TG_CHANNELS        — IDs o usernames separados por coma
 *                        Ej: durov,-1001234567890,animenews_es
 *   WA_TARGET_JID      — JID del grupo WhatsApp destino (ej: 120363XXX@g.us)
 *   TG_BRIDGE_PREFIX   — (opcional) Default: "📡 *Telegram*"
 *   TG_SHOW_SENDER     — (opcional) true | false. Default: true
 *   TG_SESSION_FILE    — (opcional) Ruta del archivo de sesión. Default: tmp/tg-session.json
 *
 * Primera ejecución: el bot te pedirá el código de verificación
 * de Telegram en la terminal. Solo ocurre una vez.
 */

import { TelegramClient } from 'telegram'
import { StringSession }  from 'telegram/sessions/index.js'
import { NewMessage }     from 'telegram/events/index.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import readline from 'readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DIR   = join(__dirname, '../tmp')
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true })

// ─── Configuración desde .env ─────────────────────────────────────────────────
const API_ID       = parseInt(process.env.TG_API_ID   || '0', 10)
const API_HASH     = process.env.TG_API_HASH           || ''
const PHONE        = process.env.TG_PHONE              || ''
const WA_JID       = process.env.WA_TARGET_JID         || ''
const PREFIX       = process.env.TG_BRIDGE_PREFIX      ?? '📡 *Telegram*'
const SHOW_SENDER  = (process.env.TG_SHOW_SENDER       ?? 'true') === 'true'
const SESSION_FILE = process.env.TG_SESSION_FILE       || join(TMP_DIR, 'tg-session.json')

// Canales a escuchar: acepta usernames (@canal) e IDs numéricos
const RAW_CHANNELS = (process.env.TG_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean)

// ─── Sesión persistente ───────────────────────────────────────────────────────
function loadSession() {
  try {
    if (existsSync(SESSION_FILE)) {
      const { session } = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'))
      return session || ''
    }
  } catch { /* primera vez */ }
  return ''
}

function saveSession(sessionStr) {
  writeFileSync(SESSION_FILE, JSON.stringify({ session: sessionStr }, null, 2), 'utf-8')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const delay    = ms => new Promise(r => setTimeout(r, ms))
function getConn() { return global.conn || null }

/** Pregunta en terminal (para el código de verificación en primera ejecución) */
function preguntarEnTerminal(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ─── Descarga de media desde GramJS ──────────────────────────────────────────
/**
 * Descarga el archivo adjunto de un mensaje de Telegram.
 * @returns {Promise<{buffer: Buffer, mimeType: string, fileName: string} | null>}
 */
async function downloadMedia(client, message) {
  try {
    const buffer = await client.downloadMedia(message, { workers: 1 })
    if (!buffer || buffer.length === 0) return null

    // Extraer mimeType y nombre del archivo del objeto media
    let mimeType = 'application/octet-stream'
    let fileName = 'archivo'

    const media = message.media
    if (media?.photo) {
      mimeType = 'image/jpeg'
      fileName = 'foto.jpg'
    } else if (media?.document) {
      const doc  = media.document
      mimeType   = doc.mimeType || mimeType
      const attr = doc.attributes?.find(a => a.fileName)
      fileName   = attr?.fileName || `archivo.${mimeType.split('/')[1] || 'bin'}`
    }

    return { buffer: Buffer.from(buffer), mimeType, fileName }
  } catch (err) {
    console.error('[TG-Userbot] ❌ Error descargando media:', err.message)
    return null
  }
}

// ─── Envío a WhatsApp ─────────────────────────────────────────────────────────
async function enviarMensaje(conn, text, media = null, mediaType = null, meta = {}) {
  if (!WA_JID) return

  if (!media || !mediaType) {
    if (text) await conn.sendMessage(WA_JID, { text })
    return
  }

  if (mediaType === 'image') {
    const payload = { image: media }
    if (text) payload.caption = text
    await conn.sendMessage(WA_JID, payload)
    return
  }

  if (mediaType === 'video') {
    const payload = { video: media, mimetype: meta.mimeType || 'video/mp4', fileName: meta.fileName || 'video.mp4' }
    if (text) payload.caption = text
    await conn.sendMessage(WA_JID, payload)
    return
  }

  if (mediaType === 'audio') {
    await conn.sendMessage(WA_JID, {
      audio    : media,
      mimetype : meta.mimeType || 'audio/ogg; codecs=opus',
      ptt      : meta.ptt || false,
    })
    if (text) await conn.sendMessage(WA_JID, { text })
    return
  }

  if (mediaType === 'document') {
    const payload = {
      document : media,
      mimetype : meta.mimeType || 'application/octet-stream',
      fileName : meta.fileName || 'archivo',
    }
    if (text) payload.caption = text
    await conn.sendMessage(WA_JID, payload)
    return
  }
}

// ─── Determinar tipo de media ─────────────────────────────────────────────────
function getMediaType(message) {
  const media = message.media
  if (!media) return null

  if (media.photo)    return 'image'

  if (media.document) {
    const mime = media.document.mimeType || ''
    if (mime.startsWith('video/'))  return 'video'
    if (mime.startsWith('audio/'))  return 'audio'
    if (mime === 'video/mp4')       return 'video'
    return 'document'
  }

  return null
}

// ─── Construir encabezado ─────────────────────────────────────────────────────
function buildHeader(senderStr, channelName) {
  const parts = [PREFIX]
  if (channelName) parts.push(`📢 ${channelName}`)
  if (SHOW_SENDER && senderStr && senderStr !== channelName) parts.push(`👤 ${senderStr}`)
  return parts.join(' | ') + '\n\n'
}

// ─── Procesar mensaje entrante ────────────────────────────────────────────────
async function procesarMensaje(client, event) {
  const message = event.message
  if (!message) return

  const conn = getConn()
  if (!conn) {
    console.warn('[TG-Userbot] ⚠️  global.conn no disponible, mensaje descartado')
    return
  }

  try {
    // Obtener nombre del canal/chat
    let channelName = ''
    try {
      const chat = await message.getChat()
      channelName = chat?.title || chat?.username || ''
    } catch { /* no crítico */ }

    // Obtener nombre del remitente (si no es canal anónimo)
    let senderStr = ''
    try {
      const sender = await message.getSender()
      if (sender) {
        const parts = [sender.firstName, sender.lastName].filter(Boolean)
        senderStr   = parts.length ? parts.join(' ') : (sender.username ? `@${sender.username}` : '')
      }
    } catch { /* canales no tienen sender individual */ }

    const header    = buildHeader(senderStr, channelName)
    const texto     = message.text || message.caption || ''
    const mediaType = getMediaType(message)

    // ── Solo texto ──
    if (!mediaType) {
      if (texto) await enviarMensaje(conn, header + texto)
      return
    }

    // ── Con media ──
    const mediaData = await downloadMedia(client, message)
    if (!mediaData) {
      // Si falla la descarga, al menos enviar el texto
      if (texto) await enviarMensaje(conn, header + texto)
      return
    }

    const { buffer, mimeType, fileName } = mediaData
    const caption = (header + texto).trim() || null

    await enviarMensaje(conn, caption, buffer, mediaType, { mimeType, fileName })

  } catch (err) {
    console.error('[TG-Userbot] ❌ Error procesando mensaje:', err.message)
  }
}

// ─── Inicio del userbot ───────────────────────────────────────────────────────
let _client = null

async function iniciarUserbot() {
  if (!API_ID || !API_HASH) {
    console.warn('[TG-Userbot] ⚠️  TG_API_ID / TG_API_HASH no definidos en .env — puente inactivo')
    return
  }
  if (!PHONE) {
    console.warn('[TG-Userbot] ⚠️  TG_PHONE no definido en .env — puente inactivo')
    return
  }
  if (!WA_JID) {
    console.warn('[TG-Userbot] ⚠️  WA_TARGET_JID no definido en .env — puente inactivo')
    return
  }
  if (RAW_CHANNELS.length === 0) {
    console.warn('[TG-Userbot] ⚠️  TG_CHANNELS vacío — no hay canales que escuchar')
    return
  }

  const sessionStr = loadSession()
  const session    = new StringSession(sessionStr)

  _client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries : 10,
    retryDelay        : 2000,
    autoReconnect     : true,
    // Silenciar logs internos de GramJS
    baseLogger        : { levels: [], log: () => {} },
  })

  try {
    await _client.start({
      phoneNumber    : async () => PHONE,
      // Primera vez: Telegram te manda un código a tu cuenta
      phoneCode      : async () => {
        console.log('\n[TG-Userbot] 📲 Telegram envió un código a tu cuenta.')
        return await preguntarEnTerminal('[TG-Userbot] ► Ingresa el código de verificación: ')
      },
      // Si tienes contraseña de dos pasos activada
      password       : async () => {
        console.log('[TG-Userbot] 🔐 Se requiere contraseña de dos pasos.')
        return await preguntarEnTerminal('[TG-Userbot] ► Contraseña 2FA: ')
      },
      onError        : (err) => console.error('[TG-Userbot] ❌ Error de inicio:', err.message),
    })

    // Guardar sesión para no volver a pedir el código
    const newSession = _client.session.save()
    saveSession(newSession)

    const me = await _client.getMe()
    console.log(`[TG-Userbot] ✅ Conectado como ${me.firstName} (@${me.username || me.phone})`)
    console.log(`[TG-Userbot] 📢 Canales escuchados: ${RAW_CHANNELS.join(', ')}`)
    console.log(`[TG-Userbot] 📤 WA destino: ${WA_JID}`)

    // ── Resolver IDs numéricos de los canales configurados ──
    const resolvedIds = new Set()
    for (const ch of RAW_CHANNELS) {
      try {
        const entity = await _client.getEntity(isNaN(ch) ? ch : BigInt(ch))
        resolvedIds.add(entity.id.toString())
        console.log(`[TG-Userbot] ✓ Canal resuelto: ${entity.title || entity.username} (${entity.id})`)
      } catch (err) {
        console.warn(`[TG-Userbot] ⚠️  No se pudo resolver canal "${ch}": ${err.message}`)
      }
    }

    // ── Suscribirse a nuevos mensajes ──
    _client.addEventHandler(async (event) => {
      try {
        const chat   = await event.message?.getChat()
        const chatId = chat?.id?.toString()
        // Filtrar: solo procesar mensajes de los canales configurados
        if (!chatId || !resolvedIds.has(chatId)) return
        await procesarMensaje(_client, event)
      } catch { /* ignorar errores de resolución */ }
    }, new NewMessage({}))

  } catch (err) {
    console.error('[TG-Userbot] ❌ Error fatal al iniciar:', err.message)
  }
}

// ─── Handler de WhatsApp (comando .tgstatus) ──────────────────────────────────
let handler = async (m, { conn, command }) => {
  if (command === 'tgstatus') {
    const activo = _client !== null && _client.connected
    const texto  = activo
      ? `✅ *Puente TG→WA activo* (Userbot)\n📢 Canales: \`${RAW_CHANNELS.join(', ')}\`\n📤 WA destino: \`${WA_JID}\``
      : '❌ *Puente inactivo* — revisa TG_API_ID, TG_API_HASH y TG_PHONE en .env'
    await conn.sendMessage(m.chat, { text: texto }, { quoted: m })
  }
}

handler.help    = ['tgstatus']
handler.tags    = ['bridge']
handler.command = /^(tgstatus)$/i

// ─── Auto-arranque ────────────────────────────────────────────────────────────
;(async () => {
  await delay(4000)   // esperar que Baileys conecte primero
  await iniciarUserbot()
})()

export default handler
