import axios from 'axios';
import cheerio from 'cheerio';
import { exec } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

const TARGET_MB  = 50;
const MAX_RAW_MB = 10;

async function compressForWhatsApp(inputPath, outputPath) {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
    { timeout: 30000 }
  );
  const duration = parseFloat(stdout.trim());
  if (!duration || isNaN(duration)) throw new Error('No se pudo obtener la duración del video');

  const targetBits   = TARGET_MB * 1024 * 1024 * 8;
  const audioBitrate = 96;
  const videoBitrate = Math.floor(targetBits / duration / 1000) - audioBitrate;

  if (videoBitrate < 100) throw new Error('Video demasiado largo para comprimir a 50 MB con calidad mínima');

  console.log(`[TikTok-DL] Comprimiendo: duración=${duration.toFixed(1)}s, vbitrate=${videoBitrate}k, abitrate=${audioBitrate}k`);

  await execAsync(
    `ffmpeg -y -i "${inputPath}" \
     -c:v libx264 -b:v ${videoBitrate}k -maxrate ${videoBitrate * 1.5}k -bufsize ${videoBitrate * 2}k \
     -vf "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" \
     -c:a aac -b:a ${audioBitrate}k -movflags +faststart \
     -preset fast "${outputPath}"`,
    { timeout: 300000 }
  );

  const compressed = readFileSync(outputPath);
  console.log(`[TikTok-DL] Compresión OK: ${(compressed.length / 1024 / 1024).toFixed(2)} MB`);
  return compressed;
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `📎 Ingresa un enlace de TikTok.\n_${usedPrefix + command} https://vt.tiktok.com/ZS12345/_`;
  if (!/(?:https?:\/\/)?(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s&]+/gi.test(text))
    throw '❌ El enlace no parece ser de TikTok.';

  const url     = args[0];
  const encoded = encodeURIComponent(url);
  const asDoc   = /^(tiktok2|tt2)$/i.test(command);

  const APIs = [
    async () => {
      const links = await fetchInstatiktok(url);
      if (!links?.length) return null;
      return links.find(l => /hdplay/i.test(l)) || links.find(l => /download/i.test(l)) || links[0];
    },
    async () => {
      const { data: j } = await axios.get(`https://www.tikwm.com/api/?url=${encoded}&hd=1`, { timeout: 10000 });
      return j?.data?.hdplay || j?.data?.play || null;
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

  const ts       = Date.now();
  const tmpInput = join(tmpdir(), `tiktok_in_${ts}.mp4`);
  const tmpComp  = join(tmpdir(), `tiktok_comp_${ts}.mp4`);
  const tmpMkv   = join(tmpdir(), `tiktok_out_${ts}.mkv`);

  try {
    let videoUrl = null;

    for (let i = 0; i < APIs.length; i++) {
      try {
        const result = await APIs[i]();
        if (result) { videoUrl = result; break; }
      } catch (err) {
        console.log(`[TikTok API #${i + 1} Error]`, err.message);
      }
    }

    if (!videoUrl) throw '❌ No se pudo descargar el video con ninguna fuente.';

    console.log('[TikTok-DL] Descargando desde:', videoUrl);

    const res = await axios.get(videoUrl, {
      responseType     : 'arraybuffer',
      timeout          : 120000,
      maxContentLength : Infinity,
      maxBodyLength    : Infinity,
    });

    let buffer = Buffer.from(res.data);
    const rawMB = buffer.length / 1024 / 1024;
    console.log('[TikTok-DL] Descargado:', rawMB.toFixed(2), 'MB');

    // ── Modo documento (tiktok2 / tt2) ────────────────────────────────────────
    if (asDoc) {
      try {
        writeFileSync(tmpInput, buffer);
        await execAsync(
          `ffmpeg -y -i "${tmpInput}" -c:v copy -c:a copy "${tmpMkv}"`,
          { timeout: 120000 }
        );
        buffer = readFileSync(tmpMkv);
        console.log('[TikTok-DL] MKV OK:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');
      } catch (ffErr) {
        console.error('[TikTok-DL] ffmpeg MKV falló, usando original:', ffErr.message);
      }

      return await conn.sendMessage(m.chat, {
        document : buffer,
        mimetype : 'video/x-matroska',
        fileName : `tiktok_${ts}.mkv`,
        caption  : `✅ *TikTok descargado*`,
      }, { quoted: m });
    }

    // ── Modo video reproducible ───────────────────────────────────────────────
    if (rawMB <= MAX_RAW_MB) {
      return await conn.sendMessage(m.chat, {
        video   : buffer,
        mimetype: 'video/mp4',
        caption : `✅ *TikTok descargado*`,
      }, { quoted: m });
    }

    // Video grande → comprimir
    console.log(`[TikTok-DL] Video grande (${rawMB.toFixed(2)} MB), comprimiendo...`);
    writeFileSync(tmpInput, buffer);

    let compBuffer;
    let compressed = false;

    try {
      compBuffer = await compressForWhatsApp(tmpInput, tmpComp);
      compressed = true;
    } catch (compErr) {
      console.error('[TikTok-DL] Compresión falló:', compErr.message);
    }

    const finalBuffer = compressed ? compBuffer : buffer;
    const finalMB     = finalBuffer.length / 1024 / 1024;

    if (finalMB <= MAX_RAW_MB) {
      await conn.sendMessage(m.chat, {
        video   : finalBuffer,
        mimetype: 'video/mp4',
        caption : `✅ *TikTok descargado*`,
      }, { quoted: m });
    } else {
      console.log(`[TikTok-DL] Aún grande tras comprimir (${finalMB.toFixed(2)} MB), enviando como doc.`);
      await conn.sendMessage(m.chat, {
        document : finalBuffer,
        mimetype : 'video/mp4',
        fileName : `tiktok_${ts}.mp4`,
        caption  : `✅ *TikTok descargado*`,
      }, { quoted: m });
    }

  } catch (e) {
    console.error('[TikTok-DL]', e);
    throw typeof e === 'string' ? e : '❌ No se pudo descargar el video. Inténtalo de nuevo.';
  } finally {
    for (const f of [tmpInput, tmpComp, tmpMkv]) {
      if (existsSync(f)) unlinkSync(f);
    }
  }
};

handler.help    = ['tiktok', 'tiktok2'];
handler.tags    = ['downloader'];
handler.command = /^(tiktok|ttdl|tiktokdl|tiktoknowm|tt|ttnowm|tiktokaudio|tiktok2|tt2)$/i;

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
