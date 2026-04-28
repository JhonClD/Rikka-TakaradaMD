import axios from 'axios';
import cheerio from 'cheerio';

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `*⚠️ Ingresa un enlace de TikTok.*\n\n*Ejemplo:* .${command} https://vt.tiktok.com/ZS12345/`;
  if (!/(?:https:?\/{2})?(?:w{3}|vm|vt|t)?\.?tiktok.com\/([^\s&]+)/gi.test(text)) throw '*❌ El enlace no parece ser de TikTok.*';

  try {
    // INTENTO 1: Scraping instatiktok.com
    let videoUrl = null;
    const links = await fetchDownloadLinks(args[0], 'tiktok');

    if (links && links.length > 0) {
      videoUrl = links.find(link => /hdplay/i.test(link)) || links.find(link => /download/i.test(link)) || links[0];
    }

    // INTENTO 2: Fallback con APIs estables (Forzando calidad HD)
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
          videoUrl = json.data?.hdplay || json.data?.play || json.data?.url || json.result?.url || (Array.isArray(json.data) ? json.data[0].url : null);
          if (videoUrl) break;
        } catch (err) {
          console.log(`[API Fallback Error] ${api}:`, err.message);
          continue;
        }
      }
    }

    if (!videoUrl) throw new Error('Sin resultados');

    const cap = `✅ *Video descargado*`;
    await conn.sendMessage(m.chat, { video: { url: videoUrl }, caption: cap }, { quoted: m });

  } catch (e) {
    console.error(e);
    throw '*❌ Ocurrió un error al descargar el video. Inténtalo de nuevo más tarde.*';
  }
};

handler.help = ['tiktok'];
handler.tags = ['downloader'];
handler.command = /^(tiktok|ttdl|tiktokdl|tiktoknowm|tt|ttnowm|tiktokaudio)$/i;

export default handler;

// --- FUNCIONES DE APOYO ---

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
