const handler = async (m, { isOwner, args, usedPrefix }) => {
  if (!isOwner) return m.reply('꒰ ✗ ꒱ Solo el *owner* puede usar este comando.')

  const sub = args[0]?.toLowerCase()

  if (!sub) {
    const estado = global.soloOwnerMode ? '✅ *Activado*' : '❌ *Desactivado*'
    return m.reply(
      `꒰ ✦ *Modo Solo Owner* ✦ ꒱\n\n┊⇢ *Estado:* ${estado}\n\n` +
      `⸙͎ Cuando está activo el bot ignora a todos excepto al owner.\n\n` +
      `┊⇢ *${usedPrefix}soloowner on* → Activar\n` +
      `┊⇢ *${usedPrefix}soloowner off* → Desactivar`
    )
  }

  if (sub === 'on') {
    global.soloOwnerMode = true
    return m.reply('꒰ 🔒 ꒱ *Modo Solo Owner activado.*\n┊⇢ El bot solo responderá al owner.')
  }

  if (sub === 'off') {
    global.soloOwnerMode = false
    return m.reply('꒰ 🔓 ꒱ *Modo Solo Owner desactivado.*\n┊⇢ El bot responde a todos normalmente.')
  }

  throw `⸙͎ *Uso:*\n┊⇢ *${usedPrefix}soloowner on*\n┊⇢ *${usedPrefix}soloowner off*`
}

handler.all = async function (m) {
  if (!global.soloOwnerMode) return
  const ownerList = [...(global.owner || [])].flat().map(e => {
    const num = Array.isArray(e) ? e[0] : e
    return String(num).replace(/[^0-9]/g, '') + '@s.whatsapp.net'
  })
  const isOwner = ownerList.includes(m.sender) || m.fromMe
  if (!isOwner) m.text = ''
}

handler.help    = ['soloowner <on|off>']
handler.tags    = ['owner']
handler.command = ['soloowner']
export default handler
