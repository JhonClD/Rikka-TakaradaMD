import axios from 'axios';
import cheerio from 'cheerio';

const MAX_VIDEO_MB = 16;

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `📎 Ingresa un enlace de TikTok.\n_${usedPrefix + command} https://vt.tiktok.com/ZS12345/_`;
  if (!/(?:https?:\/\/)?(?:www\.|vm\.|vt\.|t\.)?tiktok\.com\/([^\s&]+)/gi.test(text))
    throw "❌ El enlace no parece ser de TikTok.";

  let hdUrl = null;
  let sdUrl = null;

  // 1. Intentar con instatiktok
  const links = await fetchDownloadLinks(args[0], 'tiktok');
  if (links?.length) {
    hdUrl = links.find(l => /hdplay/i.test(l));
    sdUrl = links.find(l => /download/i.test(l)) || links[0];
  }

  // 2. Fallback a tikwm (devuelve HD y SD por separado)
  if (!hdUrl && !sdUrl) {
    try {
      const encoded = encodeURIComponent(args[0]);
      const { data: json } = await axios.get(`https://www.tikwm.com/api/?url=${encoded}&hd=1`);
      hdUrl = json.data?.hdplay || null;
      sdUrl = json.data?.play || null;
    } catch { /* continúa */ }
  }

  // 3. Fallback a otras APIs
  if (!hdUrl && !sdUrl) {
    const encoded = encodeURIComponent(args[0]);
    for (const api of [
      `https://api.vreden.my.id/api/tiktok?url=${encoded}`,
      `https://luminai.my.id/api/download/tiktok?url=${encoded}`
    ]) {
      try {
        const { data: json } = await axios.get(api);
        sdUrl = json.data?.url || json.result?.url || (Array.isArray(json.data) ? json.data[0].url : null);
        if (sdUrl) break;
      } catch { continue; }
    }
  }

  if (!hdUrl && !sdUrl) throw "❌ No se pudo obtener el video. Inténtalo de nuevo.";

  // 4. Verificar tamaño con HEAD (sin descargar)
  const checkSize = async (url) => {
    try {
      const { headers } = await axios.head(url, { timeout: 5000 });
      const bytes = parseInt(headers['content-length'] || '0');
      return bytes / (1024 * 1024); // MB
    } catch { return 999; } // Si falla, asumir grande
  };

  // Preferir HD, pero si es muy grande intentar SD
  let videoUrl = hdUrl || sdUrl;
  let sizeMB = await checkSize(videoUrl);

  if (sizeMB > MAX_VIDEO_MB && hdUrl && sdUrl) {
    // Probar SD como alternativa
    const sdSize = await checkSize(sdUrl);
    if (sdSize < sizeMB) {
      videoUrl = sdUrl;
      sizeMB = sdSize;
    }
  }

  // 5. Enviar según tamaño — sin descargar buffer en el bot
  if (sizeMB > MAX_VIDEO_MB) {
    await conn.sendMessage(m.chat, {
      document: { url: videoUrl },
      mimetype: 'video/mp4',
      fileName: 'tiktok_video.mp4',
      caption: `✅ *Video descargado* (${sizeMB > 0 ? sizeMB.toFixed(1) + ' MB' : 'tamaño desconocido'})\n_Enviado como documento por superar ${MAX_VIDEO_MB} MB_`
    }, { quoted: m });
  } else {
    await conn.sendMessage(m.chat, {
      video: { url: videoUrl },
      caption: `✅ *Video descargado*`
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
