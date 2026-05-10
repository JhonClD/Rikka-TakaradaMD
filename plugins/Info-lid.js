const handler = async (m, { conn }) => {
  const rawSender = m.sender

  // Resolver JID real si m.sender es un @lid
  let realJid = rawSender
  let lid = null
  let resolveError = null  // ← para rastrear si la resolución falló

  if (rawSender?.endsWith('@lid')) {
    lid = rawSender
    // Buscar en contacts el JID real que tenga ese lid
    const contacts = Object.values(conn?.contacts || {})
    const match = contacts.find(c =>
      c.lid === rawSender ||
      c.lid === rawSender.split('@')[0] + '@lid'
    )
    if (match?.id && !match.id.endsWith('@lid')) {
      realJid = match.id
    } else {
      // No se encontró el JID real — el número mostrado vendrá del LID mismo
      resolveError = contacts.length === 0
        ? '⚠️ _contacts vacío: el bot no ha cargado contactos aún_'
        : `⚠️ _LID no encontrado en contacts (${contacts.length} entradas). El número mostrado es el del LID, no el JID real_`
    }
  } else {
    // m.sender ya es JID normal, buscar su lid en contacts
    const contacts = Object.values(conn?.contacts || {})
    const match = contacts.find(c => c.id === rawSender)
    if (match?.lid) {
      lid = match.lid
    } else {
      resolveError = contacts.length === 0
        ? '⚠️ _contacts vacío: el bot no ha cargado contactos aún_'
        : '⚠️ _Este usuario no tiene LID registrado en contacts_'
    }
  }

  // Número limpio desde JID real
  const rawNumber = realJid.split('@')[0].replace(/[^0-9]/g, '')

  // Formatear según longitud del número
  let formatted
  if (rawNumber.length <= 11) {
    // Ej: 51925092348 → +51 925 092 348
    formatted = '+' + rawNumber.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4')
  } else {
    // Número largo, solo agregar +
    formatted = '+' + rawNumber
  }

  const jid = rawNumber + '@s.whatsapp.net'

  // Foto de perfil
  let pp = 'https://files.catbox.moe/leegee.jpg'
  try { pp = await conn.profilePictureUrl(jid, 'image') } catch {
    try { pp = await conn.profilePictureUrl(jid, 'preview') } catch {}
  }

  // Línea de error solo si hubo problema
  const errorLine = resolveError
    ? `\n\n🔍 *Debug:*\n${resolveError}`
    : ''

  const caption = `╔═════✰⋆⋅☆⋅⋆✰═════╗
     ೃ⁀➷  *Info Del Usuario*
╚═════✰⋆⋅☆⋅⋆✰═════╝

✧ *Número de WhatsApp:*
\`${formatted}\`

✧ *JID (ID de WhatsApp):*
\`${jid}\`

✧ *LID (ID Vinculado):*
\`${lid || '_(no disponible)_'}\`${errorLine}

☆✦・*・✦・*・✦・*・✦・*・✦☆`

  await conn.sendMessage(
    m.chat,
    {
      image: { url: pp },
      caption,
      mentions: [jid],
    },
    { quoted: m }
  )
}

handler.help    = ['jid', 'lid', 'myjid']
handler.tags    = ['info']
handler.command = /^(jid|lid|myjid|miid|infojid)$/i

export default handler
