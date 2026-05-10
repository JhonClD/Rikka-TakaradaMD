const handler = async (m, { conn }) => {
  const rawSender = m.sender
  const isLid = rawSender?.endsWith('@lid')

  let realJid = rawSender
  let lid = null

  if (isLid) {
    lid = rawSender

    // 1) Método nativo de este fork de Baileys: LIDMappingStore
    //    Tiene caché LRU + base de datos persistente de mappings lid ↔ PN
    try {
      const pn = await conn?.signalRepository?.lidMapping?.getPNForLID(rawSender)
      if (pn && !pn.endsWith('@lid')) {
        realJid = pn
      }
    } catch {}

    // 2) Fallback: LidResolver propio del bot (lidsresolve.json)
    if (realJid.endsWith('@lid') && conn?.resolveLid?.resolveLid) {
      try {
        const resolved = await conn.resolveLid.resolveLid(rawSender, m.chat)
        if (resolved && !resolved.endsWith('@lid')) {
          realJid = resolved
        }
      } catch {}
    }

  } else {
    // JID normal → buscar su LID vía LIDMappingStore
    try {
      const lidResult = await conn?.signalRepository?.lidMapping?.getLIDForPN(rawSender)
      if (lidResult) lid = lidResult
    } catch {}

    // Fallback: LidResolver del bot
    if (!lid && conn?.resolveLid?.findLidByJid) {
      lid = conn.resolveLid.findLidByJid(rawSender) || null
    }
  }

  // Número limpio desde JID real
  const rawNumber = realJid.split('@')[0].replace(/[^0-9]/g, '')

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

  // Aviso si el LID no pudo resolverse
  const notResolved = isLid && realJid.endsWith('@lid')
  const warnLine = notResolved
    ? `\n\n⚠️ _LID sin resolver: aún no hay mapping guardado para este usuario._`
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
    { image: { url: pp }, caption, mentions: [jid] },
    { quoted: m }
  )
}

handler.help    = ['jid', 'lid', 'myjid']
handler.tags    = ['info']
handler.command = /^(jid|lid|myjid|miid|infojid)$/i

export default handler
  
