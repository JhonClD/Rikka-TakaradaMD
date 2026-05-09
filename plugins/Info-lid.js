const handler = async (m, { conn }) => {
  const rawSender = m.sender

  // Resolver JID real si m.sender es un @lid
  let realJid = rawSender
  let lid = null

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
    }
  } else {
    // m.sender ya es JID normal, buscar su lid en contacts
    const contacts = Object.values(conn?.contacts || {})
    const match = contacts.find(c => c.id === rawSender)
    if (match?.lid) lid = match.lid
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

  const caption = `╔═════✰⋆⋅☆⋅⋆✰═════╗
     ೃ⁀➷  *Info Del Usuario*
╚═════✰⋆⋅☆⋅⋆✰═════╝

✧ *Número de WhatsApp:*
\`${formatted}\`

✧ *JID (ID de WhatsApp):*
\`${jid}\`

✧ *LID (ID Vinculado):*
\`${lid || '_(no disponible)_'}\`

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
