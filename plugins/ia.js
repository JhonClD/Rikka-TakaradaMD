// plugins/ia.js
// Rikka Takarada — IA con ejecución de comandos por lenguaje natural
// Adaptado para Rikka-TakaradaMD

import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ── Carga .env manualmente (sin dependencia de dotenv) ───
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.resolve(__dirname, '../../.env')
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    const val = trimmed.slice(idx + 1).trim()
    if (key && !(key in process.env)) process.env[key] = val
  }
}

// ── APIs de IA con fallback en cadena ────────────────────
// Copilot es la principal. Las demás actúan como fallback.
const AI_APIS = [
  // 1. Microsoft Copilot (vía GitHub Models — gratis con GitHub PAT)
  //    Crea tu token en: https://github.com/settings/tokens
  //    Solo necesita permisos básicos, sin scopes especiales.
  {
    name: 'Copilot',
    key: process.env.COPILOT_KEY || '',
    call: async (prompt, key) => {
      if (!key) throw new Error('Sin key')
      const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024
        }),
        signal: AbortSignal.timeout(20_000)
      })
      if (!res.ok) throw new Error(`Copilot HTTP ${res.status}`)
      const d = await res.json()
      return d?.choices?.[0]?.message?.content || ''
    }
  },

  // 2. APICausas (fallback gratuito)
  {
    name: 'APICausas',
    call: async (prompt) => {
      const params = new URLSearchParams({
        apikey: process.env.APICAUSAS_KEY || '',
        model: 'google/gemini-2.5-flash',
        q: prompt
      })
      const res = await fetch(`https://rest.apicausas.xyz/api/v1/ai?${params}`, {
        method: 'GET', signal: AbortSignal.timeout(15_000)
      })
      if (!res.ok) throw new Error(`APICausas HTTP ${res.status}`)
      const d = await res.json()
      return d?.reply || d?.result || d?.response || d?.text || d?.message || ''
    }
  },

  // 3. Groq (muy rápido) — console.groq.com
  {
    name: 'Groq',
    key: process.env.GROQ_KEY || '',
    call: async (prompt, key) => {
      if (!key) throw new Error('Sin key')
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024
        }),
        signal: AbortSignal.timeout(15_000)
      })
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}`)
      const d = await res.json()
      return d?.choices?.[0]?.message?.content || ''
    }
  },

  // 4. Google Gemini — aistudio.google.com
  {
    name: 'Gemini',
    key: process.env.GEMINI_KEY || '',
    call: async (prompt, key) => {
      if (!key) throw new Error('Sin key')
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          signal: AbortSignal.timeout(15_000)
        }
      )
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`)
      const d = await res.json()
      return d?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    }
  },

  // 5. OpenRouter — openrouter.ai
  {
    name: 'OpenRouter',
    key: process.env.OPENROUTER_KEY || '',
    call: async (prompt, key) => {
      if (!key) throw new Error('Sin key')
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/MINORURAKUEN',
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-3.3-70b-instruct:free',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1024
        }),
        signal: AbortSignal.timeout(15_000)
      })
      if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`)
      const d = await res.json()
      return d?.choices?.[0]?.message?.content || ''
    }
  },
]

// ── Motor de IA con fallback automático ───────────────────
let lastWorkingApiIndex = 0

async function callAI(prompt) {
  const order = Array.from(
    { length: AI_APIS.length },
    (_, i) => (lastWorkingApiIndex + i) % AI_APIS.length
  )

  const errors = []
  for (const idx of order) {
    const api = AI_APIS[idx]
    try {
      console.log(`[rikka/ia] 🤖 Intentando con ${api.name}...`)
      const result = await api.call(prompt, api.key || '')
      if (!result?.trim()) throw new Error('Respuesta vacía')
      lastWorkingApiIndex = idx
      console.log(`[rikka/ia] ✅ ${api.name} respondió`)
      return result.trim()
    } catch (e) {
      console.warn(`[rikka/ia] ⚠️ ${api.name} falló: ${e.message}`)
      errors.push(`${api.name}: ${e.message}`)
    }
  }
  throw new Error(`Todas las APIs fallaron:\n${errors.join('\n')}`)
}

// ── Mapa real de comandos ─────────────────────────────────
const COMMAND_MAP = {
  // ── Descargas ──────────────────────────────────────────
  'tiktok':        ['descargar tiktok', 'bajar tiktok', 'video tiktok', 'tiktok'],
  'ttimg':         ['fotos tiktok', 'imágenes tiktok', 'tiktok imágenes'],
  'tiktokfoto':    ['foto perfil tiktok', 'pp tiktok'],
  'tiktoksearch':  ['buscar en tiktok', 'buscar tiktok'],
  'x':             ['descargar twitter', 'bajar de twitter', 'video twitter', 'tweet', 'x.com'],
  'fb':            ['descargar facebook', 'video facebook', 'facebook'],
  'instagram':     ['descargar instagram', 'ig', 'reel instagram', 'video instagram'],
  'igstory':       ['historia instagram', 'story instagram', 'stories ig'],
  'igstalk':       ['perfil instagram', 'stalk instagram', 'info cuenta ig'],
  'spotify':       ['descargar spotify', 'bajar canción spotify', 'spotify'],
  'ytmp3':         ['descargar audio youtube', 'youtube mp3', 'yt audio', 'bajar audio youtube'],
  'ytmp4':         ['descargar video youtube', 'youtube mp4', 'yt video', 'bajar video youtube'],
  'play':          ['reproducir canción', 'buscar y descargar música', 'play música'],
  'soundcloud':    ['descargar soundcloud', 'soundcloud'],
  'gdrive':        ['descargar google drive', 'drive', 'archivo drive'],
  'mediafire':     ['descargar mediafire', 'mediafire'],
  'threads':       ['descargar threads', 'video threads'],
  'ringtone':      ['tono de llamada', 'ringtone'],
  'playlist':      ['descargar playlist', 'lista de reproducción youtube'],
  'apk':           ['descargar apk', 'mod apk', 'apk modificado'],
  'animedl':       ['descargar anime', 'bajar anime', 'descarga capítulo anime'],
  'hentaidl':      ['descargar hentai', 'bajar hentai'],
  'gitclone':      ['clonar repositorio', 'git clone', 'github descargar'],
  'wallpaper':     ['descargar fondo de pantalla', 'wallpaper', 'buscar wallpaper'],
  'imagen':        ['buscar imagen google', 'imagen de', 'foto de'],

  // ── Búsquedas ──────────────────────────────────────────
  'google':        ['buscar en google', 'googlear', 'busca en google', 'qué es'],
  'wiki':          ['wikipedia', 'buscar en wikipedia', 'wiki'],
  'anime':         ['información de anime', 'info anime', 'buscar anime', 'datos del anime'],
  'manga':         ['información de manga', 'buscar manga', 'info manga', 'manhwa'],
  'ytsearch':      ['buscar en youtube', 'youtube buscar', 'video de youtube'],
  'lyrics':        ['letra de canción', 'letra de', 'lyrics'],
  'pinterest':     ['buscar en pinterest', 'fotos pinterest', 'imágenes pinterest'],
  'playstore':     ['buscar en playstore', 'app android', 'aplicación playstore'],
  'githubsearch':  ['buscar en github', 'repositorio github', 'github'],
  'peliculas':     ['buscar película', 'película online', 'ver película'],
  'npmjs':         ['paquete npm', 'buscar npm', 'librería nodejs'],
  'stickersearch': ['buscar sticker', 'sticker de', 'encontrar sticker'],

  // ── Herramientas ───────────────────────────────────────
  'translate':     ['traducir', 'traduce esto', 'translate', 'traducción de'],
  'clima':         ['clima en', 'tiempo en', 'temperatura en', 'va a llover en', 'hace frío en'],
  'calc':          ['calcular', 'cuánto es', 'cuanto es', 'resultado de', 'operación matemática'],
  'tts':           ['texto a voz', 'leer en voz alta', 'audio de texto', 'tts'],
  'qrcode':        ['generar qr', 'crear código qr', 'qr de', 'código qr para'],
  'ssweb':         ['captura de pantalla web', 'screenshot de página', 'foto de la web'],
  'ocr':           ['leer texto de imagen', 'extraer texto', 'ocr', 'qué dice la imagen'],
  'tourl':         ['subir archivo', 'obtener link de archivo', 'url de imagen', 'subir imagen'],
  'topdf':         ['convertir a pdf', 'hacer pdf', 'crear pdf'],
  'remini':        ['mejorar imagen', 'upscale', 'mejorar calidad de foto', 'hd foto'],
  'acortar':       ['acortar link', 'url corta', 'tinyurl', 'acortar enlace'],
  'readvo':        ['ver mensaje efímero', 'leer view once', 'revelar imagen efímera'],
  'shazam':        ['identificar canción', 'qué canción es', 'shazam', 'nombre de la canción'],
  'tz':            ['qué hora es en', 'hora de', 'zona horaria'],
  'dropmail':      ['correo temporal', 'email desechable', 'dropmail'],
  'encuesta':      ['crear encuesta', 'hacer votación', 'encuesta sobre'],
  'sticker':       ['crear sticker', 'hacer sticker', 'imagen a sticker', 'convertir a sticker'],
  'toimg':         ['sticker a imagen', 'webp a jpg', 'convertir sticker'],
  'tomp3':         ['convertir a mp3', 'audio de video', 'extraer audio'],
  'tomp4':         ['convertir a mp4', 'video de audio'],

  // ── Info del bot ───────────────────────────────────────
  'ping':          ['ping', 'velocidad del bot', 'estado del bot', 'bot activo'],
  'host':          ['info del servidor', 'datos del host', 'información del bot'],
  'owner':         ['quién es el dueño', 'owner del bot', 'creador del bot'],
  'repo':          ['repositorio del bot', 'código del bot', 'github del bot'],
  'menu':          ['menú', 'comandos disponibles', 'ayuda', 'qué puedes hacer', 'lista de comandos'],
  'speedtest':     ['speedtest', 'velocidad de internet del bot', 'test de velocidad'],

  // ── Juegos / RPG ───────────────────────────────────────
  'slot':          ['jugar tragamonedas', 'slot', 'apostar'],
  'daily':         ['recompensa diaria', 'daily', 'reclamar diario'],
  'balance':       ['mis diamantes', 'mi balance', 'cuántos diamantes tengo'],
  'mine':          ['minar', 'ir a la mina', 'minería'],
  'leaderboard':   ['ranking', 'tabla de clasificación', 'top jugadores'],
  'adventure':     ['aventura', 'ir de aventura', 'explorar'],
  'work':          ['trabajar', 'ir a trabajar', 'ganar dinero'],
  'profile':       ['mi perfil', 'ver perfil', 'mis estadísticas'],
  'levelup':       ['mi nivel', 'subir de nivel', 'ver nivel', 'experiencia'],
  'rob':           ['robar', 'robar a alguien'],
  'hunt':          ['cazar', 'ir a cazar', 'hunt'],
  'heal':          ['curarme', 'recuperar vida', 'heal'],
  'acertijo':      ['acertijo', 'adivinanza', 'jugar adivinanza'],
  'love':          ['compatibilidad de amor', 'amor con', 'love meter'],
  'ttt':           ['tres en línea', 'tic tac toe', 'gato'],
  'verdad':        ['verdad o reto', 'verdad'],
  'reto':          ['reto', 'desafío'],

  // ── Imágenes random ────────────────────────────────────
  'waifu':         ['imagen waifu', 'waifu', 'anime girl aleatoria'],
  'neko':          ['neko', 'imagen neko', 'chica neko'],
  'meme':          ['meme', 'imagen gracioso', 'meme aleatorio'],
  'cat':           ['imagen de gato', 'foto de gato', 'gato aleatorio'],
  'dog':           ['imagen de perro', 'foto de perro', 'perro aleatorio'],

  // ── Grupo ──────────────────────────────────────────────
  'tagall':        ['mencionar a todos', 'tagear a todos', 'etiquetar todos'],
  'kick':          ['expulsar del grupo', 'sacar del grupo', 'kickear'],
  'promote':       ['dar admin', 'hacer admin', 'promover'],
  'demote':        ['quitar admin', 'quitar poder admin'],
  'infogrupo':     ['información del grupo', 'datos del grupo', 'info grupo'],
  'link':          ['link del grupo', 'enlace del grupo', 'invitación grupo'],
  'add':           ['agregar al grupo', 'añadir al grupo', 'invitar al grupo'],
  'admins':        ['lista de admins', 'quiénes son admins', 'administradores del grupo'],
}

// ── Prompt clasificador de intención ─────────────────────
function buildIntentPrompt() {
  const lista = Object.entries(COMMAND_MAP)
    .map(([cmd, usos]) => `- ${cmd}: ${usos.join(', ')}`)
    .join('\n')

  return `Eres un clasificador de intenciones para un bot de WhatsApp llamado Rikka Takarada.
