import axios from 'axios';
import cheerio from 'cheerio';

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `📎 Ingresa un enlace de TikTok.\n_${usedPrefix + command} https://vt.tiktok.com/ZS12345/_`;
  if (!/(?:https?:\/\/)?(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s&]+/gi.test(text))
    throw '❌ El enlace no parece ser de TikTok.';

  const url     = args[0];
  const encoded = encodeURIComponent(url);

  // ─── APIs en orden de preferencia ────────────────────────────────────────────
  const APIs = [
    // 1. instatiktok scraper (HD preferido)
    async () => {
      const links = await fetchInstatiktok(url);
      if (!links?.length) return null;
      return links.find(l => /hdplay/i.test(l)) || links.find(l => /download/i.test(l)) || links[0];
    },
    // 2. tikwm HD
    async () => {
      const { data: j } = await axios.get(`https://www.tikwm.com/api/?url=${encoded}&hd=1`, { timeout: 10000 });
      return j?.data?.hdplay || j?.data?.play || null;
    },
    // 3. SnapTik
    async () => {
      const res  = await axios.post('https://snaptik.app/abc2.php',
        new URLSearchParams({ url, token: '' }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
      const $    = cheerio.load(res.data?.html || res.data || '');
      const link = $('a[href*="tikcdn"]').attr('href') || $('a[href*="download"]').first().attr('href');
      return link || null;
    },
    // 4. SSSTik
    async () => {
      const res  = await axios.post('https://sssstik.io/app/upload',
        new URLSearchParams({ id: url }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, timeout: 10000 });
      const $    = cheerio.load(res.data || '');
      const link = $('a[href^="http"]').attr('href');
      return link || null;
    },
    // 5. TikSave
    async () => {
      const { data: j } = await axios.get(`https://tiksave.net/api/?url=${encoded}`, { timeout: 10000 });
      return j?.data?.play || j?.url || null;
    },
    // 6. api.vreden
    async () => {
      const { data: j } = await axios.get(`https://api.vreden.my.id/api/tiktok?url=${encoded}`, { timeout: 10000 });
      return j?.result?.url || null;
    },
    // 7. Alyacid
    async () => {
      const { data: j } = await axios.get(`https://api.alyacid.my.id/api/tiktok?url=${encoded}`, { timeout: 10000 });
      return j?.data?.video?.noWatermark || j?.data?.play || null;
    },
    // 8. Naxdr
    async () => {
      const { data: j } = await axios.get(`https://api.naxdr.com/tiktok/dl?url=${encoded}`, { timeout: 10000 });
      return j?.data?.play || j?.url || null;
    },
    // 9. luminai
    async () => {
      const { data: j } = await axios.get(`https://luminai.my.id/api/download/tiktok?url=${encoded}`, { timeout: 10000 });
      return j?.data?.url || null;
    },
    // 10. Tikmate
    async () => {
      const { data: j } = await axios.post('https://tikmate.online/api/lookup',
        new URLSearchParams({ url }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
      return j?.token ? `https://tikmate.online/download/${j.token}/${j.id}.mp4` : null;
    },
  ];

  try {
    let videoUrl  = null;
    let usedApi   = '—';

    for (let i = 0; i < APIs.length; i++) {
      try {
        const result = await APIs[i]();
        if (result) { videoUrl = result; usedApi = `API #${i + 1}`; break; }
      } catch (err) {
        console.log(`[TikTok API #${i + 1} Error]`, err.message);
      }
    }

    if (!videoUrl) throw '❌ No se pudo descargar el video con ninguna fuente.';

    // ─── Verificar tamaño antes de enviar ────────────────────────────────────
    let fileSize = 0;
    try {
      const head = await axios.head(videoUrl, { timeout: 8000 });
      fileSize   = parseInt(head.headers['content-length'] || '0');
    } catch (_) {}

    const LIMIT_MB  = 10;
    const limitBytes = LIMIT_MB * 1024 * 1024;

    if (fileSize > limitBytes) {
      // Descargar y enviar como documento con nombre
      const res      = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000 });
      const buffer   = Buffer.from(res.data);
      const sizeMB   = (buffer.length / 1024 / 1024).toFixed(2);
      const fileName = `TikTok_${Date.now()}.mp4`;

      await conn.sendMessage(m.chat, {
        document : buffer,
        fileName,
        mimetype : 'video/mp4',
        caption  : `✅ *TikTok descargado como documento*\n📦 *Tamaño:* ${sizeMB} MB\n📎 *Fuente:* ${usedApi}`,
      }, { quoted: m });
    } else {
      await conn.sendMessage(m.chat, {
        video  : { url: videoUrl },
        caption: `✅ *TikTok descargado*\n📎 *Fuente:* ${usedApi}`,
      }, { quoted: m });
    }

  } catch (e) {
    console.error('[TikTok-DL]', e);
    throw typeof e === 'string' ? e : '❌ No se pudo descargar el video. Inténtalo de nuevo.';
  }
};

handler.help    = ['tiktok'];
handler.tags    = ['downloader'];
handler.command = /^(tiktok|ttdl|tiktokdl|tiktoknowm|tt|ttnowm|tiktokaudio)$/i;

export default handler;

// ─── Scraper instatiktok ──────────────────────────────────────────────────────
async function fetchInstatiktok(url) {
  try {
    const SITE_URL = 'https://instatiktok.com/';
    const form     = new URLSearchParams();
    form.append('url', url);
    form.append('platform', 'tiktok');

    const res = await axios.post(`${SITE_URL}api`, form.toString(), {
      headers: {
        'Content-Type'    : 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin'          : SITE_URL,
        'Referer'         : SITE_URL,
        'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 10000,
    });

    const html = res?.data?.html;
    if (!html || res?.data?.status !== 'success') return null;

    const $     = cheerio.load(html);
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
        
