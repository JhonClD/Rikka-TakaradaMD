const handler = async (m, { conn, command, usedPrefix, args, participants, groupMetadata }) => {
  const botId = conn.decodeJid(conn.user.id);
  const ownerGroup = groupMetadata?.owner || m.chat.split('-')[0] + '@s.whatsapp.net';
  const ownerBot = (Array.isArray(global.owner) ? global.owner[0] : global.owner) + '@s.whatsapp.net';

  if (['kick', 'ban', 'bang'].includes(command)) {
    if (args[0] === 'num' || args[0] === 'listnum') {
      if (!args[1]) return m.reply(`《✧》 Ingresa un prefijo de país.\n> ✎ Ejemplo: *${usedPrefix + command} num +54*`);
      const prefix = args[1].replace(/[+]/g, '');
      const conPrefix = participants.map(p => p.id).filter(jid => jid && jid !== botId && jid.split('@')[0].startsWith(prefix));
      if (conPrefix.length === 0) return m.reply(`《✧》 No hay números con prefijo +${prefix} en este grupo.`);
      if (args[0] === 'listnum') {
        const lista = conPrefix.map(v => '⭔ @' + v.replace(/@.+/, '')).join('\n');
        return conn.sendMessage(m.chat, { text: `《✧》 *Usuarios con prefijo +${prefix}* (${conPrefix.length})\n\n${lista}`, mentions: conPrefix }, { quoted: m });
      }
      const aExpulsar = conPrefix.filter(jid => {
        const p = participants.find(x => x.id === jid);
        return p && p.admin !== 'admin' && p.admin !== 'superadmin' && jid !== ownerGroup && jid !== ownerBot;
      });
      if (aExpulsar.length === 0) return m.reply(`《✧》 Todos los usuarios con +${prefix} son admins o propietarios.`);
      await m.reply(`《✧》 *Eliminando usuarios con prefijo +${prefix}* (${aExpulsar.length})…`);
      let eliminados = 0, errores = [];
      for (const jid of aExpulsar) {
        try { await conn.groupParticipantsUpdate(m.chat, [jid], 'remove'); eliminados++; await new Promise(r => setTimeout(r, 3000)); }
        catch (e) { errores.push(`@${jid.split('@')[0]}: ${e.message}`); }
      }
      let res = `《✧》 Proceso completado.\n> Eliminados: *${eliminados}*`;
      if (errores.length) res += `\n> Errores: *${errores.length}*\n${errores.join('\n')}`;
      return m.reply(res);
    }

    if (args[0] === 'all') {
      const aExpulsar = participants.filter(p => p.id && p.id !== botId && p.id !== ownerGroup && p.id !== ownerBot && p.admin !== 'admin' && p.admin !== 'superadmin').map(p => p.id);
      if (aExpulsar.length === 0) return m.reply('《✧》 No hay usuarios para eliminar (todos son admins o propietarios).');
      await m.reply(`《✧》 *Eliminando todos los usuarios* (${aExpulsar.length})…`);
      let eliminados = 0, errores = [];
      for (const jid of aExpulsar) {
        try { await conn.groupParticipantsUpdate(m.chat, [jid], 'remove'); eliminados++; await new Promise(r => setTimeout(r, 3000)); }
        catch (e) { errores.push(`@${jid.split('@')[0]}: ${e.message}`); }
      }
      let res = `《✧》 Proceso completado.\n> Eliminados: *${eliminados}*`;
      if (errores.length) res += `\n> Errores: *${errores.length}*`;
      return m.reply(res);
    }

    if (args[0] === 'inactive' || args[0] === 'listinactive') {
      const allChatUsers = global.db.data.chats[m.chat]?.users || {};
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const inactivos = [];
      for (const p of participants) {
        const jid = p.id;
        if (!jid || jid === botId || jid === ownerGroup || jid === ownerBot) continue;
        if (p.admin === 'admin' || p.admin === 'superadmin') continue;
        const u = allChatUsers[jid];
        const usedTime = u?.usedTime ? (typeof u.usedTime === 'number' ? u.usedTime : new Date(u.usedTime).getTime()) : 0;
        const totalMsgs = Object.entries(u?.stats || {}).filter(([d]) => new Date(d) >= new Date(cutoff)).reduce((acc, [, v]) => acc + (v.msgs || 0), 0);
        if (!u || (usedTime < cutoff && totalMsgs === 0)) inactivos.push(jid);
      }
      if (inactivos.length === 0) return m.reply('《✧》 Este grupo es activo, no hay inactivos (30 días).');
      if (args[0] === 'listinactive') {
        const lista = inactivos.map(v => '⭔ @' + v.replace(/@.+/, '')).join('\n');
        return conn.sendMessage(m.chat, { text: `《✧》 *Lista de inactivos* (${inactivos.length})\n\n${lista}`, mentions: inactivos }, { quoted: m });
      }
      await m.reply(`《✧》 *Eliminando inactivos* (${inactivos.length})…`);
      let eliminados = 0, errores = [];
      for (const jid of inactivos) {
        try { await conn.groupParticipantsUpdate(m.chat, [jid], 'remove'); eliminados++; await new Promise(r => setTimeout(r, 3000)); }
        catch (e) { errores.push(`@${jid.split('@')[0]}: ${e.message}`); }
      }
      let res = `《✧》 Proceso completado. Eliminados: *${eliminados}*`;
      if (errores.length) res += `\n> Errores: [${errores.join(', ')}]`;
      return m.reply(res);
    }

    const targetRaw = m.mentionedJid?.[0] || m.quoted?.sender;
    if (!targetRaw) return m.reply(`《✧》 Etiqueta o responde al usuario que quieres eliminar.\n\n✎ *Opciones:*\n> *${usedPrefix + command} num +57* — por prefijo\n> *${usedPrefix + command} listnum +57* — listar por prefijo\n> *${usedPrefix + command} all* — todos\n> *${usedPrefix + command} inactive* — inactivos (30 días)\n> *${usedPrefix + command} listinactive* — listar inactivos`);
    const userBase = targetRaw.split('@')[0];
    const participant = participants.find(p => p.id?.split('@')[0] === userBase || p.lid?.split('@')[0] === userBase);
    if (!participant) return conn.sendMessage(m.chat, { text: `《✧》 @${userBase} ya no está en el grupo.`, mentions: [targetRaw] }, { quoted: m });
    const realJid = participant.id || targetRaw;
    if (realJid === botId) return m.reply('《✧》 No puedo eliminarme a mí mismo del grupo.');
    if (realJid === ownerGroup) return m.reply('《✧》 No puedo eliminar al propietario del grupo.');
    if (realJid === ownerBot) return m.reply('《✧》 No puedo eliminar al propietario del bot.');
    try {
      await conn.groupParticipantsUpdate(m.chat, [realJid], 'remove');
      conn.sendMessage(m.chat, { text: `✎ @${userBase} *eliminado* correctamente.`, mentions: [targetRaw] }, { quoted: m });
    } catch (e) {
      m.reply(`> Error al ejecutar *${usedPrefix + command}*: ${e.message}`);
    }
    return;
  }

  if (['promote', 'promover'].includes(command)) {
    const who = m.mentionedJid?.[0] || m.quoted?.sender;
    if (!who) return m.reply('《✧》 Menciona al usuario que deseas promover a administrador.');
    const whoBase = who.split('@')[0];
    const participant = participants.find(p => p.id?.split('@')[0] === whoBase || p.lid?.split('@')[0] === whoBase);
    if (participant?.admin) return conn.sendMessage(m.chat, { text: `《✧》 *@${whoBase}* ya es administrador del grupo.`, mentions: [who] }, { quoted: m });
    const targetJid = participant?.id || who;
    try {
      await conn.groupParticipantsUpdate(m.chat, [targetJid], 'promote');
      conn.sendMessage(m.chat, { text: `✿ *@${whoBase}* ha sido promovido a administrador del grupo.`, mentions: [who] }, { quoted: m });
    } catch (e) {
      m.reply(`> Error al ejecutar *${usedPrefix + command}*: ${e.message}`);
    }
    return;
  }

  if (['demote', 'degradar'].includes(command)) {
    const who = m.mentionedJid?.[0] || m.quoted?.sender;
    if (!who) return m.reply('《✧》 Menciona al usuario que deseas degradar de administrador.');
    const whoBase = who.split('@')[0];
    const participant = participants.find(p => p.id?.split('@')[0] === whoBase || p.lid?.split('@')[0] === whoBase);
    if (!participant?.admin) return conn.sendMessage(m.chat, { text: `《✧》 *@${whoBase}* no es administrador del grupo.`, mentions: [who] }, { quoted: m });
    const targetJid = participant?.id || who;
    if (targetJid === ownerGroup) return m.reply('《✧》 No puedes degradar al creador del grupo.');
    if (targetJid === ownerBot) return m.reply('《✧》 No puedes degradar al propietario del bot.');
    if (targetJid === botId) return m.reply('《✧》 No puedes degradar al bot.');
    try {
      await conn.groupParticipantsUpdate(m.chat, [targetJid], 'demote');
      conn.sendMessage(m.chat, { text: `✿ *@${whoBase}* ha sido degradado de administrador.`, mentions: [who] }, { quoted: m });
    } catch (e) {
      m.reply(`> Error al ejecutar *${usedPrefix + command}*: ${e.message}`);
    }
  }
};

handler.command = ['kick', 'ban', 'bang', 'promote', 'promover', 'demote', 'degradar'];
handler.tags = ['group'];
handler.group = true;
handler.admin = true;
handler.botAdmin = true;

export default handler;
