import axios from 'axios';
import cheerio from 'cheerio';
import fs from 'fs';
import { spawn, execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const TARGET_MB  = 60;
const AUDIO_KBPS = 96;

const getVideoDuration = (filePath) => {
  try {
    const raw = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { encoding: 'utf8' }
    );
    return parseFloat(raw.trim()) || 0;
  } catch { return 0; }
};

const calcVideoBitrate = (durationSec, targetMB, audioBitrateK = AUDIO_KBPS) => {
  if (!durationSec || durationSec <= 0) return 800;
  const videoBits = targetMB * 8 * 1024 * 1024 - audioBitrateK * 1000 * durationSec;
  return Math.max(100, Math.floor(videoBits / durationSec / 1000));
};

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `📎 Ingresa un enlace de TikTok.\n_${usedPrefix + command} https://vt.tiktok.com/ZS12345/_`;
  if (!/(?:https?:\/\/)?(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s&]+/gi.test(text))
    throw '❌ El enlace no parece ser de TikTok.';

  const url     = args[0];
  const encoded = encodeURIComponent(url);

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

  const ts        = Date.now();
  const tmpInput  = join(tmpdir(), `tiktok_in_${ts}.mp4`);
  const tmpOutput = join(tmpdir(), `tiktok_out_${ts}.mp4`);

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

    console.log('[TikTok-DL] Descargando:', videoUrl);

    const res = await axios.get(videoUrl, {
      responseType     : 'arraybuffer',
      timeout          : 120000,
      maxContentLength : Infinity,
      maxBodyLength    : Infinity,
    });

    const rawBuffer = Buffer.from(res.data);
    const sizeMB    = rawBuffer.length / 1024 / 1024;
    console.log('[TikTok-DL] Descargado:', sizeMB.toFixed(2), 'MB');

    fs.writeFileSync(tmpInput, rawBuffer);

    // Calcular si necesita compresión
    const needsCompress = sizeMB > TARGET_MB;
    let ffmpegArgs;

    if (needsCompress) {
      const duration     = getVideoDuration(tmpInput);
      const videoBitrate = calcVideoBitrate(duration, TARGET_MB);
      const maxrate      = Math.floor(videoBitrate * 1.5);
      const bufsize      = videoBitrate * 2;
      console.log(`[TikTok-DL] Comprimiendo: ${sizeMB.toFixed(1)}MB → ~${TARGET_MB}MB | bitrate: ${videoBitrate}k | dur: ${duration.toFixed(1)}s`);

      ffmpegArgs = [
        '-y', '-i', tmpInput,
        '-c:v', 'libx264',
        '-b:v', `${videoBitrate}k`,
        '-maxrate', `${maxrate}k`,
        '-bufsize', `${bufsize}k`,
        '-pix_fmt', 'yuv420p',
        '-preset', 'faster',
        '-tune', 'fastdecode',
        '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ac', '2',
        '-movflags', '+faststart',
        '-y', tmpOutput,
      ];
    } else {
      // Solo remuxear sin perder calidad
      ffmpegArgs = [
        '-y', '-i', tmpInput,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        tmpOutput,
      ];
    }

    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', ffmpegArgs);
      let errBuf = '';
      proc.stderr.on('data', (d) => { errBuf += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) return resolve();
        console.error('[TikTok ffmpeg]', errBuf.split('\n').slice(-5).join('\n'));
        reject(new Error(`ffmpeg salió con código ${code}`));
      });
    });

    const finalMB = (fs.statSync(tmpOutput).size / 1024 / 1024).toFixed(1);
    console.log('[TikTok-DL] Enviando:', finalMB, 'MB');

    await conn.sendMessage(m.chat, {
      video   : { url: tmpOutput },
      caption : `✅ *TikTok descargado*${needsCompress ? `\n📦 Comprimido a ${finalMB} MB` : ''}`,
      mimetype: 'video/mp4',
    }, { quoted: m });

  } catch (e) {
    console.error('[TikTok-DL]', e);
    throw typeof e === 'string' ? e : '❌ No se pudo descargar el video. Inténtalo de nuevo.';
  } finally {
    if (fs.existsSync(tmpInput))  fs.unlinkSync(tmpInput);
    if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
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
