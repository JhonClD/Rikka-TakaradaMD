// gacha-trade.js — Intercambio y regalo de waifus
// Portado de YukiBot-MD → Rikka-TakaradaMD

const handler = async (m, { conn, command, args, usedPrefix }) => {
  const db     = global.db.data;
  const chatId = m.chat;
  const userId = m.sender;

  if (!db.chats[chatId]) db.chats[chatId] = {};
  const chatData = db.chats[chatId];

  chatData.gacha_characters = chatData.gacha_characters || {};



  if (chatData.gacha === false) {
    return m.reply(`╰─► El *Gacha* está desactivado en este grupo.\n⇢ Un *admin* puede activarlo con *${usedPrefix}gacha on*`);
  }

  // ─── TRADE ──────────────────────────────────────────────────
  if (['trade', 'intercambiar'].includes(command)) {
    if (chatData.gacha_timeTrade && chatData.gacha_timeTrade - Date.now() > 0) {
      return m.reply('⸙͎ Ya hay un intercambio en curso, espera a que termine o expire.');
    }
    if (!args.length || !m.text.includes('/')) {
      return m.reply(`⸙͎ Uso: *${usedPrefix}trade Personaje1 / Personaje2*`);
    }
    const raw = m.text.slice(m.text.indexOf(' ') + 1).trim();
    const [nameA, nameB] = raw.split('/').map(s => s.trim().toLowerCase());
    const idA = Object.keys(chatData.gacha_characters).find(id =>
      (chatData.gacha_characters[id]?.name || '').toLowerCase() === nameA
    );
    const idB = Object.keys(chatData.gacha_characters).find(id =>
      (chatData.gacha_characters[id]?.name || '').toLowerCase() === nameB
    );
    if (!idA || !idB) {
      return m.reply(`❲ ✗ ❳ No se encontró *${!idA ? nameA : nameB}*`);
    }
    const pA = chatData.gacha_characters[idA];
    const pB = chatData.gacha_characters[idB];
    const valA = global.db.data.characters?.[idA]?.value ?? pA.value ?? 0;
    const valB = global.db.data.characters?.[idB]?.value ?? pB.value ?? 0;
    if (pB.user === userId) return m.reply(`↳ ✗ *${pB.name}* ya es tuyo.`);
    if (!pB.user)           return m.reply(`↳ ✗ *${pB.name}* no tiene dueño.`);
    if (!pA.user || pA.user !== userId) return m.reply(`↳ ✗ *${pA.name}* no es tuyo.`);
    const receiverId = pB.user;
    chatData.gacha_intercambios.push({
      solicitante:  userId,
      personaje1:   { id: idA, name: pA.name, value: valA },
      personaje2:   { id: idB, name: pB.name, value: valB },
      destinatario: receiverId,
      expiracion:   Date.now() + 60000,
    });
    chatData.gacha_timeTrade = Date.now() + 60000;
    const fromName = db.users[userId]?.name      || userId.split('@')[0];
    const toName   = db.users[receiverId]?.name  || receiverId.split('@')[0];
    await conn.sendMessage(chatId, {
      text: `˗ˏˋ Solicitud de intercambio ˎˊ-\n⇢ *${fromName}* → *${toName}*\n\n⇢ *${toName}* ➤ *${pB.name}* (¥${valB})\n⇢ *${fromName}* ➤ *${pA.name}* (¥${valA})\n\n↳ Responde *${usedPrefix}aceptar* para confirmar ˑ expira en *60s*`,
      mentions: [userId, receiverId],
    }, { quoted: m });
    return;
  }

  // ─── ACEPTAR ────────────────────────────────────────────────
  if (['aceptar', 'accept'].includes(command)) {
    // Revisar intercambio activo
    const intercambio = chatData.gacha_intercambios.find(i => i.expiracion > Date.now());
    if (intercambio) {
      if (userId !== intercambio.destinatario) {
        const rName = db.users[intercambio.destinatario]?.name || intercambio.destinatario.split('@')[0];
        return m.reply(`↳ Solo *${rName}* puede aceptar este intercambio.`);
      }
      const pA = chatData.gacha_characters[intercambio.personaje1.id];
      const pB = chatData.gacha_characters[intercambio.personaje2.id];
      if (!pA || !pB) {
        chatData.gacha_intercambios = chatData.gacha_intercambios.filter(i => i !== intercambio);
        return m.reply(`↳ ✗ Uno de los personajes ya no está disponible.`);
      }
      pA.user = intercambio.destinatario;
      pB.user = intercambio.solicitante;
      const scArr = chatData.users[intercambio.solicitante]?.characters  || [];
      const dcArr = chatData.users[intercambio.destinatario]?.characters || [];
      chatData.users[intercambio.solicitante].characters  = [...scArr.filter(id => id !== intercambio.personaje1.id), intercambio.personaje2.id];
      chatData.users[intercambio.destinatario].characters = [...dcArr.filter(id => id !== intercambio.personaje2.id), intercambio.personaje1.id];
      chatData.gacha_intercambios = chatData.gacha_intercambios.filter(i => i !== intercambio);
      chatData.gacha_timeTrade = 0;
      const fromN = db.users[intercambio.solicitante]?.name  || intercambio.solicitante.split('@')[0];
      const toN   = db.users[userId]?.name                   || userId.split('@')[0];
      return conn.sendMessage(chatId, {
        text: `✩ *Intercambio exitoso* ❁\n\n⇢ *${intercambio.personaje1.name}* ➤ *${toN}*\n⇢ *${intercambio.personaje2.name}* ➤ *${fromN}*`,
      }, { quoted: m });
    }

    // Revisar regalo pendiente
    const regalosPend = Array.isArray(chatData.gacha_regalos)
      ? chatData.gacha_regalos
      : Object.values(chatData.gacha_regalos);
    const regalo = regalosPend.find(r => r.chatId === chatId && r.expiresAt > Date.now());
    if (regalo) {
      if (userId !== regalo.sender) {
        const sname = db.users[regalo.sender]?.name || regalo.sender.split('@')[0];
        return m.reply(`↳ Solo *${sname}* puede confirmar esta transferencia.`);
      }
      if (!chatData.users[regalo.to]) chatData.users[regalo.to] = {};
      const receiver = chatData.users[regalo.to];
      if (!Array.isArray(receiver.characters)) receiver.characters = [];
      if (!chatData.users[regalo.sender]) chatData.users[regalo.sender] = {};
      const sender = chatData.users[regalo.sender];
      for (const id of regalo.ids || []) {
        const reg = chatData.gacha_characters[id];
        if (!reg || reg.user !== regalo.sender) continue;
        reg.user = regalo.to;
        if (!receiver.characters.includes(id)) receiver.characters.push(id);
        sender.characters = (sender.characters || []).filter(c => c !== id);
        if (chatData.gacha_sales?.[id]?.user === regalo.sender) delete chatData.gacha_sales[id];
        if (sender.favorite === id) delete sender.favorite;
      }
      const name = db.users[regalo.to]?.name || regalo.to.split('@')[0];
      await conn.sendMessage(chatId, {
        text: `✩ Transferencia exitosa a *${name}* ❁\n⇢ Personajes: *${regalo.count || regalo.ids?.length || 0}*\n⇢ Valor total: *¥${(regalo.value || 0).toLocaleString()}*`,
      }, { quoted: m });
      if (Array.isArray(chatData.gacha_regalos)) {
        chatData.gacha_regalos = chatData.gacha_regalos.filter(r => r !== regalo);
      }
      return;
    }

    return m.reply('↳ No hay ningún intercambio ni regalo pendiente.');
  }
};

handler.command = ['trade', 'intercambiar', 'aceptar', 'accept'];
handler.tags    = ['gacha'];
handler.help    = [
  'trade <char1> / <char2> — Proponer intercambio de waifus',
  'aceptar — Aceptar un intercambio o regalo pendiente',
];
handler.group   = true;

export default handler;
