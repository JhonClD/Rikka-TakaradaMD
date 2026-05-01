// plugins/sinprefijo.js
// Modo sin prefijo por grupo — Rikka-TakaradaMD
// Guarda el estado en global.db (sin archivos externos)

// ── Helpers de estado ─────────────────────────────────────
function getSinPrefijo(chatId) {
  return global.db?.data?.chats?.[chatId]?.sinprefijo || false
}

function setSinPrefijo(chatId, value) {
  if (!global.db?.data?.chats) return
  if (!global.db.data.chats[chatId]) global.db.data.chats[chatId] = {}
  global.db.data.chats[chatId].sinprefijo = value
}

// ── Before hook — activa el modo sin prefijo ──────────────
// REGLA: solo devolver true cuando el handler debe SALTAR este plugin.
// Si devuelve true en un mensaje con prefijo → el comando nunca ejecuta.
const _before = async (m) => {
  if (!m.isGroup || !m.text) return false

  // Ya tiene prefijo → no tocar el texto,
  // y devolver FALSE para que el handler ejecute el comando normalmente.
  if (/^[.!/]/.test(m.text.trim())) return false

  // Sin prefijo y modo desactivado → ignorar
  if (!getSinPrefijo(m.chat)) return false

  // Sin prefijo + modo activado → agregar prefijo
  m.text = '.' + m.text.trim()
  if (m.body) m.body = '.' + m.body.trim()

  // Devolver false para que los demás plugins del loop también vean el texto modificado
  return false
}

// ── Comando principal ─────────────────────────────────────
const handler = async (m, { isOwner, isAdmin, command }) => {
  if (!m.isGroup) return m.reply('¡Ne ne! Este comando solo funciona en grupos.')
  if (!isAdmin && !isOwner) return m.reply('⚠️ Solo los administradores pueden usar este comando.')

  const estado = getSinPrefijo(m.chat)

  if (command === 'sinprefijo' || command === 'noprefix') {
    if (estado) {
      return m.reply('¡El modo sin prefijo ya está ACTIVADO en este grupo!')
    }
    setSinPrefijo(m.chat, true)
    await m.reply(`✅ *Modo sin prefijo ACTIVADO*

¡Ne ne! Ahora los miembros pueden escribir comandos sin prefijo.

*Ejemplos:*
• play bad bunny
• menu
• sticker (responde a una imagen)
• ytmp3 (url de youtube)

*Nota:* Los prefijos siguen funcionando igual.

Para desactivar: .conprefijo`)

  } else if (command === 'conprefijo' || command === 'withprefix') {
    if (!estado) {
      return m.reply('El modo sin prefijo ya está DESACTIVADO en este grupo.')
    }
    setSinPrefijo(m.chat, false)
    await m.reply(`✅ *Modo sin prefijo DESACTIVADO*

Los comandos ahora solo funcionarán con prefijo.

*Ejemplos:*
• .play bad bunny
• .menu
• .sticker

Para activar de nuevo: .sinprefijo`)
  }
}

handler.before = _before
handler.help = ['sinprefijo', 'conprefijo']
handler.tags = ['group', 'owner']
handler.command = ['sinprefijo', 'noprefix', 'conprefijo', 'withprefix']
handler.group = true
handler.admin = true

export default handler
