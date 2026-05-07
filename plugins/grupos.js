const handler = async (m, { conn, command, args, text, usedPrefix, groupMetadata, participants, isAdmin, isBotAdmin, isOwner }) => {
  if (!global.db.data.chats[m.chat]) global.db.data.chats[m.chat] = {}
  const chat = global.db.data.chats[m.chat]

  const getTarget = async () => {
    let jid = m.mentionedJid?.[0] || m.quoted?.sender
    if (!jid && args[0]) {
      const num = args[0].replace(/[^0-9]/g, '')
      jid = num + '@s.whatsapp.net'
    }
    if (jid && m.isGroup && !jid.endsWith('@s.whatsapp.net')) {
      try {
        const meta = await conn.groupMetadata(m.chat)
        for (const p of meta.participants || []) {
          if (p?.id?.split('@')[0] === jid.split('@')[0]) { jid = p.id; break }
        }
      } catch {}
    }
    return jid
  }

  switch (command) {

    case 'kick':
    case 'expulsar': {
      if (!isBotAdmin) return m.reply('꒰ ✗ ꒱ Necesito ser *admin* para expulsar.')
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      const jid = await getTarget()
      if (!jid) return m.reply(`⸙͎ Menciona o cita al usuario a expulsar.`)
      if (jid === conn.user?.jid) return m.reply('꒰ ✗ ꒱ No me puedo expulsar a mí mismo.')
      await conn.groupParticipantsUpdate(m.chat, [jid], 'remove')
      return conn.sendMessage(m.chat, {
        text: `꒰ ✦ *Expulsado* ✦ ꒱\n┊⇢ @${jid.split('@')[0]} fue removido del grupo.`,
        mentions: [jid],
      }, { quoted: m })
    }

    case 'add':
    case 'agregar': {
      if (!isBotAdmin) return m.reply('꒰ ✗ ꒱ Necesito ser *admin* para agregar.')
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      if (!args[0]) return m.reply(`⸙͎ Uso: *${usedPrefix}add <número>*`)
      const num = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net'
      const res = await conn.groupParticipantsUpdate(m.chat, [num], 'add')
      const status = res?.[0]?.status
      const msgs = { 200: `꒰ ✦ ꒱ @${num.split('@')[0]} fue *agregado* exitosamente.`, 403: '꒰ ✗ ꒱ El usuario tiene privacidad activada.', 408: '꒰ ✗ ꒱ El número no existe en WhatsApp.' }
      return conn.sendMessage(m.chat, { text: msgs[status] || `꒰ ✗ ꒱ No se pudo agregar (${status})`, mentions: [num] }, { quoted: m })
    }

    case 'promote':
    case 'ascender': {
      if (!isBotAdmin) return m.reply('꒰ ✗ ꒱ Necesito ser *admin* para ascender.')
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      const jid = await getTarget()
      if (!jid) return m.reply(`⸙͎ Menciona al usuario a ascender.`)
      await conn.groupParticipantsUpdate(m.chat, [jid], 'promote')
      return conn.sendMessage(m.chat, {
        text: `꒰ ✦ *Ascendido* ✦ ꒱\n┊⇢ @${jid.split('@')[0]} ahora es *admin*.`,
        mentions: [jid],
      }, { quoted: m })
    }

    case 'demote':
    case 'degradar': {
      if (!isBotAdmin) return m.reply('꒰ ✗ ꒱ Necesito ser *admin* para degradar.')
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      const jid = await getTarget()
      if (!jid) return m.reply(`⸙͎ Menciona al usuario a degradar.`)
      await conn.groupParticipantsUpdate(m.chat, [jid], 'demote')
      return conn.sendMessage(m.chat, {
        text: `꒰ ✦ *Degradado* ✦ ꒱\n┊⇢ @${jid.split('@')[0]} ya no es *admin*.`,
        mentions: [jid],
      }, { quoted: m })
    }

    case 'open':
    case 'abrir': {
      if (!isBotAdmin) return m.reply('꒰ ✗ ꒱ Necesito ser *admin* para abrir el grupo.')
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      await conn.groupSettingUpdate(m.chat, 'not_announcement')
      return m.reply('꒰ ✦ ꒱ *Grupo abierto* ✧ Todos pueden enviar mensajes.')
    }

    case 'close':
    case 'cerrar': {
      if (!isBotAdmin) return m.reply('꒰ ✗ ꒱ Necesito ser *admin* para cerrar el grupo.')
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      await conn.groupSettingUpdate(m.chat, 'announcement')
      return m.reply('꒰ ✦ ꒱ *Grupo cerrado* ✧ Solo admins pueden enviar mensajes.')
    }

    case 'link':
    case 'enlace': {
      if (!isBotAdmin) return m.reply('꒰ ✗ ꒱ Necesito ser *admin* para obtener el link.')
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      const code = await conn.groupInviteCode(m.chat)
      return m.reply(`꒰ ✦ *Link del grupo* ✦ ꒱\n┊⇢ https://chat.whatsapp.com/${code}`)
    }

    case 'revokelink':
    case 'resetlink': {
      if (!isBotAdmin) return m.reply('꒰ ✗ ꒱ Necesito ser *admin* para resetear el link.')
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      await conn.groupRevokeInvite(m.chat)
      return m.reply('꒰ ✦ ꒱ *Link revocado* ✧ Se generó un nuevo enlace.')
    }

    case 'tagall':
    case 'everyone': {
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      const mentions = participants.filter(p => p).map(p => typeof p === 'string' ? p : p.id || p.jid || '')
      const msg = text || '꒰ ✦ *Atención* ✦ ꒱'
      await conn.sendMessage(m.chat, { text: `${msg}\n\n${mentions.map(j => `┊⇢ @${j.split('@')[0]}`).join('\n')}`, mentions }, { quoted: m })
      break
    }

    case 'hidetag': {
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      const mentions = participants.filter(p => p).map(p => typeof p === 'string' ? p : p.id || p.jid || '')
      await conn.sendMessage(m.chat, { text: text || m.quoted?.text || '꒰ ✦ ꒱', mentions }, { quoted: m })
      break
    }

    case 'welcome':
    case 'bienvenida': {
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      const sub = args[0]?.toLowerCase()
      if (sub === 'on')  { chat.welcome = true;  return m.reply('꒰ ✦ ꒱ *Bienvenida activada* ✧ Los nuevos miembros serán saludados.') }
      if (sub === 'off') { chat.welcome = false; return m.reply('꒰ ✦ ꒱ *Bienvenida desactivada*.') }
      if (sub === 'set') {
        const msg = args.slice(1).join(' ')
        if (!msg) return m.reply(`⸙͎ Uso: *${usedPrefix}welcome set <mensaje>*\n_Variables: @user @subject @desc_`)
        chat.sWelcome = msg
        return m.reply(`꒰ ✦ ꒱ *Mensaje de bienvenida guardado.*\n┊⇢ ${msg}`)
      }
      const estado = chat.welcome ? '✅ Activada' : '❌ Desactivada'
      return m.reply(`꒰ ✦ *Bienvenida* ✦ ꒱\n┊⇢ *Estado:* ${estado}\n\n⸙͎ Uso:\n┊⇢ *${usedPrefix}welcome on/off*\n┊⇢ *${usedPrefix}welcome set <msg>*`)
    }

    case 'bye':
    case 'despedida': {
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      const sub = args[0]?.toLowerCase()
      if (sub === 'on')  { chat.welcome = true;  return m.reply('꒰ ✦ ꒱ *Despedida activada*.') }
      if (sub === 'off') { chat.welcome = false; return m.reply('꒰ ✦ ꒱ *Despedida desactivada*.') }
      if (sub === 'set') {
        const msg = args.slice(1).join(' ')
        if (!msg) return m.reply(`⸙͎ Uso: *${usedPrefix}bye set <mensaje>*\n_Variables: @user_`)
        chat.sBye = msg
        return m.reply(`꒰ ✦ ꒱ *Mensaje de despedida guardado.*\n┊⇢ ${msg}`)
      }
      return m.reply(`꒰ ✦ *Despedida* ✦ ꒱\n⸙͎ Uso:\n┊⇢ *${usedPrefix}bye on/off*\n┊⇢ *${usedPrefix}bye set <msg>*`)
    }

    case 'detect': {
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      const sub = args[0]?.toLowerCase()
      if (sub === 'on')  { chat.detect = true;  return m.reply('꒰ ✦ ꒱ *Detección de eventos activada*.') }
      if (sub === 'off') { chat.detect = false; return m.reply('꒰ ✦ ꒱ *Detección de eventos desactivada*.') }
      const estado = chat.detect ? '✅ Activado' : '❌ Desactivado'
      return m.reply(`꒰ ✦ *Detect* ✦ ꒱\n┊⇢ *Estado:* ${estado}\n⸙͎ Uso: *${usedPrefix}detect on/off*`)
    }

    case 'grupinfo':
    case 'gcinfo':
    case 'infogrupo': {
      const meta    = await conn.groupMetadata(m.chat).catch(() => ({}))
      const name    = meta.subject || 'Desconocido'
      const desc    = meta.desc?.toString() || 'Sin descripción'
      const admins  = (meta.participants || []).filter(p => p.admin).map(p => `┊  ✧ @${(p.id || '').split('@')[0]}`).join('\n') || '┊  Sin admins'
      const members = meta.participants?.length || 0
      const created = meta.creation ? new Date(meta.creation * 1000).toLocaleDateString('es') : '?'
      return conn.sendMessage(m.chat, {
        text: `꒰ ✦ *Info del Grupo* ✦ ꒱\n⌜────────────────⌝\n┊⇢ 📛 *Nombre:* ${name}\n┊⇢ 👥 *Miembros:* ${members}\n┊⇢ 📅 *Creado:* ${created}\n┊⇢ 📝 *Descripción:*\n┊  ${desc}\n┊⇢ 👑 *Admins:*\n${admins}\n⌞────────────────⌟`,
        mentions: (meta.participants || []).filter(p => p.admin).map(p => p.id),
      }, { quoted: m })
    }

    case 'setdesc':
    case 'setdescripcion': {
      if (!isBotAdmin) return m.reply('꒰ ✗ ꒱ Necesito ser *admin* para cambiar la descripción.')
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      if (!text) return m.reply(`⸙͎ Uso: *${usedPrefix}setdesc <texto>*`)
      await conn.groupUpdateDescription(m.chat, text)
      return m.reply('꒰ ✦ ꒱ *Descripción actualizada.*')
    }

    case 'setname':
    case 'setnombre': {
      if (!isBotAdmin) return m.reply('꒰ ✗ ꒱ Necesito ser *admin* para cambiar el nombre.')
      if (!isAdmin && !isOwner) return m.reply('꒰ ✗ ꒱ Solo *admins* pueden usar este comando.')
      if (!text) return m.reply(`⸙͎ Uso: *${usedPrefix}setname <nombre>*`)
      await conn.groupUpdateSubject(m.chat, text)
      return m.reply('꒰ ✦ ꒱ *Nombre del grupo actualizado.*')
    }
  }
}

handler.command = [
  'kick', 'expulsar',
  'add', 'agregar',
  'promote', 'ascender',
  'demote', 'degradar',
  'open', 'abrir',
  'close', 'cerrar',
  'link', 'enlace',
  'revokelink', 'resetlink',
  'tagall', 'everyone',
  'hidetag',
  'welcome', 'bienvenida',
  'bye', 'despedida',
  'detect',
  'grupinfo', 'gcinfo', 'infogrupo',
  'setdesc', 'setdescripcion',
  'setname', 'setnombre',
]
handler.tags  = ['grupos']
handler.help  = [
  'kick @user', 'add <num>', 'promote @user', 'demote @user',
  'open', 'close', 'link', 'revokelink',
  'tagall', 'hidetag', 'welcome on/off/set', 'bye on/off/set',
  'detect on/off', 'grupinfo', 'setdesc', 'setname',
]
handler.group = true
export default handler
