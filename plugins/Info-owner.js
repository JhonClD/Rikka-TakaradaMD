const handler = async (m, { conn, usedPrefix }) => {
  const text = `
𓂃 ࣪˖ ִֶָ *Rikka Takarada - MD* 𓈈
﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌

𓂃 ࣪˖ *Propietario*
  ˖ *WA:* wa.me/51925092348

𓂃 ࣪˖ *Colaborador*
  ˖ *WA:* wa.me/584262212498
﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌`.trim();

  const mimeTypes = [
    "pdf",
    "zip",
    "vnd.openxmlformats-officedocument.presentationml.presentation",
    "vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  const randomMime = mimeTypes[Math.floor(Math.random() * mimeTypes.length)];
  const menuImage = global.imagen1 ?? Buffer.alloc(0);
  const linkUrl   = "https://wa.me/51925092348";

  await conn.sendMessage(m.chat, {
    document: menuImage,
    mimetype: `application/${randomMime}`,
    fileName: "Rikka Takarada-MD",
    fileLength: 99999999999999,
    pageCount: 200,
    caption: text,
    contextInfo: {
      forwardingScore: 200,
      isForwarded: true,
      externalAdReply: {
        mediaUrl: linkUrl,
        mediaType: 2,
        previewType: "pdf",
        title: "Rikka Takarada - MD",
        body: "Rikka Takarada Bot",
        thumbnail: menuImage,
        sourceUrl: linkUrl,
      },
    },
  }, { quoted: m });
};

handler.help = ["owner"];
handler.tags = ["info"];
handler.command = /^(owner|creator|creador|propietario)$/i;

export default handler;

