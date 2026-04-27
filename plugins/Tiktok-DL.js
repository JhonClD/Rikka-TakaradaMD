import axios from 'axios';
import cheerio from 'cheerio';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const MAX_VIDEO_MB = 15; // margen de seguridad bajo 16

const TT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.tiktok.com/',
  'Accept': '*/*',
};

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `📎 Ingresa un enlace de TikTok.\n_${usedPrefix + command} https://vt.tiktok.com/ZS12345/_`;
  if (!/(?:https?:\/\/)?(?:www\.|vm\.|vt\.|t\.)?tiktok\.com\/([^\s&]+)/gi.test(text))
    throw "❌ El enlace no parece ser de TikTok.";

  let hdUrl = null, sdUrl = null;

  // Fuente principal: tikwm
  try {
    const encoded = encodeURIComponent(args[0]);
    const { data: json } = await axios.get(`https://www.tikwm.com/api/?url=${encoded}&hd=1`, { timeout: 15000 });
    hdUrl = json.data?.hdplay || null;
    sdUrl = json.data?.play || null;
  } catch { /* continúa */ }

  // Fallback: instatiktok
  if (!hdUrl && !sdUrl) {
    const links = await fetchDownloadLinks(args[0], 'tiktok');
    if (links?.length) {
      hdUrl = links.find(l => /hdplay/i.test(l)) || null;
      sdUrl = links.find(l => /download/i.test(l)) || links[0] || null;
    }
  }

  if (!hdUrl && !sdUrl) throw "❌ No se pudo obtener el video. Inténtalo de nuevo.";

  // Preferir SD (más ligero), HD como fallback
  const videoUrl = sdUrl || hdUrl;

  const tmpInput = join(tmpdir(), `tt_in_${Date.now()}.mp4`);
  const tmpOutput = join(tmpdir(), `tt_out_${Date.now()}.mp4`);

  try {
    // Descargar a archivo temporal
    const response = await axios.get(videoUrl, {
      responseType: 'stream',
      headers: TT_HEADERS,
      timeout: 120000,
    });
    await pipeline(response.data, fs.createWriteStream(tmpInput));

    const sizeMB = fs.statSync(tmpInput).size / (1024 * 1024);

    let finalPath = tmpInput;

    if (sizeMB > MAX_VIDEO_MB) {
      // Comprimir con ffmpeg → H.264, target ~14 MB
      const targetKbps = Math.floor((MAX_VIDEO_MB * 8192) / 60); // bitrate para ~60s, ajusta si quieres
      await execAsync(
        `ffmpeg -i "${tmpInput}" -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 96k -movflags +faststart -y "${tmpOutput}"`,
        { timeout: 180000 }
      );
      finalPath = tmpOutput;
    }

    const finalSize = fs.statSync(finalPath).size / (1024 * 1024);
    const videoBuffer = fs.readFileSync(finalPath);

    if (finalSize <= MAX_VIDEO_MB) {
      // Enviar como video inline (reproducible directo en WhatsApp)
      await conn.sendMessage(m.chat, {
        video: videoBuffer,
        caption: `✅ *Video descargado* (${finalSize.toFixed(1)} MB)`
      }, { quoted: m });
    } else {
      // Si aún es grande después de comprimir, enviar documento
      await conn.sendMessage(m.chat, {
        document: videoBuffer,
        mimetype: 'video/mp4',
        fileName: 'tiktok_video.mp4',
        caption: `✅ *Video descargado* (${finalSize.toFixed(1)} MB)`
      }, { quoted: m });
    }

  } finally {
    try { fs.unlinkSync(tmpInput); } catch { }
    try { fs.unlinkSync(tmpOutput); } catch { }
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
        'User-Agent': TT_HEADERS['User-Agent'],
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
