const handler = async (m, { conn, args, isOwner }) => {
  if (!isOwner) return m.reply('꒰ ✗ ꒱ Solo el *owner* puede usar este comando.');
  if (!args[0]) return m.reply('꒰ ✰ ꒱ Ingresa el enlace del grupo para unir el bot.');

  const linkRegex = /chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/i;
  const match = args[0].match(linkRegex);
  if (!match || !match[1]) return m.reply('꒰ ✗ ꒱ El enlace ingresado no es válido o está incompleto.');

  try {
    await conn.groupAcceptInvite(match[1]);
    await m.reply('╰─► ✰ El bot se ha unido exitosamente al grupo ♡');
  } catch (e) {
    const errMsg = String(e.message || e);
    if (errMsg.includes('not-authorized') || errMsg.includes('requires-admin')) {
      return m.reply('┊ ➛ La unión requiere aprobación de administrador.\n╰─► Espera a que acepten la solicitud.');
    } else if (errMsg.includes('not-in-group') || errMsg.includes('removed')) {
      return m.reply('꒰ ✗ ꒱ No se pudo unir al grupo porque el bot fue eliminado recientemente.');
    } else {
      return m.reply('꒰ ✗ ꒱ No se pudo unir al grupo, verifica el enlace o los permisos.');
    }
  }
};

handler.help = ['join <link>'];
handler.tags = ['owner'];
handler.command = ['join', 'unir'];
handler.owner = true;

export default handler;
