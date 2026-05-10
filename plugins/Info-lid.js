const handler = async (m, { conn }) => {
  const rawSender = m.sender
  const isLid = rawSender?.endsWith('@lid')

  let realJid = rawSender
  let lid = null

  if (isLid) {
    lid = rawSender
    // Usar el LidResolver del bot (conn.resolveLid) — tiene caché persistente
    // y fallback a onWhatsApp(), mucho más confiable que conn.contacts (siempre vacío)
    if (conn?.resolveLid?.resolveLid) {
      const resolved = await conn.resolveLid.resolveLid(rawSender, m.chat)
      if (resolved && !resolved.endsWith('@lid')) {
        realJid = resolved
      }
    }
  } else {
    // JID normal → buscar su LID en la caché del LidResolver
    if (conn?.resolveLid?.findLidByJid) {
      const foundLid = conn.resolveLid.findLidByJid(rawSender)
      if (foundLid) lid = foundLid
    }
    // Fallback: también buscar vía conn.lid si está disponible
    if (!lid && conn?.lid?.findLidByJid) {
      const foundLid = conn.lid.findLidByJid(rawSender)
      if (foundLid) lid = foundLid
    }
  }

  // Número limpio desde JID real
  const rawNumber = realJid.split('@')[0].replace(/[^0-9]/g, '')

  // Formatear número
  let formatted
  if (rawNumber.length <= 11) {
    formatted = '+' + rawNumber.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4')
  } else {
    formatted = '+' + rawNumber
  }

  const jid = rawNumber + '@s.whatsapp.net'

  // Foto de perfil
  let pp = 'https://files.catbox.moe/leegee.jpg'
  try { pp = await conn.profilePictureUrl(jid, 'image') } catch {
    try { pp = await conn.profilePictureUrl(jid, 'preview') } catch {}
  }

  // Advertencia si el LID no pudo resolverse (realJid sigue siendo el LID)
  const notResolved = isLid && realJid.endsWith('@lid')
  const warnLine = notResolved
    ? `\n\n⚠️ _LID sin resolver: no está en la caché aún. Envía un mensaje al bot primero para que se registre._`
    : ''

  const caption = `╔═════✰⋆⋅☆⋅⋆✰═════╗
     ೃ⁀➷  *Info Del Usuario*
╚═════✰⋆⋅☆⋅⋆✰═════╝

✧ *Número de WhatsApp:*
\`${formatted}\`

✧ *JID (ID de WhatsApp):*
\`${jid}\`

✧ *LID (ID Vinculado):*
\`${lid || '_(no disponible)_'}\`${warnLine}

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
