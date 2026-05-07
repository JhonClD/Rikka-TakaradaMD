import { exec } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

async function reloadPlugins() {
  const pluginsDir = path.join(__dirname)
  const pluginsMap = global.plugins || {}
  const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'))
  for (const file of files) {
    const fullPath = path.join(pluginsDir, file)
    try {
      const mod = await import(fullPath + '?update=' + Date.now())
      if (mod?.default) pluginsMap[file] = mod.default
    } catch (e) {
      console.error(`[update] Error recargando ${file}:`, e.message)
    }
  }
  global.plugins = pluginsMap
}

const handler = async (m, { conn }) => {
  exec('git pull', async (error, stdout, stderr) => {
    let msg = ''
    if (error) {
      const errText = stderr?.trim() || error.message || 'Error desconocido'
      // Si hay cambios locales que bloquean el pull
      if (errText.includes('local changes') || errText.includes('overwritten')) {
        msg = `꒰ ✦ *Update* ✦ ꒱\n┊⇢ ⚠️ Hay cambios locales que bloquean la actualización.\n┊⇢ Intenta: *git stash* y luego *.update*`
      } else if (errText.includes('CONFLICT')) {
        msg = `꒰ ✦ *Update* ✦ ꒱\n┊⇢ ⚠️ Conflictos detectados. Debes resolverlos manualmente.\n\n${errText.split('\n').slice(0, 5).join('\n')}`
      } else {
        msg = `꒰ ✦ *Update* ✦ ꒱\n┊⇢ ⚠️ No se pudo actualizar.\n┊⇢ *Razón:* ${errText.split('\n')[0]}`
      }
    } else if (stdout.includes('Already up to date.')) {
      msg = '꒰ ✦ *Update* ✦ ꒱\n┊⇢ ✅ No hay actualizaciones pendientes.'
    } else {
      msg = `꒰ ✦ *Update* ✦ ꒱\n┊⇢ ✅ Actualización completada.\n\n${stdout.trim()}`
      // Recargar plugins tras actualizar
      try { await reloadPlugins() } catch {}
    }
    await conn.reply(m.chat, msg, m).catch(console.error)
  })
}

handler.help    = ['update', 'gitpull', 'actualizar']
handler.tags    = ['owner']
handler.command = /^(update|actualizar|gitpull)$/i
handler.rowner  = true
export default handler
