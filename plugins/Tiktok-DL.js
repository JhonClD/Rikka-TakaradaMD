import axios from 'axios';
import cheerio from 'cheerio';

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `📎 Ingresa un enlace de TikTok.\n_${usedPrefix + command} https://vt.tiktok.com/ZS12345/ _`;
  if (!/(?:https:?\/{2})?(?:w{3}|vm|vt|t)?\.?tiktok.com\/([^\s&]+)/gi.test(text)) throw "❌ El enlace no parece ser de TikTok.";

  try {
    let videoUrl = null;

    // Intento 1: scraping (solo enlaces hdplay)
    const links = await fetchDownloadLinks(args[0], 'tiktok');
    if (links && links.length > 0) {
      videoUrl = links.find(link => /hdplay/i.test(link));
    }

    // Intento 2: APIs, solo hdplay — nunca SD (play)
    if (!videoUrl) {
      const encoded = encodeURIComponent(args[0]);
      const apis = [
        `https://www.tikwm.com/api/?url=${encoded}&hd=1`,
        `https://api.vreden.my.id/api/tiktok?url=${encoded}`,
        `https://luminai.my.id/api/download/tiktok?url=${encoded}`
      ];

      for (const api of apis) {
        try {
          const { data: json } = await axios.get(api);
          // Solo acepta hdplay, nunca play (SD)
          videoUrl = json.data?.hdplay || json.data?.hd || null;
          if (videoUrl) break;
        } catch (err) {
          console.log(`[API Fallback Error] ${api}:`, err.message);
          continue;
        }
      }
    }

    if (!videoUrl) throw "❌ No se encontró versión HD del video. Inténtalo de nuevo.";

    // Descargar como buffer para medir tamaño
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw '❌ No se pudo descargar el video.';
    const buffer = Buffer.from(await videoRes.arrayBuffer());
    const sizeMB = buffer.length / (1024 * 1024);

    // Intentar obtener nombre del video desde la URL
    const videoName = videoUrl.split('/').pop()?.split('?')[0] || 'tiktok_video.mp4';

    if (sizeMB > 10) {
      // Más de 10MB → documento
      await conn.sendMessage(m.chat, {
        document: buffer,
        mimetype: 'video/mp4',
        fileName: videoName.endsWith('.mp4') ? videoName : videoName + '.mp4',
        caption: '✅ *Video descargado*'
      }, { quoted: m });
    } else {
      // Menos de 10MB → video normal
      await conn.sendMessage(m.chat, {
        video: buffer,
        mimetype: 'video/mp4',
        caption: '✅ *Video descargado*'
      }, { quoted: m });
    }

  } catch (e) {
    console.error(e);
    throw typeof e === 'string' ? e : "❌ No se pudo descargar el video. Inténtalo de nuevo.";
  }
};

handler.help = ['tiktok'];
handler.tags = ['downloader'];
handler.command = /^(tiktok|ttdl|tiktokdl|tiktoknowm|tt|ttnowm|tiktokaudio)$/i;

export default handler;

async function fetchDownloadLinks(text, platform) {
  try {
    const SITE_URL = 'https://instatiktok.com/';
    const form = new URLSearchParams();
    form.append('url', text);
    form.append('platform', platform);

    const res = await axios.post(`${SITE_URL}api`, form.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': SITE_URL,
        'Referer': SITE_URL,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });

    const html = res?.data?.html;
    if (!html || res?.data?.status !== 'success') return null;

    const $ = cheerio.load(html);
    const links = [];
    $('a.btn[href^="http"]').each((_, el) => {
      const link = $(el).attr('href');
      if (link && !links.includes(link)) links.push(link);
    });
    return links;
  } catch {
    return null;
  }
}
