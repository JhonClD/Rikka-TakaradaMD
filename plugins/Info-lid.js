const handler = async (m, { conn }) => {
  const rawSender = m.sender

  let realJid = rawSender
  let lid = null
  let debugLines = []

  if (rawSender?.endsWith('@lid')) {
    lid = rawSender
    debugLines.push(`⚠️ m.sender es un @lid: \`${rawSender}\``)

    const contacts = Object.values(conn?.contacts || {})
    debugLines.push(`📋 Contactos en cache: ${contacts.length}`)

    const match = contacts.find(c =>
      c.lid === rawSender ||
      c.lid === rawSender.split('@')[0] + '@lid'
    )

    if (match?.id && !match.id.endsWith('@lid')) {
      realJid = match.id
      debugLines.push(`✅ JID real encontrado: \`${realJid}\``)
    } else if (match) {
      debugLines.push(`⚠️ Contacto encontrado pero su .id también es @lid: \`${match.id}\``)
    } else {
      debugLines.push(`❌ No se encontró ningún contacto con ese lid en conn.contacts`)
      // Intento alternativo: buscar en store si existe
      const storeContacts = conn?.store?.contacts ? Object.values(conn.store.contacts) : []
      debugLines.push(`📋 Contactos en store: ${storeContacts.length}`)
      const storeMatch = storeContacts.find(c =>
        c.lid === rawSender ||
        c.lid === rawSender.split('@')[0] + '@lid'
      )
      if (storeMatch?.id && !storeMatch.id.endsWith('@lid')) {
        realJid = storeMatch.id
        debugLines.push(`✅ JID real encontrado en store: \`${realJid}\``)
      } else {
        debugLines.push(`❌ Tampoco encontrado en store`)
        debugLines.push(`⚠️ Mostrando datos del LID en lugar del número real`)
      }
    }
  } else {
    const contacts = Object.values(conn?.contacts || {})
    const match = contacts.find(c => c.id === rawSender)
    if (match?.lid) lid = match.lid
  }

  const rawNumber = realJid.split('@')[0].replace(/[^0-9]/g, '')
  const isLidFallback = realJid.endsWith('@lid')

  let formatted
  if (rawNumber.length <= 11) {
    formatted = '+' + rawNumber.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4')
  } else {
    formatted = '+' + rawNumber
  }

  const jid = rawNumber + '@s.whatsapp.net'

  let pp = 'https://files.catbox.moe/leegee.jpg'
  try { pp = await conn.profilePictureUrl(jid, 'image') } catch {
    try { pp = await conn.profilePictureUrl(jid, 'preview') } catch {}
  }

  let caption = `╔═════✰⋆⋅☆⋅⋆✰═════╗
     ೃ⁀➷  *Info Del Usuario*
╚═════✰⋆⋅☆⋅⋆✰═════╝

✧ *Número de WhatsApp:*
\`${formatted}\`

✧ *JID (ID de WhatsApp):*
\`${jid}\`

✧ *LID (ID Vinculado):*
\`${lid || '_(no disponible)_'}\``

  if (isLidFallback && debugLines.length > 0) {
    caption += `\n\n*━━ Diagnóstico ━━*\n${debugLines.join('\n')}`
  }

  caption += `\n\n☆✦・*・✦・*・✦・*・✦・*・✦☆`

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
