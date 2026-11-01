import { createLinkPreview, createJpegPreview } from '../src/libraries/preview.js';

const handler = async (m, { conn }) => {
  const text = `
𓂃 ࣪˖ ִֶָ *Rikka Takarada - MD* 𓈈
﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌

𓂃 ࣪˖ *Propietario*
  ˖ *WA:* wa.me/51925092348

𓂃 ࣪˖ *Colaborador*
  ˖ *WA:* wa.me/51997149670
﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌`.trim();

  const sourceUrl = 'https://wa.me/51925092348';
  const sourceImage = global.imagen1;
  const linkPreview = await createLinkPreview(conn, sourceImage, {
    url: sourceUrl,
    title: 'Rikka Takarada - MD',
    description: 'Información del propietario',
  });
  const thumbnail = linkPreview ? null : await createJpegPreview(sourceImage);

  await conn.sendMessage(m.chat, {
    text,
    ...(linkPreview ? { linkPreview } : {}),
    ...(!linkPreview && thumbnail ? {
      contextInfo: {
        externalAdReply: {
          title: 'Rikka Takarada - MD',
          body: 'Información del propietario',
          mediaType: 1,
          thumbnail,
          mediaUrl: sourceUrl,
          sourceUrl,
          renderLargerThumbnail: false,
          showAdAttribution: false,
        },
      },
    } : {}),
  }, { quoted: m });
};

handler.help = ['owner'];
handler.tags = ['info'];
handler.command = /^(owner|creator|creador|propietario)$/i;

export default handler;