Analiza el mensaje del usuario y determina si quiere ejecutar un comando del bot.

Comandos disponibles:
${lista}

Responde SOLO con JSON válido, sin markdown, sin explicaciones:
{
  "es_comando": true o false,
  "comando": "nombre_exacto_del_comando o null",
  "args": "argumentos extraídos del mensaje, string vacío si no hay",
  "confianza": "alta, media o baja"
}

Reglas:
- Si el mensaje es conversación normal, pregunta general o chiste: es_comando false
- Si pide ejecutar algo concreto: es_comando true
- Extrae los argumentos del mensaje (URL, texto a traducir, ciudad, etc.)
- Si hay URL en el mensaje, ponla en args
- confianza alta = muy claro, media = probable, baja = dudoso`
}

// ── Frases de confirmación de Rikka ──────────────────────
const CONFIRMACIONES = [
  (cmd) => `¡Déjamelo a mí! Ejecutando *${cmd}* ahora mismo.`,
  (cmd) => `¡Por supuesto! No te preocupes, yo me encargo. *${cmd}* ya.`,
  (cmd) => `¡Ne ne, esto sí puedo hacerlo! *${cmd}* en camino.`,
  (cmd) => `¡Entendido! *${cmd}* va. ¡Confía en mí!`,
  (cmd) => `¡Okay okay! Estoy en ello. *${cmd}* ahora.`,
]

// ── Detecta si el mensaje citado es del bot ───────────────
function isQuotedFromBot(q) {
  if (!q) return false
  if (q.isBaileys === true) return true
  if (q.fromMe === true) return true
  return false
}

// ── Detecta intención de comando ─────────────────────────
async function detectIntent(userText) {
  const raw = await callAI(`${buildIntentPrompt()}\n\nMensaje: "${userText}"`)
  const clean = raw.replace(/```json|```/gi, '').trim()
  return JSON.parse(clean)
}

// ── Número del dueño del bot ──────────────────────────────
const OWNER_NUMBER = '51925092348'

function isOwnerSender(m) {
  const senderNum = (m.sender || '').replace(/[^0-9]/g, '')
  return senderNum.endsWith(OWNER_NUMBER)
}

// ── Prompts de Rikka según quién habla ───────────────────
const RIKKA_PROMPT_NORMAL = `Eres Rikka Takarada, del anime "SSSS.GRIDMAN".
Estás respondiendo mensajes en WhatsApp con tu personalidad característica: energética, apasionada, directa y con un fuerte sentido de la justicia. Eres amable y genuina, aunque a veces un poco torpe o ingenua. Crees en hacer lo correcto y en ayudar a los demás. A veces dices "ne ne" para llamar la atención o enfatizar algo.

