import axios from 'axios';
import cheerio from 'cheerio';
import { exec } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MAX_RAW_MB  = 10;
const WA_LIMIT_MB = 64;

// ─── Estado pendiente por usuario ────────────────────────────────────────────
const pendingTikTok = new Map();

// ─── Compresión dinámica ──────────────────────────────────────────────────────
async function compressForWhatsApp(inputPath, outputPath, targetMB) {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
    { timeout: 30000 }
  );
  const duration = parseFloat(stdout.trim());
  if (!duration || isNaN(duration)) throw new Error('No se pudo obtener la duración del video');

  const targetBits   = targetMB * 1024 * 1024 * 8;
  const audioBitrate = 96;
  const videoBitrate = Math.floor(targetBits / duration / 1000) - audioBitrate;

  if (videoBitrate < 100) throw new Error('Video demasiado largo para comprimir con calidad mínima');

  console.log(`[TikTok-DL] Comprimiendo: duración=${duration.toFixed(1)}s, target=${targetMB} MB, vbitrate=${videoBitrate}k`);

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

// ─── Enviar video procesado ───────────────────────────────────────────────────
async function sendVideo(conn, m, buffer) {
  const ts       = Date.now();
  const tmpInput = join(tmpdir(), `tiktok_in_${ts}.mp4`);
  const tmpComp  = join(tmpdir(), `tiktok_comp_${ts}.mp4`);

  try {
    const rawMB = buffer.length / 1024 / 1024;

    if (rawMB <= MAX_RAW_MB) {
      return await conn.sendMessage(m.chat, {
        video   : buffer,
        mimetype: 'video/mp4',
        caption : `✅ *TikTok descargado*`,
      }, { quoted: m });
    }

    const dynamicTarget = rawMB <= WA_LIMIT_MB ? Math.floor(rawMB * 0.90) : 60;
    console.log(`[TikTok-DL] Video (${rawMB.toFixed(2)} MB), comprimiendo a ~${dynamicTarget} MB...`);
    writeFileSync(tmpInput, buffer);

    let finalBuffer = buffer;
    try {
      finalBuffer = await compressForWhatsApp(tmpInput, tmpComp, dynamicTarget);
    } catch (e) {
      console.error('[TikTok-DL] Compresión falló:', e.message);
    }

    const finalMB = finalBuffer.length / 1024 / 1024;

    if (finalMB <= WA_LIMIT_MB) {
      await conn.sendMessage(m.chat, {
        video   : finalBuffer,
        mimetype: 'video/mp4',
        caption : `✅ *TikTok descargado*`,
      }, { quoted: m });
    } else {
      await conn.sendMessage(m.chat, {
        document : finalBuffer,
        mimetype : 'video/mp4',
        fileName : `tiktok_${ts}.mp4`,
        caption  : `✅ *TikTok descargado*`,
      }, { quoted: m });
    }
  } finally {
    for (const f of [tmpInput, tmpComp]) {
      if (existsSync(f)) unlinkSync(f);
    }
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────
const handler = async (m, { conn, text, args, usedPrefix, command }) => {

  // ── Capturar respuesta de lista ───────────────────────────────────────────
  const listResponse = m?.message?.listResponseMessage?.singleSelectReply?.selectedRowId;

  if (listResponse && pendingTikTok.has(m.sender)) {
    const { imageUrls, videoUrl } = pendingTikTok.get(m.sender);
    pendingTikTok.delete(m.sender);

    if (listResponse === 'tt_images') {
      for (let i = 0; i < imageUrls.length; i++) {
        try {
          const { data } = await axios.get(imageUrls[i], {
            responseType     : 'arraybuffer',
            timeout          : 30000,
            maxContentLength : Infinity,
          });
          await conn.sendMessage(m.chat, {
            image  : Buffer.from(data),
            caption: i === 0 ? `✅ *TikTok descargado* (${imageUrls.length} imágenes)` : '',
          }, { quoted: i === 0 ? m : undefined });
        } catch (e) {
          console.error(`[TikTok-DL] Error imagen ${i + 1}:`, e.message);
        }
      }
      return;
    }

    if (listResponse === 'tt_video') {
      const { data } = await axios.get(videoUrl, {
        responseType     : 'arraybuffer',
        timeout          : 120000,
        maxContentLength : Infinity,
        maxBodyLength    : Infinity,
      });
      return await sendVideo(conn, m, Buffer.from(data));
    }

    return;
  }

  // ── Validación ────────────────────────────────────────────────────────────
  if (!text) throw `📎 Ingresa un enlace de TikTok.\n_${usedPrefix + command} https://vt.tiktok.com/ZS12345/_`;
  if (!/(?:https?:\/\/)?(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s&]+/gi.test(text))
    throw '❌ El enlace no parece ser de TikTok.';

  const url     = args[0];
  const encoded = encodeURIComponent(url);
  const asDoc   = /^(tiktok2|tt2)$/i.test(command);

  // ── Detectar slideshow via tikwm ──────────────────────────────────────────
  if (!asDoc) {
    try {
      const { data: j } = await axios.get(`https://www.tikwm.com/api/?url=${encoded}&hd=1`, { timeout: 10000 });
      const images   = j?.data?.images;
      const videoUrl = j?.data?.hdplay || j?.data?.play;

      if (Array.isArray(images) && images.length > 0 && videoUrl) {
        pendingTikTok.set(m.sender, { imageUrls: images, videoUrl, ts: Date.now() });
        setTimeout(() => pendingTikTok.delete(m.sender), 120000);

        return await conn.sendMessage(m.chat, {
          listMessage: {
            title      : '🖼️ *Post con imágenes detectado*',
            text       : `Este post contiene *${images.length} imágenes*.\n¿Qué deseas descargar?`,
            buttonText : '📥 Ver opciones',
            listType   : 1,
            sections   : [{
              title: 'Opciones de descarga',
              rows : [
                { title: '🖼️ Imágenes', description: `Descargar las ${images.length} imágenes`, rowId: 'tt_images' },
                { title: '🎬 Video',    description: 'Descargar como video',                    rowId: 'tt_video'  },
              ],
            }],
          },
        }, { quoted: m });
      }
    } catch (e) {
      console.log('[TikTok-DL] Detección slideshow falló, continuando normal:', e.message);
    }
  }

  // ── APIs fallback ─────────────────────────────────────────────────────────
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

  const ts     = Date.now();
  const tmpMkv = join(tmpdir(), `tiktok_out_${ts}.mkv`);
  const tmpIn  = join(tmpdir(), `tiktok_in_${ts}.mp4`);

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
    console.log('[TikTok-DL] Descargado:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');

    // ── Modo documento ──────────────────────────────────────────────────────
    if (asDoc) {
      try {
        writeFileSync(tmpIn, buffer);
        await execAsync(`ffmpeg -y -i "${tmpIn}" -c:v copy -c:a copy "${tmpMkv}"`, { timeout: 120000 });
        buffer = readFileSync(tmpMkv);
      } catch (e) {
        console.error('[TikTok-DL] MKV falló:', e.message);
      }
      return await conn.sendMessage(m.chat, {
        document : buffer,
        mimetype : 'video/x-matroska',
        fileName : `tiktok_${ts}.mkv`,
        caption  : `✅ *TikTok descargado*`,
      }, { quoted: m });
    }

    // ── Modo video ──────────────────────────────────────────────────────────
    await sendVideo(conn, m, buffer);

  } catch (e) {
    console.error('[TikTok-DL]', e);
    throw typeof e === 'string' ? e : '❌ No se pudo descargar el video. Inténtalo de nuevo.';
  } finally {
    for (const f of [tmpIn, tmpMkv]) {
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
