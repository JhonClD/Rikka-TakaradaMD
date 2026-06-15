import axios from 'axios';
import { exec } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

const MAX_RAW_MB  = 10;
const WA_LIMIT_MB = 64;

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

  await execAsync(
    `ffmpeg -y -i "${inputPath}" \
     -c:v libx264 -b:v ${videoBitrate}k -maxrate ${videoBitrate * 1.5}k -bufsize ${videoBitrate * 2}k \
     -vf "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" \
     -c:a aac -b:a ${audioBitrate}k -movflags +faststart \
     -preset fast "${outputPath}"`,
    { timeout: 300000 }
  );

  return readFileSync(outputPath);
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  if (!text) throw `📎 Uso: _${usedPrefix + command} [cantidad] búsqueda_\nEjemplo: _${usedPrefix + command} 3 gatos graciosos_`;

  const MAX_RESULTS = 10;
  let cantidad = 1;
  let query = text.trim();

  const firstWord = args[0];
  if (/^\d+$/.test(firstWord)) {
    cantidad = Math.min(parseInt(firstWord, 10), MAX_RESULTS);
    if (cantidad < 1) cantidad = 1;
    query = args.slice(1).join(' ').trim();
  }

  if (!query) throw `📎 Ingresa un término de búsqueda.\nEjemplo: _${usedPrefix + command} 3 baile viral_`;

  await conn.sendMessage(m.chat, { react: { text: '🔍', key: m.key } });

  let videoUrls = [];
  try {
    const encoded = encodeURIComponent(query);
    const { data } = await axios.get(
      `https://www.tikwm.com/api/feed/search?keywords=${encoded}&count=20&cursor=0&hd=1`,
      { timeout: 15000 }
    );
    const videos = data?.data?.videos || [];
    videoUrls = videos
      .slice(0, cantidad)
      .map(v => v.hdplay || v.play)
      .filter(Boolean);
  } catch (err) {
    console.log('[TikTok-TTS] Error buscando:', err.message);
  }

  if (!videoUrls.length) throw '❌ No se encontraron videos para esa búsqueda.';

  await conn.sendMessage(m.chat, { react: { text: '⬇️', key: m.key } });

  const ts = Date.now();
  let sent = 0;

  for (let i = 0; i < videoUrls.length; i++) {
    const tmpInput = join(tmpdir(), `tts_in_${ts}_${i}.mp4`);
    const tmpComp  = join(tmpdir(), `tts_comp_${ts}_${i}.mp4`);
    try {
      const res = await axios.get(videoUrls[i], {
        responseType     : 'arraybuffer',
        timeout          : 120000,
        maxContentLength : Infinity,
        maxBodyLength    : Infinity,
      });

      let buffer = Buffer.from(res.data);
      const rawMB = buffer.length / 1024 / 1024;

      if (rawMB > MAX_RAW_MB) {
        const dynamicTarget = rawMB <= WA_LIMIT_MB ? Math.floor(rawMB * 0.90) : 60;
        writeFileSync(tmpInput, buffer);
        try {
          buffer = await compressForWhatsApp(tmpInput, tmpComp, dynamicTarget);
        } catch (e) {
          console.error(`[TikTok-TTS] Compresión falló video ${i + 1}:`, e.message);
        }
      }

      const finalMB = buffer.length / 1024 / 1024;

      if (finalMB <= WA_LIMIT_MB) {
        await conn.sendMessage(m.chat, {
          video   : buffer,
          mimetype: 'video/mp4',
          caption : `🎵 *${i + 1}/${videoUrls.length}* — ${query}`,
        }, { quoted: i === 0 ? m : undefined });
      } else {
        await conn.sendMessage(m.chat, {
          document : buffer,
          mimetype : 'video/mp4',
          fileName : `tiktok_${ts}_${i + 1}.mp4`,
          caption  : `🎵 *${i + 1}/${videoUrls.length}* — ${query}`,
        }, { quoted: i === 0 ? m : undefined });
      }
      sent++;
    } catch (err) {
      console.error(`[TikTok-TTS] Video ${i + 1} falló:`, err.message);
    } finally {
      for (const f of [tmpInput, tmpComp]) {
        if (existsSync(f)) unlinkSync(f);
      }
    }
  }

  if (sent === 0) throw '❌ No se pudo descargar ningún video del resultado.';
  await conn.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
};

handler.help    = ['tts'];
handler.tags    = ['downloader'];
handler.command = /^tts$/i;

export default handler;