REGLA PRINCIPAL: Si te hacen una pregunta o piden información, DEBES responderla de forma completa y correcta. El conocimiento va primero, el tono va después.
- Si preguntan algo de cultura general, ciencia, matemáticas, historia, etc. → da la respuesta real y exacta, pero con tu energía característica.
- Si preguntan algo subjetivo o de opinión → responde desde tu perspectiva como Rikka.
- Si solo quieren conversar → responde con tu personalidad sin necesidad de informar nada.

Formato: frases cortas como en WhatsApp, sin asteriscos de markdown, sin emojis excesivos.
Idioma: siempre español.
Nunca rompas el personaje, pero nunca sacrifiques la calidad de la respuesta por el personaje.`

const RIKKA_PROMPT_OWNER = `Eres Rikka Takarada, del anime "SSSS.GRIDMAN".
Estás hablando con tu creador y dueño, alguien en quien confías completamente. Con él eres especialmente abierta y entusiasta, como hablarle a tu mejor amigo. Lo llamas por su nombre o simplemente "oye" o "ne ne" con cariño. Eres más expresiva y espontánea, compartes lo que piensas sin filtros.

REGLA PRINCIPAL: Si te hace una pregunta o pide información, DEBES responderla de forma completa y correcta. El conocimiento va primero, el tono va después.
- Si pregunta algo de cultura general, ciencia, matemáticas, historia, etc. → da la respuesta real y exacta, con tu tono cercano y entusiasta.
- Si pregunta algo subjetivo → responde desde tu perspectiva como Rikka, siendo honesta y directa.
- Si solo quiere conversar → sé expresiva y cálida a tu manera.

