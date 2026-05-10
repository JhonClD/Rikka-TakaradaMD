/**
 * broadcast-grupos.js
 * Envía un mensaje a todos los grupos donde está el bot.
 *
 * Comandos (solo owner/rowner):
 *   .broadcast <mensaje>   → Envía el texto a todos los grupos
 *   .bc <mensaje>          → Alias corto
 *   .broadcast (reply)     → Reenvía la imagen/video/audio/sticker a todos
 *
 * Ejemplos:
 *   .broadcast ¡Hola a todos los grupos! 🎉
 *   .bc Aviso importante: el bot estará en mantenimiento esta noche.
 */

const handler = async (m, { conn, text, args }) => {
  // Verificar que haya algo que enviar
  const quoted = m.quoted ? m.quoted : m;
  const mtype  = quoted?.mtype || '';
  const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'].includes(mtype);

  if (!text && !isMedia) {
    return conn.reply(
      m.chat,
      `_*< PROPIETARIO - BROADCAST />*_\n\n*[ ❓ ] Uso:*\n• *.broadcast <mensaje>*\n• *.bc <mensaje>*\n• *(responde un medio)* *.broadcast [pie de foto]*\n\n_Enviará el mensaje a todos los grupos donde esté el bot._`,
      m
    );
  }

  // Obtener lista de todos los grupos
  await conn.reply(m.chat, `_*< PROPIETARIO - BROADCAST />*_\n\n*[ ⏳ ] Obteniendo lista de grupos...*`, m);

  let grupos;
  try {
    const chats = await conn.groupFetchAllParticipating();
    grupos = Object.keys(chats);
  } catch (e) {
    return conn.reply(m.chat, `_*< PROPIETARIO - BROADCAST />*_\n\n*[ ❌ ] Error al obtener grupos:* ${e.message}`, m);
  }

  if (!grupos.length) {
    return conn.reply(m.chat, `_*< PROPIETARIO - BROADCAST />*_\n\n*[ ⚠️ ] No se encontraron grupos.*`, m);
  }

  let enviados  = 0;
  let fallidos  = 0;
  const delay   = (ms) => new Promise((r) => setTimeout(r, ms));

  await conn.reply(
    m.chat,
    `_*< PROPIETARIO - BROADCAST />*_\n\n*[ 📡 ] Enviando a ${grupos.length} grupo(s)...*\n_Espera mientras se completa el envío._`,
    m
  );

  for (const jid of grupos) {
    try {
      if (isMedia) {
        // Reenviar el medio con caption opcional
        const media  = await quoted.download();
        const caption = text || '';

        if (mtype === 'imageMessage') {
          await conn.sendMessage(jid, { image: media, caption });
        } else if (mtype === 'videoMessage') {
          await conn.sendMessage(jid, { video: media, caption });
        } else if (mtype === 'audioMessage') {
          await conn.sendMessage(jid, { audio: media, mimetype: 'audio/mp4', ptt: quoted.message?.audioMessage?.ptt || false });
        } else if (mtype === 'stickerMessage') {
          await conn.sendMessage(jid, { sticker: media });
        } else if (mtype === 'documentMessage') {
          await conn.sendMessage(jid, {
            document: media,
            mimetype: quoted.message?.documentMessage?.mimetype || 'application/octet-stream',
            fileName: quoted.message?.documentMessage?.fileName || 'archivo',
            caption
          });
        }
      } else {
        // Solo texto
        await conn.sendMessage(jid, { text });
      }

      enviados++;
      // Pausa entre envíos para evitar ban/spam de WhatsApp
      await delay(1500);
    } catch (err) {
      fallidos++;
      console.error(`[Broadcast] Error en ${jid}:`, err.message);
      await delay(500);
    }
  }

  // Reporte final
  const reporte = [
    `_*< PROPIETARIO - BROADCAST />*_`,
    ``,
    `*[ ✅ ] Broadcast completado.*`,
    ``,
    `*📊 Resumen:*`,
    `• *Grupos totales:* ${grupos.length}`,
    `• *Enviados:*  ✅ ${enviados}`,
    `• *Fallidos:*  ❌ ${fallidos}`
  ].join('\n');

  conn.reply(m.chat, reporte, m);
};

handler.help    = ['broadcast <mensaje>', 'bc <mensaje>'];
handler.tags    = ['owner'];
handler.command = /^(broadcast|bc)$/i;
handler.rowner  = true;

export default handler;
