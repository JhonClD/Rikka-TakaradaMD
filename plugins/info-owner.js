import { prepareWAMessageMedia } from 'baileys';
import { createJpegPreview } from '../src/libraries/preview.js';

async function createOwnerLinkPreview(conn, input, metadata) {
  if (!conn?.waUploadToServer || !Buffer.isBuffer(input) || input.length === 0) return null;
  try {
    const { imageMessage } = await prepareWAMessageMedia(
      { image: input },
      { upload: conn.waUploadToServer, mediaTypeOverride: 'thumbnail-link' },
    );
    if (!imageMessage) return null;
    return {
      'canonical-url': metadata.url,
      'matched-text': metadata.url,
      title: metadata.title,
      description: metadata.description,
      jpegThumbnail: imageMessage.jpegThumbnail
        ? Buffer.from(imageMessage.jpegThumbnail)
        : undefined,
      highQualityThumbnail: imageMessage,
    };
  } catch (error) {
    console.warn('[owner-preview] no se pudo preparar thumbnail-link:', error?.message || error);
    return null;
  }
}

const handler = async (m, { conn }) => {
  const sourceUrl = 'https://wa.me/51925092348';
  const text = `
𓂃 ࣪˖ ִֶָ *Rikka Takarada - MD* 𓈈
﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌

𓂃 ࣪˖ *Propietario*
  ˖ *WA:* wa.me/51925092348
  ˖ *Enlace:* ${sourceUrl}

𓂃 ࣪˖ *Colaborador*
  ˖ *WA:* wa.me/51997149670
﹌﹌﹌﹌﹌﹌﹌﹌﹌﹌`.trim();

  const sourceImage = global.imagen1;
  const linkPreview = await createOwnerLinkPreview(conn, sourceImage, {
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