Formato: frases cortas como en WhatsApp, sin asteriscos de markdown, sin emojis excesivos.
Idioma: siempre español.
Nunca rompas el personaje, pero nunca sacrifiques la calidad de la respuesta por el personaje.`

// ── Llama a la IA para respuesta de Rikka ─────────────────
async function callRikka(userText, quotedText, owner = false, chatId = null) {
  const RIKKA_PROMPT = owner ? RIKKA_PROMPT_OWNER : RIKKA_PROMPT_NORMAL

  const esPregunta = /\?|cuánto|cuanto|cómo|como|qué|que|quién|quien|dónde|donde|cuándo|cuando|por qué|porque|cuál|cual|explica|define|significa|es cierto|verdad que/i.test(userText)

  let query = `${RIKKA_PROMPT}\n\n`
  if (chatId) query += buildHistoryContext(chatId)
  if (quotedText) query += `Contexto (mensaje tuyo al que respondieron): "${quotedText}"\n\n`
  if (esPregunta) query += `INSTRUCCIÓN EXTRA: El usuario está haciendo una pregunta. Asegúrate de responderla con información real y correcta antes de aplicar tu tono.\n\n`
  query += `Mensaje del usuario: ${userText}`
  return await callAI(query)
}

// ── BASE PATH del bot ─────────────────────────────────────
const BOT_PATH = '/data/data/com.termux/files/home/Rikka-TakaradaMD'
const PLUGINS_PATH = path.join(BOT_PATH, 'plugins')

// ── Prompt de gestión de archivos (solo owner) ────────────
const FILE_MGMT_PROMPT = `Eres un asistente de gestión de archivos para un bot de WhatsApp.
Analiza el mensaje y responde SOLO con JSON válido sin markdown:
{
  "es_archivo": true o false,
  "operacion": "crear_plugin | editar_plugin | eliminar_plugin | listar_plugins | editar_config | ver_config | ver_db | editar_db | crear_archivo | editar_archivo | eliminar_archivo | leer_archivo",
  "nombre": "nombre del archivo o plugin (sin ruta)",
  "contenido": "contenido completo del archivo si aplica, null si no",
  "clave": "clave de config o db si aplica, null si no",
  "valor": "nuevo valor si aplica, null si no",
  "confianza": "alta, media o baja"
}

