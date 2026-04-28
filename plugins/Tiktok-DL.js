import axios from 'axios';
import cheerio from 'cheerio';

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `📎 Ingresa un enlace de TikTok.\n_${usedPrefix + command} https://vt.tiktok.com/ZS12345/_`;
  if (!/(?:https?:\/\/)?(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s&]+/gi.test(text))
    throw '❌ El enlace no parece ser de TikTok.';

  // Resolver URL corta → URL larga
  let url         = args[0];
  let resolvedUrl = url;
  try {
    const res = await axios.get(url, {
      maxRedirects : 10,
      timeout      : 12000,
      headers      : { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' },
      validateStatus: () => true,
    });
    const final = res.request?.res?.responseUrl || res.request?._redirectable?._currentUrl;
    if (final && final.includes('tiktok.com/')) resolvedUrl = final.split('?')[0];
  } catch (e) {
    console.log('[TikTok] Resolución falló:', e.message);
  }

  console.log('[TikTok] URL original:', url);
  console.log('[TikTok] URL resuelta:', resolvedUrl);
  const encoded = encodeURIComponent(resolvedUrl);
  const encodedOrig = encodeURIComponent(url);

  const APIs = [
    async () => {
      const links = await fetchInstatiktok(url);
      if (!links?.length) return null;
      return links.find(l => /hdplay/i.test(l)) || links.find(l => /download/i.test(l)) || links[0];
    },
    async () => {
      // tikwm acepta tanto URL larga como corta
      for (const enc of [encoded, encodedOrig]) {
        try {
          const { data: j } = await axios.get(`https://www.tikwm.com/api/?url=${enc}&hd=1`, { timeout: 12000 });
          const v = j?.data?.hdplay || j?.data?.play;
          if (v) return v;
        } catch (_) {}
      }
      return null;
    },
    async () => {
      const res  = await axios.post('https://snaptik.app/abc2.php',
        new URLSearchParams({ url, token: '' }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
      const $    = cheerio.load(res.data?.html || res.data || '');
      const link = $('a[href*="tikcdn"]').attr('href') || $('a[href*="download"]').first().attr('href');
      return link || null;
    },
    async () => {
      const res  = await axios.post('https://sssstik.io/app/upload',
        new URLSearchParams({ id: url }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, timeout: 10000 });
      const $    = cheerio.load(res.data || '');
      const link = $('a[href^="http"]').attr('href');
      return link || null;
    },
    async () => {
      const { data: j } = await axios.get(`https://tiksave.net/api/?url=${encoded}`, { timeout: 10000 });
      return j?.data?.play || j?.url || null;
    },
    async () => {
      const { data: j } = await axios.get(`https://api.vreden.my.id/api/tiktok?url=${encoded}`, { timeout: 10000 });
      return j?.result?.url || null;
    },
    async () => {
      const { data: j } = await axios.get(`https://api.alyacid.my.id/api/tiktok?url=${encoded}`, { timeout: 10000 });
      return j?.data?.video?.noWatermark || j?.data?.play || null;
    },
    async () => {
      const { data: j } = await axios.get(`https://api.naxdr.com/tiktok/dl?url=${encoded}`, { timeout: 10000 });
      return j?.data?.play || j?.url || null;
    },
    async () => {
      const { data: j } = await axios.get(`https://luminai.my.id/api/download/tiktok?url=${encoded}`, { timeout: 10000 });
      return j?.data?.url || null;
    },
    async () => {
      const { data: j } = await axios.post('https://tikmate.online/api/lookup',
        new URLSearchParams({ url }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
      return j?.token ? `https://tikmate.online/download/${j.token}/${j.id}.mp4` : null;
    },
  ];

  try {
    let videoUrl = null;
    let usedApi  = '—';

    const errors = [];
    for (let i = 0; i < APIs.length; i++) {
      try {
        const result = await APIs[i]();
        if (result) { videoUrl = result; usedApi = `API #${i + 1}`; break; }
        else errors.push(`API #${i + 1}: sin resultado`);
      } catch (err) {
        console.log(`[TikTok API #${i + 1} Error]`, err.message);
        errors.push(`API #${i + 1}: ${err.message}`);
      }
    }

    if (!videoUrl) {
      console.error('[TikTok] Todos fallaron:\n' + errors.join('\n'));
      throw `❌ Todas las APIs fallaron.\n\`\`\`\n${errors.slice(0, 5).join('\n')}\n\`\`\``;
    }

    await conn.sendMessage(m.chat, {
      video  : { url: videoUrl },
      caption: `✅ *TikTok descargado*`,
    }, { quoted: m });

  } catch (e) {
    console.error('[TikTok-DL]', e);
    throw typeof e === 'string' ? e : '❌ No se pudo descargar el video. Inténtalo de nuevo.';
  }
};

handler.help    = ['tiktok'];
handler.tags    = ['downloader'];
handler.command = /^(tiktok|ttdl|tiktokdl|tiktoknowm|tt|ttnowm|tiktokaudio)$/i;

export default handler;

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
        'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
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
  } catch { return null; }
    }
          
