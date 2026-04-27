import axios from 'axios';
import cheerio from 'cheerio';

const MAX_VIDEO_MB = 16;

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `📎 Ingresa un enlace de TikTok.\n_${usedPrefix + command} https://vt.tiktok.com/ZS12345/_`;
  if (!/(?:https?:\/\/)?(?:www\.|vm\.|vt\.|t\.)?tiktok\.com\/([^\s&]+)/gi.test(text))
    throw "❌ El enlace no parece ser de TikTok.";

  let videoUrl = null;

  // 1. Intentar con instatiktok
  const links = await fetchDownloadLinks(args[0], 'tiktok');
  if (links?.length) {
    videoUrl = links.find(l => /hdplay/i.test(l)) || links.find(l => /download/i.test(l)) || links[0];
  }

  // 2. Fallback a APIs externas
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
        videoUrl = json.data?.hdplay || json.data?.play || json.data?.url
                || json.result?.url || (Array.isArray(json.data) ? json.data[0].url : null);
        if (videoUrl) break;
      } catch { continue; }
    }
  }

  if (!videoUrl) throw "❌ No se pudo obtener el video. Inténtalo de nuevo.";

  // 3. Descargar buffer para verificar tamaño
  const response = await axios.get(videoUrl, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);
  const sizeMB = buffer.length / (1024 * 1024);

  if (sizeMB > MAX_VIDEO_MB) {
    // Enviar como documento si es muy grande
    await conn.sendMessage(m.chat, {
      document: buffer,
      mimetype: 'video/mp4',
      fileName: 'tiktok_video.mp4',
      caption: `✅ *Video descargado* (${sizeMB.toFixed(1)} MB)\n_Enviado como documento por superar ${MAX_VIDEO_MB} MB_`
    }, { quoted: m });
  } else {
    await conn.sendMessage(m.chat, {
      video: buffer,
      caption: `✅ *Video descargado* (${sizeMB.toFixed(1)} MB)`
    }, { quoted: m });
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
        'Origin': SITE_URL, 'Referer': SITE_URL,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
  } catch { return null; }
  }