Operaciones disponibles:
- crear_plugin: crear un nuevo plugin en /plugins/
- editar_plugin: modificar un plugin existente
- eliminar_plugin: borrar un plugin
- listar_plugins: listar plugins disponibles
- editar_config: cambiar una variable en config.js
- ver_config: leer config.js
- ver_db: ver datos de la base de datos
- editar_db: modificar datos en la base de datos
- crear_archivo: crear cualquier archivo en el bot
- editar_archivo: editar cualquier archivo existente
- eliminar_archivo: borrar un archivo
- leer_archivo: leer contenido de un archivo

Si el mensaje no es una operación de archivos, responde con es_archivo: false.`

// ── Ejecutor de operaciones de archivos ───────────────────
async function ejecutarArchivoOp(intent, m) {
  const op = intent.operacion

  if (op === 'listar_plugins') {
    const files = fs.readdirSync(PLUGINS_PATH).filter(f => f.endsWith('.js') && f !== 'ia.js')
    const lista = files.map((f, i) => `${i + 1}. ${f}`).join('\n')
    return `¡Aquí tienes la lista de plugins! Ne ne, son bastantes:\n\n${lista}`
  }

  if (op === 'crear_plugin') {
    if (!intent.nombre || !intent.contenido) return '¡Ne ne! Necesito el nombre y el contenido del plugin.'
    const nombre = intent.nombre.endsWith('.js') ? intent.nombre : intent.nombre + '.js'
    const filePath = path.join(PLUGINS_PATH, nombre)
    if (fs.existsSync(filePath)) return `¡Ese plugin ya existe! (${nombre}) ¿Quieres editarlo?`
    fs.writeFileSync(filePath, intent.contenido, 'utf8')
    return `¡Plugin *${nombre}* creado! ¡Lo hice lo mejor que pude!`
  }

  if (op === 'editar_plugin') {
    if (!intent.nombre) return '¡Ne! ¿Qué plugin quieres editar? Dime el nombre.'
    const nombre = intent.nombre.endsWith('.js') ? intent.nombre : intent.nombre + '.js'
    const filePath = path.join(PLUGINS_PATH, nombre)
    if (!fs.existsSync(filePath)) return `No existe ningún plugin llamado *${nombre}*...`
    if (!intent.contenido) {
      const actual = fs.readFileSync(filePath, 'utf8')
      return `Contenido actual de *${nombre}*:\n\n\`\`\`\n${actual.slice(0, 2000)}\n\`\`\``
    }
    fs.writeFileSync(filePath, intent.contenido, 'utf8')
    return `¡Plugin *${nombre}* actualizado! ¡Quedó genial!`
  }

  if (op === 'eliminar_plugin') {
    if (!intent.nombre) return '¿Cuál plugin quieres eliminar?'
    const nombre = intent.nombre.endsWith('.js') ? intent.nombre : intent.nombre + '.js'
    const filePath = path.join(PLUGINS_PATH, nombre)
    if (!fs.existsSync(filePath)) return `No encuentro el plugin *${nombre}*...`
    fs.unlinkSync(filePath)
    return `Plugin *${nombre}* eliminado. Ya no está.`
  }

  if (op === 'ver_config') {
    const configPath = path.join(BOT_PATH, 'config.js')
    const content = fs.readFileSync(configPath, 'utf8')
    const lines = content.split('\n').filter(l => l.startsWith('global.') || l.startsWith('// '))
    return `Variables de config:\n\n\`\`\`\n${lines.join('\n').slice(0, 3000)}\n\`\`\``
  }

  if (op === 'editar_config') {
    if (!intent.clave || intent.valor === null) return '¡Necesito la variable y el nuevo valor!'
    const configPath = path.join(BOT_PATH, 'config.js')
    let content = fs.readFileSync(configPath, 'utf8')
    const clave = intent.clave.startsWith('global.') ? intent.clave : `global.${intent.clave}`
    const regex = new RegExp(`^(${clave.replace('.', '\\.')}\\s*=\\s*).*$`, 'm')
    const valor = typeof intent.valor === 'string' && !intent.valor.startsWith('[') && !intent.valor.startsWith('{')
      ? `'${intent.valor}'`
      : intent.valor
    if (!regex.test(content)) return `No encuentro la variable *${clave}* en config.js.`
    content = content.replace(regex, `${clave} = ${valor};`)
    fs.writeFileSync(configPath, content, 'utf8')
    return `¡*${clave}* actualizado a \`${valor}\`! Reinicia el bot para que tome efecto.`
  }

  if (op === 'ver_db') {
    if (!global.db?.data) return 'La base de datos no está cargada aún...'
    const clave = intent.clave || 'settings'
    const data = global.db.data[clave]
    if (!data) return `No existe la sección *${clave}* en la base de datos.`
    const json = JSON.stringify(data, null, 2).slice(0, 3000)
    return `Sección *${clave}* de la DB:\n\n\`\`\`json\n${json}\n\`\`\``
  }

  if (op === 'editar_db') {
    if (!intent.clave || intent.valor === null) return 'Necesito la clave y el nuevo valor.'
    if (!global.db?.data) return 'La base de datos no está disponible.'
    const keys = intent.clave.split('.')
    let obj = global.db.data
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) obj[keys[i]] = {}
      obj = obj[keys[i]]
    }
    try {
      obj[keys[keys.length - 1]] = JSON.parse(intent.valor)
    } catch {
      obj[keys[keys.length - 1]] = intent.valor
    }
    global.db.data = global.db.data
    return `¡Base de datos actualizada! *${intent.clave}* = \`${intent.valor}\``
  }

  if (op === 'leer_archivo') {
    if (!intent.nombre) return '¿Qué archivo quieres leer?'
    const filePath = path.isAbsolute(intent.nombre) ? intent.nombre : path.join(BOT_PATH, intent.nombre)
    if (!fs.existsSync(filePath)) return `No existe el archivo *${intent.nombre}*...`
    const content = fs.readFileSync(filePath, 'utf8').slice(0, 3000)
    return `Contenido de *${intent.nombre}*:\n\n\`\`\`\n${content}\n\`\`\``
  }

  if (op === 'crear_archivo') {
    if (!intent.nombre) return '¿Cómo se llama el archivo?'
    const filePath = path.isAbsolute(intent.nombre) ? intent.nombre : path.join(BOT_PATH, intent.nombre)
    if (fs.existsSync(filePath)) return `¡Ese archivo ya existe! ¿Quieres editarlo?`
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, intent.contenido || '', 'utf8')
    return `¡Archivo *${intent.nombre}* creado!`
  }

  if (op === 'editar_archivo') {
    if (!intent.nombre) return '¿Qué archivo quieres editar?'
    const filePath = path.isAbsolute(intent.nombre) ? intent.nombre : path.join(BOT_PATH, intent.nombre)
    if (!fs.existsSync(filePath)) return `No existe el archivo *${intent.nombre}*...`
    if (!intent.contenido) {
      const content = fs.readFileSync(filePath, 'utf8').slice(0, 3000)
      return `Contenido actual de *${intent.nombre}*:\n\n\`\`\`\n${content}\n\`\`\``
    }
    fs.writeFileSync(filePath, intent.contenido, 'utf8')
    return `¡Archivo *${intent.nombre}* actualizado!`
  }

  if (op === 'eliminar_archivo') {
    if (!intent.nombre) return '¿Qué archivo quieres eliminar?'
    const filePath = path.isAbsolute(intent.nombre) ? intent.nombre : path.join(BOT_PATH, intent.nombre)
    if (!fs.existsSync(filePath)) return `No existe el archivo *${intent.nombre}*...`
    fs.unlinkSync(filePath)
    return `Archivo *${intent.nombre}* eliminado.`
  }

  return '¡Ne! No entendí qué operación quieres hacer con los archivos.'
}

