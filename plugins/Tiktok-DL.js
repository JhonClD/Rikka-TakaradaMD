import axios from 'axios';
import cheerio from 'cheerio';
import { execFile } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};
const VIDEO_HEADERS = {
  ...REQUEST_HEADERS,
  Referer: 'https://www.tikwm.com/',
};

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `📎 Ingresa un enlace de TikTok.\n_${usedPrefix + command} https://vt.tiktok.com/ZS12345/_`;

  const url = extractTikTokUrl(text, args);
  if (!url) throw '❌ El enlace no parece ser de TikTok.';

  const tmpInput = join(tmpdir(), `tiktok_in_${process.pid}_${Date.now()}.mp4`);
  const tmpOutput = join(tmpdir(), `tiktok_out_${process.pid}_${Date.now()}.mp4`);

  try {
    const videoUrl = await resolveVideoUrl(url);
    if (!videoUrl) throw new Error('Ninguna fuente devolvió un enlace de vídeo válido.');

    const video = await downloadVideo(videoUrl);
    writeFileSync(tmpInput, video);

    // Remux sin recodificar; conserva la calidad y corrige contenedores incompatibles.
    await execFileAsync('ffmpeg', [
      '-y', '-i', tmpInput,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'copy', '-c:a', 'copy',
      '-movflags', '+faststart',
      tmpOutput,
    ], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });

    if (!existsSync(tmpOutput)) throw new Error('FFmpeg no generó el archivo final.');
    const buffer = readFileSync(tmpOutput);
    if (!isMp4(buffer)) throw new Error('La respuesta descargada no es un MP4 válido.');

    await conn.sendMessage(m.chat, {
      video: buffer,
      mimetype: 'video/mp4',
      caption: '✅ *TikTok descargado*',
    }, { quoted: m });
  } catch (e) {
    console.error('[TikTok-DL]', e?.message || e);
    throw '❌ No se pudo descargar el TikTok. Verifica que el enlace sea público e inténtalo de nuevo.';
  } finally {
    for (const file of [tmpInput, tmpOutput]) {
      if (existsSync(file)) unlinkSync(file);
    }
  }
};

handler.help = ['tiktok'];
handler.tags = ['downloader'];
handler.command = /^(tiktok|ttdl|tiktokdl|tiktoknowm|tt|ttnowm|tiktokaudio)$/i;

export default handler;

function extractTikTokUrl(text, args = []) {
  const candidate = String(text).match(/https?:\/\/(?:www\.|vm\.|vt\.|m\.)?tiktok\.com\/[^\s<>]+/i)?.[0] || args[0];
  if (!candidate) return null;
  return candidate.replace(/[),.!?;:'"\]}>]+$/g, '');
}

async function resolveVideoUrl(url) {
  const sources = [
    () => fetchTikwm(url),
    () => fetchInstatiktok(url),
    () => fetchSnaptik(url),
    () => fetchSssTik(url),
    () => fetchTikmate(url),
  ];

  for (const source of sources) {
    try {
      const result = await source();
      if (result) return result;
    } catch (error) {
      console.log('[TikTok source failed]', error?.message || error);
    }
  }
  return null;
}

async function fetchTikwm(url) {
  const { data } = await axios.get('https://www.tikwm.com/api/', {
    params: { url, hd: 1 },
    headers: { ...REQUEST_HEADERS, Referer: 'https://www.tikwm.com/' },
    timeout: 20000,
  });
  if (data?.code !== 0) return null;
  return data?.data?.hdplay || data?.data?.play || data?.data?.wmplay || null;
}

async function fetchInstatiktok(url) {
  const site = 'https://instatiktok.com/';
  const form = new URLSearchParams({ url, platform: 'tiktok' });
  const { data } = await axios.post(`${site}api`, form.toString(), {
    headers: {
      ...REQUEST_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: site,
      Referer: site,
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 15000,
  });
  if (data?.status !== 'success' || !data?.html) return null;
  const $ = cheerio.load(data.html);
  return $('a.btn[href^="http"]').map((_, el) => $(el).attr('href')).get().find(Boolean) || null;
}

async function fetchSnaptik(url) {
  const form = new URLSearchParams({ url, token: '' });
  const { data } = await axios.post('https://snaptik.app/abc2.php', form.toString(), {
    headers: { ...REQUEST_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  const $ = cheerio.load(data?.html || data || '');
  return $('a[href*="tikcdn"], a[href*="download"]').first().attr('href') || null;
}

async function fetchSssTik(url) {
  const form = new URLSearchParams({ id: url });
  const { data } = await axios.post('https://sssstik.io/app/upload', form.toString(), {
    headers: {
      ...REQUEST_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 15000,
  });
  const $ = cheerio.load(data || '');
  return $('a[href^="http"]').first().attr('href') || null;
}

async function fetchTikmate(url) {
  const form = new URLSearchParams({ url });
  const { data } = await axios.post('https://tikmate.online/api/lookup', form.toString(), {
    headers: { ...REQUEST_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return data?.token && data?.id ? `https://tikmate.online/download/${data.token}/${data.id}.mp4` : null;
}

async function downloadVideo(videoUrl) {
  const response = await axios.get(videoUrl, {
    responseType: 'arraybuffer',
    headers: VIDEO_HEADERS,
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const buffer = Buffer.from(response.data);
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  if (!isMp4(buffer) && !contentType.includes('video/')) {
    throw new Error(`La fuente devolvió ${contentType || 'contenido no multimedia'}`);
  }
  return buffer;
}

function isMp4(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 12 && buffer.subarray(4, 12).toString('ascii').includes('ftyp');
}
