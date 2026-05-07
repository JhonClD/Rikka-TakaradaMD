import { execSync } from 'child_process'

const handler = async (m, { conn, text }) => {
  try {
    const stdout = execSync('git pull' + (m.fromMe && text ? ' ' + text : ''), { timeout: 30000 })
    let msg = stdout.toString()
    if (msg.includes('Already up to date.'))
      msg = '꒰ ✦ *Update* ✦ ꒱\n┊⇢ ✅ No hay actualizaciones pendientes.'
    else if (msg.includes('Updating'))
      msg = '꒰ ✦ *Update* ✦ ꒱\n┊⇢ ✅ Actualización finalizada exitosamente.\n\n' + stdout.toString()
    conn.reply(m.chat, msg, m)
  } catch (pullErr) {
    // git pull falló, revisar estado
    try {
      const status = execSync('git status --porcelain', { timeout: 10000 })
      if (status.length > 0) {
        const conflicted = status.toString().split('\n')
          .filter(l => l.trim())
          .map(l => {
            if (
              l.includes('.npm/')       || l.includes('.cache/') ||
              l.includes('tmp/')        || l.includes('RikkaSession/') ||
              l.includes('npm-debug.log')
            ) return null
            return `┊⇢ *${l.slice(3)}*`
          })
          .filter(Boolean)
        if (conflicted.length > 0) {
          return conn.reply(m.chat,
            `꒰ ✦ *Update* ✦ ꒱\n┊⇢ ⚠️ Hay conflictos locales. Resuelve manualmente o reinstala.\n\n*Archivos en conflicto:*\n${conflicted.join('\n')}`,
            m
          )
        }
        // Archivos modificados pero no conflictivos (ej. database.json, session)
        return conn.reply(m.chat,
          `꒰ ✦ *Update* ✦ ꒱\n┊⇢ ⚠️ No se pudo hacer pull.\n┊⇢ El repositorio tiene cambios locales que bloquean la actualización.\n\n` +
          `⸙͎ Intenta: *git stash && .update*`,
          m
        )
      }
      // Working tree limpio pero pull falló de todas formas (ej. sin internet)
      const errMsg = pullErr?.stderr?.toString?.() || pullErr?.message || 'Error desconocido'
      return conn.reply(m.chat,
        `꒰ ✦ *Update* ✦ ꒱\n┊⇢ ⚠️ No se pudo actualizar.\n┊⇢ *Razón:* ${errMsg.split('\n')[0] || 'Sin conexión o repositorio inaccesible.'}`,
        m
      )
    } catch (statusErr) {
      // git status también falló (no es un repo git, o git no está instalado)
      const errMsg = statusErr?.message || 'Error desconocido'
      await conn.reply(m.chat,
        `꒰ ✗ ꒱ Error al ejecutar git.\n┊⇢ *Detalle:* ${errMsg.split('\n')[0]}`,
        m
      )
    }
  }
}

handler.help    = ['update']
handler.tags    = ['owner']
handler.command = /^(update|actualizar|gitpull)$/i
handler.rowner  = true
export default handler
