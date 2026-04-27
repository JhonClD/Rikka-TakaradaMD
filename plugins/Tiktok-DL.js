import axios from 'axios';
import cheerio from 'cheerio';

/** Detecta si una URL apunta a audio (por extensión o Content-Type) */
async function isAudioUrl(url) {
  if (/\.(mp3|m4a|aac|ogg|wav)(\?|$)/i.test(url)) return true;
  try {
    const { headers } = await axios.head(url, { timeout: 5000 });
    const ct = headers['content-type'] || '';
    return ct.startsWith('audio/');
  } catch {
    return false;
  }
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `📎 Ingresa un enlace de TikTok.\n_${usedPrefix + command} https://vt.tiktok.com/ZS12345/_`;
  if (!/(?:https?:\/\/)?(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/([^\s&]+)/gi.test(text)) throw "❌ El enlace no parece ser de TikTok.";

  try {
    const encoded = encodeURIComponent(args[0]);
    let videoUrl = null;
    let audioUrl = null;
    let isSlideshow = false;
    let slideshowImages = [];

    // --- 1. tikwm (más completo: devuelve type, images, music) ---
    try {
      const { data: json } = await axios.get(`https://www.tikwm.com/api/?url=${encoded}&hd=1`);
      const d = json?.data;
      if (d) {
        isSlideshow = d.images && Array.isArray(d.images) && d.images.length > 0;
        if (isSlideshow) {
          slideshowImages = d.images;
          audioUrl = d.music;
        } else {
          videoUrl = d.hdplay || d.play || null;
          audioUrl = d.music || null;
        }
      }
    } catch (err) {
      console.log('[tikwm error]', err.message);
    }

    // --- 2. Scraper instatiktok (fallback) ---
    if (!videoUrl && !isSlideshow) {
      const links = await fetchDownloadLinks(args[0], 'tiktok');
      if (links && links.length > 0) {
        videoUrl = links.find(l => /hdplay/i.test(l)) || links.find(l => /download/i.test(l)) || links[0];
      }
    }

    // --- 3. APIs adicionales de fallback ---
    if (!videoUrl && !isSlideshow) {
      const fallbackApis = [
        `https://api.vreden.my.id/api/tiktok?url=${encoded}`,
        `https://luminai.my.id/api/download/tiktok?url=${encoded}`
      ];
      for (const api of fallbackApis) {
        try {
          const { data: json } = await axios.get(api);
          videoUrl = json.data?.hdplay || json.data?.play || json.data?.url || json.result?.url
                     || (Array.isArray(json.data) ? json.data[0]?.url : null);
          if (videoUrl) break;
        } catch (err) {
          console.log(`[Fallback error] ${api}:`, err.message);
        }
      }
    }

    // --- Enviar según tipo de contenido ---
    if (isSlideshow) {
      await conn.sendMessage(m.chat, { text: `🖼️ *Slideshow de ${slideshowImages.length} imagen(es)*` }, { quoted: m });
      for (const imgUrl of slideshowImages) {
        await conn.sendMessage(m.chat, { image: { url: imgUrl } });
      }
      if (audioUrl) {
        await conn.sendMessage(m.chat, { audio: { url: audioUrl }, mimetype: 'audio/mp4', ptt: false });
      }
      return;
    }

    if (!videoUrl) throw "no_url";

    // Verificar si lo que obtuvimos es audio en lugar de video
    const esAudio = await isAudioUrl(videoUrl);
    if (esAudio) {
      await conn.sendMessage(m.chat, {
        audio: { url: videoUrl },
        mimetype: 'audio/mp4',
        ptt: false
      }, { quoted: m });
      await conn.sendMessage(m.chat, { text: '🎵 *Solo se encontró el audio de este TikTok*' });
    } else {
      await conn.sendMessage(m.chat, {
        video: { url: videoUrl },
        caption: '✅ *Video descargado*'
      }, { quoted: m });
    }

  } catch (e) {
    if (e !== "no_url") console.error(e);
    throw "❌ No se pudo descargar el video. Inténtalo de nuevo.";
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
