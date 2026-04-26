const handler = async (m, { conn, usedPrefix }) => {
  const isOwner =
    (global.owner || []).some(([num]) => m.sender.startsWith(num)) ||
    m.sender.startsWith(global.nomorown || '');

  if (!isOwner) return m.reply('❌ Solo el *owner* puede reiniciar el bot.');

  await m.reply(
    `🔄 *Reiniciando bot...*\n\n` +
    `╰┈➤ Espera unos segundos y vuelve a escribir.\n` +
    `╰┈➤ Si no responde en 30s, reinicia manualmente.`
  );

  // Pequeña pausa para que el mensaje se envíe antes de reiniciar
  await new Promise(r => setTimeout(r, 2000));

  // Envía señal al proceso padre (index.js) que escucha 'reset'
  process.send('reset');
};

handler.help = ['reiniciar', 'restart'];
handler.tags = ['owner'];
handler.command = /^(reiniciar|restart|reboot|reset)$/i;
handler.owner = true;

export default handler;

