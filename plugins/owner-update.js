import { execSync } from 'child_process'
import fs from 'fs'

const handler = async (m, { conn, text }) => {
  try {
    const stdout = execSync('git pull' + (m.fromMe && text ? ' ' + text : ''))
    let msg = stdout.toString()
    if (msg.includes('Already up to date.'))
      msg = '꒰ ✦ *Update* ✦ ꒱\n┊⇢ ✅ No hay actualizaciones pendientes.'
    if (msg.includes('Updating'))
      msg = '꒰ ✦ *Update* ✦ ꒱\n┊⇢ ✅ Actualización finalizada exitosamente.\n\n' + stdout.toString()
    conn.reply(m.chat, msg, m)
  } catch {
    try {
      const status = execSync('git status --porcelain')
      if (status.length > 0) {
        const conflicted = status.toString().split('\n')
          .filter(l => l.trim())
          .map(l => {
            if (
              l.includes('.npm/') || l.includes('.cache/') ||
              l.includes('tmp/')  || l.includes('RikkaSession/') ||
              l.includes('npm-debug.log')
            ) return null
            return `┊⇢ *${l.slice(3)}*`
          })
          .filter(Boolean)
        if (conflicted.length > 0) {
          return conn.reply(m.chat,
            `꒰ ✦ *Update* ✦ ꒱\n┊⇢ ⚠️ Hay conflictos locales. Reinstala el bot o resuelve manualmente.\n\n*Archivos en conflicto:*\n${conflicted.join('\n')}`,
            m
          )
        }
      }
    } catch (e) {
      let err = '꒰ ✗ ꒱ Ocurrió un error. Intenta de nuevo más tarde.'
      if (e.message) err += `\n┊⇢ *Error:* ${e.message}`
      await conn.reply(m.chat, err, m)
    }
  }
}

handler.help    = ['update']
handler.tags    = ['owner']
handler.command = /^(update|actualizar|gitpull)$/i
handler.rowner  = true
export default handler
