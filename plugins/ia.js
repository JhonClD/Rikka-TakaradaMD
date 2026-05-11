import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.resolve(__dirname, '../.env')
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

const AI_APIS = [
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
        signal: AbortSignal.timeout(20000)
      })
      if (!res.ok) throw new Error(`Copilot HTTP ${res.status}`)
      const d = await res.json()
      return d?.choices?.[0]?.message?.content || ''
    }
  },
  {
    name: 'APICausas',
    call: async (prompt) => {
      const params = new URLSearchParams({
        apikey: process.env.APICAUSAS_KEY || '',
        model: 'google/gemini-2.5-flash',
        q: prompt
      })
      const res = await fetch(`https://rest.apicausas.xyz/api/v1/ai?${params}`, {
        method: 'GET', signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) throw new Error(`APICausas HTTP ${res.status}`)
      const d = await res.json()
      return d?.reply || d?.result || d?.response || d?.text || d?.message || ''
    }
  },
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
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}`)
      const d = await res.json()
      return d?.choices?.[0]?.message?.content || ''
    }
  },
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
          signal: AbortSignal.timeout(15000)
        }
      )
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`)
      const d = await res.json()
      return d?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    }
  },
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
        signal: AbortSignal.timeout(15000)
      })
      if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`)
      const d = await res.json()
      return d?.choices?.[0]?.message?.content || ''
    }
  },
]

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
      console.log(`[ia] 🤖 Intentando con ${api.name}...`)
      const result = await api.call(prompt, api.key || '')
      if (!result?.trim()) throw new Error('Respuesta vacía')
      lastWorkingApiIndex = idx
      console.log(`[ia] ✅ ${api.name} respondió`)
      return result.trim()
    } catch (e) {
      console.warn(`[ia] ⚠️ ${api.name} falló: ${e.message}`)
      errors.push(`${api.name}: ${e.message}`)
    }
  }
  throw new Error(`Todas las APIs fallaron:\n${errors.join('\n')}`)
}

function isQuotedFromBot(q) {
  if (!q) return false
  if (q.isBaileys === true) return true
  if (q.fromMe === true) return true
  return false
}

const ASSISTANT_PROMPT = `Eres un asistente de WhatsApp útil, directo y conciso.
Respondes preguntas, das información y ayudas con lo que sea necesario.
Usas un tono neutral y profesional.
Si no sabes algo, lo dices claramente.
Respuestas en español, sin adornos innecesarios.`

async function callAssistant(userText, quotedText, chatId = null) {
  let query = `${ASSISTANT_PROMPT}\n\n`
  if (chatId) query += buildHistoryContext(chatId)
  if (quotedText) query += `Contexto (mensaje al que responden): "${quotedText}"\n\n`
  query += `Mensaje del usuario: ${userText}`
  return await callAI(query)
}

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
    h.role === 'assistant' ? `Asistente: ${h.text}` : `${h.name || 'Usuario'}: ${h.text}`
  ).join('\n')
  return `Historial reciente:\n${lines}\n\n`
}

const handler = (m) => m

handler.before = async (m) => {
  const rawText = (m.text || '').trim()
  if (!rawText || /^[./!#]/.test(rawText)) return true

  const senderName = m.pushName || m.sender?.split('@')[0] || 'Usuario'
  saveToHistory(m.chat, 'user', senderName, rawText)

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

  console.log(`[ia] ✅ Activado: "${userText}"`)

  await m.conn.sendPresenceUpdate('composing', m.chat)

  try {
    const rawQuoted = (m.quoted?.text || '').trim()
    const quotedText = rawQuoted.length > 800 ? rawQuoted.slice(0, 800) + '...[recortado]' : rawQuoted
    const reply = await callAssistant(userText, quotedText, m.chat)

    await m.conn.sendPresenceUpdate('paused', m.chat)
    await m.conn.sendMessage(m.chat, { text: reply }, { quoted: m })
    saveToHistory(m.chat, 'assistant', 'Asistente', reply)
    console.log('[ia] ✅ Respondido.')

  } catch (e) {
    console.error('[ia] Error →', e.message)
    await m.conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } })
    await m.reply('Error. Intenta de nuevo.')
  }

  return true
}

export default handler
