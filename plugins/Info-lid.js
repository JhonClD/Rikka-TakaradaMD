const handler = async (m, { conn }) => {
  const sender = m.sender

  // Número limpio y formateado
  const rawNumber = sender.split('@')[0].replace(/[^0-9]/g, '')
  const formatted = '+' + rawNumber.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4')

  // JID estándar
  const jid = rawNumber + '@s.whatsapp.net'

  // LID: buscar en contacts
  const contacts = Object.values(conn?.contacts || {})
  const contactEntry = contacts.find(c =>
    c.id === jid ||
    c.id === sender ||
    (c.lid && (c.lid === sender || c.lid?.split('@')[0] === sender?.split('@')[0]))
  )
  const lid = contactEntry?.lid || sender?.endsWith('@lid') ? sender : '_(no disponible)_'

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
\`${lid}\`

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
  