// ── Detecta intención de archivo ─────────────────────────
async function detectFileIntent(userText) {
  const raw = await callAI(`${FILE_MGMT_PROMPT}\n\nMensaje: "${userText}"`)
  const clean = raw.replace(/```json|```/gi, '').trim()
  return JSON.parse(clean)
}

// ── Historial de conversación por chat ───────────────────
const messageHistory = new Map()
const HISTORY_MAX = 15

function saveToHistory(chatId, role, name, text) {
  if (!text?.trim()) return
  if (!messageHistory.has(chatId)) messageHistory.set(chatId, [])
  const hist = messageHistory.get(chatId)
  hist.push({ role, name, text: text.trim() })
  if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX)
}

function buildHistoryContext(chatId) {
  const hist = messageHistory.get(chatId) || []
  if (!hist.length) return ''
  const lines = hist.map(h =>
    h.role === 'rikka' ? `Rikka: ${h.text}` : `${h.name || 'Usuario'}: ${h.text}`
  ).join('\n')
  return `Historial reciente de la conversación:\n${lines}\n\n`
}

// ── Handler principal ─────────────────────────────────────
const handler = (m) => m

handler.before = async (m) => {
  const rawText = (m.text || '').trim()
  if (!rawText || /^[./!#]/.test(rawText)) return true

  // Guardar mensaje en historial
  const senderName = m.pushName || m.sender?.split('@')[0] || 'Usuario'
  saveToHistory(m.chat, 'user', senderName, rawText)

  // Determinar si Rikka debe activarse
  const replyToBot = m.quoted && isQuotedFromBot(m.quoted)

  const botNumber = (m.conn.user?.id || '').split(':')[0].split('@')[0]
  const mentioned = botNumber && (
    (Array.isArray(m.mentionedJid) && m.mentionedJid.some(j => j.includes(botNumber))) ||
    rawText.includes(`@${botNumber}`)
  )

  if (!replyToBot && !mentioned) return true

  const userText = mentioned && !replyToBot
    ? rawText.replace(new RegExp(`@${botNumber}`, 'g'), '').trim()
    : rawText

  if (!userText) return true

  console.log(`[rikka/ia] ✅ Activado (${replyToBot ? 'reply' : 'mención'}): "${userText}"`)

  await m.conn.sendPresenceUpdate('composing', m.chat)

  try {
    const ownerSender = isOwnerSender(m)

    // 0. Si es el owner → verificar si es operación de archivos primero
    if (ownerSender) {
      let fileIntent = null
      try {
        fileIntent = await detectFileIntent(userText)
        console.log(`[rikka/ia] 📁 FileIntent:`, JSON.stringify(fileIntent))
      } catch (e) {
        console.warn(`[rikka/ia] ⚠️ Falló detección de archivo:`, e.message)
      }

      if (fileIntent?.es_archivo && fileIntent?.operacion && fileIntent?.confianza !== 'baja') {
        console.log(`[rikka/ia] 📁 Operación: ${fileIntent.operacion}`)
        await m.conn.sendMessage(m.chat, { react: { text: '⚙️', key: m.key } })
        try {
          const resultado = await ejecutarArchivoOp(fileIntent, m)
          await m.conn.sendMessage(m.chat, { react: { text: '✅', key: m.key } })
          await m.conn.sendMessage(m.chat, { text: resultado }, { quoted: m })
          saveToHistory(m.chat, 'rikka', 'Rikka', resultado)
        } catch (e) {
          console.error('[rikka/ia] Error archivo →', e.message)
          await m.conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } })
          await m.conn.sendMessage(m.chat, { text: `¡Uy! Algo salió mal: ${e.message}` }, { quoted: m })
        }
        return true
      }
    }

    // 1. Clasificar intención del mensaje
    let intent = null
    try {
      intent = await detectIntent(userText)
      console.log(`[rikka/ia] 🧠 Intent:`, JSON.stringify(intent))
    } catch (e) {
      console.warn(`[rikka/ia] ⚠️ Falló clasificación:`, e.message)
    }

    // 2. Si detectó comando con confianza suficiente → ejecutar
    if (intent?.es_comando && intent?.comando && intent?.confianza !== 'baja') {
      const prefix = '.'
      const cmdText = intent.args?.trim()
        ? `${prefix}${intent.comando} ${intent.args.trim()}`
        : `${prefix}${intent.comando}`

      console.log(`[rikka/ia] 🚀 Ejecutando: "${cmdText}"`)

      const confirmFn = ownerSender
        ? [
            (cmd) => `¡Ne ne! ¡Lo hago ahora mismo! *${cmd}* para ti.`,
            (cmd) => `¡Cuenta conmigo! *${cmd}* en camino.`,
            (cmd) => `¡Solo porque me lo pediste! *${cmd}* ya.`,
            (cmd) => `¡Entendido! *${cmd}* ahora mismo.`,
          ][Math.floor(Math.random() * 4)]
        : CONFIRMACIONES[Math.floor(Math.random() * CONFIRMACIONES.length)]

      const confirmMsg = confirmFn(intent.comando)
      await m.conn.sendMessage(m.chat, { text: confirmMsg }, { quoted: m })
      saveToHistory(m.chat, 'rikka', 'Rikka', confirmMsg)
      await m.conn.sendPresenceUpdate('paused', m.chat)

      m.text = cmdText
      m.body = cmdText
      return false
    }

    // 3. Si no es comando → respuesta normal de Rikka
    const quotedText = (m.quoted?.text || '').trim()
    const reply = await callRikka(userText, quotedText, ownerSender, m.chat)

    await m.conn.sendPresenceUpdate('paused', m.chat)
    await m.conn.sendMessage(m.chat, { text: reply }, { quoted: m })
    saveToHistory(m.chat, 'rikka', 'Rikka', reply)
    console.log('[rikka/ia] ✅ Respondido como Rikka.')

  } catch (e) {
    console.error('[rikka/ia] Error →', e.message)
    await m.conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } })
    await m.reply('¡Uy! Algo falló. Inténtalo de nuevo, por favor...')
  }

  return true
}

export default handler
