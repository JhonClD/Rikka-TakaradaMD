/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║              YTDLP DOWNLOADER — Descargador Universal        ║
 * ║  Descarga video, audio, imágenes y playlists de +1000 sitios ║
 * ║  usando yt-dlp directamente desde un link.                   ║
 * ║  Pon este archivo en: plugins/ytdlp-dl.js                    ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * COMANDOS:
 *  .ytdlp  <url>          → descarga el mejor video (≤720p, <100 MB)
 *  .ytdlpa <url>          → descarga solo el audio (MP3)
 *  .ytdlpi <url>          → descarga todas las imágenes / thumbnails
 *  .ytdlpinfo <url>       → muestra metadata sin descargar
 *
 * REQUISITOS:
 *  - yt-dlp instalado y en PATH  (pkg install yt-dlp  en Termux)
 *  - ffmpeg instalado            (pkg install ffmpeg)
 *  - Node.js built-ins: child_process, fs, path, os
 *
 * NOTAS:
 *  - Funciona con YouTube, TikTok, Instagram, Twitter/X, Facebook,
 *    Reddit, Twitch clips, Bilibili, SoundCloud, Spotify*, y +1000 más.
 *    (*Spotify solo metadata/preview — no descarga full)
 *  - Videos > 100 MB se envían como documento para evitar rechazos WA.
 *  - Playlist: solo descarga el primer item por defecto (--playlist-items 1).
 *  - Timeout de 3 min para descargas grandes.
 */

import { exec, execFile } from 'child_process';
import { existsSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import { join, basename, extname } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';

const execAsync  = promisify(exec);
const execFileA  = promisify(execFile);

// ── Constantes ─────────────────────────────────────────────────────────────────
const TMP         = tmpdir();
const WA_LIMIT    = 95 * 1024 * 1024;   // 95 MB → límite seguro de WhatsApp
const TIMEOUT_DL  = 180_000;            // 3 min para la descarga
const TIMEOUT_INF = 20_000;             // 20 s para obtener info

// ── Utilidades ─────────────────────────────────────────────────────────────────
const react = (conn, m, emoji) =>
    conn.sendMessage(m.chat, { react: { text: emoji, key: m.key } });

const fmtBytes = (b) => {
    if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(2)} GB`;
    if (b >= 1_048_576)     return `${(b / 1_048_576).toFixed(2)} MB`;
    return `${(b / 1024).toFixed(1)} KB`;
};

const fmtSeconds = (s) => {
    s = Math.round(s || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
                 : `${m}:${String(sec).padStart(2,'0')}`;
};

/** Elimina archivos temporales con un prefijo dado */
const cleanTmp = (prefix) => {
    try {
        readdirSync(TMP)
            .filter(f => f.startsWith(prefix))
            .forEach(f => unlinkSync(join(TMP, f)));
    } catch { /* ignorar */ }
};

/** Detecta si yt-dlp está instalado */
const checkYtdlp = async () => {
    try { await execAsync('yt-dlp --version', { timeout: 5000 }); return true; }
    catch { return false; }
};

// ── Obtener metadata (sin descargar) ──────────────────────────────────────────
async function fetchInfo(url) {
    const { stdout } = await execAsync(
        `yt-dlp --dump-json --no-playlist --playlist-items 1 --no-warnings -- "${url}"`,
        { timeout: TIMEOUT_INF }
    );
    return JSON.parse(stdout.trim());
}

// ── Descargar VIDEO ───────────────────────────────────────────────────────────
async function downloadVideo(url, outTemplate) {
    /**
     * Estrategia de calidad:
     * 1. Intenta best mp4 ≤ 720p
     * 2. Fallback: best disponible (algunos sitios no tienen mp4 nativo)
     * El resultado se muxea con ffmpeg si es necesario.
     */
    const fmtPrimary  = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best';
    const cmd = [
        'yt-dlp',
        '--no-playlist',
        '--playlist-items', '1',
        '-f', `"${fmtPrimary}"`,
        '--merge-output-format', 'mp4',
        '--no-warnings',
        '--newline',
        '-o', `"${outTemplate}"`,
        '--', `"${url}"`,
    ].join(' ');

    await execAsync(cmd, { timeout: TIMEOUT_DL, maxBuffer: 50 * 1024 * 1024 });
}

// ── Descargar AUDIO (MP3) ─────────────────────────────────────────────────────
async function downloadAudio(url, outTemplate) {
    const cmd = [
        'yt-dlp',
        '--no-playlist',
        '--playlist-items', '1',
        '-f', 'bestaudio/best',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '5',      // ~128 kbps, buen balance tamaño/calidad
        '--no-warnings',
        '-o', `"${outTemplate}"`,
        '--', `"${url}"`,
    ].join(' ');

    await execAsync(cmd, { timeout: TIMEOUT_DL, maxBuffer: 20 * 1024 * 1024 });
}

// ── Descargar IMÁGENES / Thumbnails ──────────────────────────────────────────
async function downloadImages(url, outTemplate) {
    /**
     * Para galerías (Instagram, Reddit) descarga hasta 10 items.
     * Para posts simples descarga el thumbnail.
     */
    const cmd = [
        'yt-dlp',
        '--playlist-items', '1-10',
        '-f', 'bestvideo[ext=jpg]/bestvideo[ext=png]/bestvideo[ext=webp]/best',
        '--write-thumbnail',
        '--skip-download',
        '--convert-thumbnails', 'jpg',
        '--no-warnings',
        '-o', `"${outTemplate}"`,
        '--', `"${url}"`,
    ].join(' ');

    // Fallback: si skip-download falla (sin video real), descargar directo
    try {
        await execAsync(cmd, { timeout: TIMEOUT_DL });
    } catch {
        // Intentar descarga directa de cada imagen como documento
        const cmdFallback = [
            'yt-dlp',
            '--playlist-items', '1-10',
            '--no-warnings',
            '-o', `"${outTemplate}"`,
            '--', `"${url}"`,
        ].join(' ');
        await execAsync(cmdFallback, { timeout: TIMEOUT_DL });
    }
}

/** Busca archivos generados con un prefijo en /tmp */
const findFiles = (prefix) =>
    readdirSync(TMP)
        .filter(f => f.startsWith(prefix))
        .map(f => join(TMP, f))
        .filter(existsSync);

// ── MIME según extensión ──────────────────────────────────────────────────────
const getMime = (filePath) => {
    const ext = extname(filePath).toLowerCase().replace('.', '');
    const map = {
        mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
        mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav',
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif', webp: 'image/webp',
    };
    return map[ext] || 'application/octet-stream';
};

const getMediaType = (filePath) => {
    const m = getMime(filePath);
    if (m.startsWith('video/'))  return 'video';
    if (m.startsWith('audio/'))  return 'audio';
    if (m.startsWith('image/'))  return 'image';
    return 'document';
};

// ═══════════════════════════════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════
const handler = async (m, { conn, text, usedPrefix, command }) => {

    // ── Validación básica ───────────────────────────────────────────────────────
    if (!text?.trim())
        throw `📎 Ingresa una URL.\n_Ejemplo: ${usedPrefix}${command} https://www.youtube.com/watch?v=dQw4w9WgXcQ_`;

    const url = text.trim().split(/\s+/)[0]; // solo el primer argumento

    if (!/^https?:\/\//i.test(url))
        throw '❌ La URL debe comenzar con *http://* o *https://*';

    // ── Verificar yt-dlp ───────────────────────────────────────────────────────
    if (!(await checkYtdlp()))
        throw '❌ *yt-dlp* no está instalado.\nEjecuta: `pkg install yt-dlp` en Termux.';

    const isAudio  = /^(ytdlpa|ytdlpaudio|dlpa)$/i.test(command);
    const isImages = /^(ytdlpi|ytdlpimg|dlpi)$/i.test(command);
    const isInfo   = /^(ytdlpinfo|dlpinfo|ytinfo2)$/i.test(command);

    // Prefijo único para archivos temp de esta sesión
    const prefix  = `rikka_ytdlp_${Date.now()}`;
    const outTmpl = join(TMP, `${prefix}_%(title).50s.%(ext)s`);

    await react(conn, m, '⏳');

    // ── MODO INFO ───────────────────────────────────────────────────────────────
    if (isInfo) {
        try {
            const info = await fetchInfo(url);
            const lines = [
                `*[ 🔍 YT-DLP INFO ]*`,
                ``,
                `📌 *Título:* ${info.title || 'N/A'}`,
                `👤 *Canal:* ${info.uploader || info.channel || 'N/A'}`,
                `⏱️ *Duración:* ${info.duration ? fmtSeconds(info.duration) : 'N/A'}`,
                `📅 *Fecha:* ${info.upload_date ? `${info.upload_date.slice(0,4)}-${info.upload_date.slice(4,6)}-${info.upload_date.slice(6)}` : 'N/A'}`,
                `👁️ *Vistas:* ${info.view_count ? info.view_count.toLocaleString('es') : 'N/A'}`,
                `❤️ *Likes:* ${info.like_count ? info.like_count.toLocaleString('es') : 'N/A'}`,
                `🌐 *Sitio:* ${info.extractor_key || info.extractor || 'N/A'}`,
                `🔗 *URL:* ${info.webpage_url || url}`,
                ``,
                `📦 *Formatos disponibles:* ${info.formats?.length || 0}`,
                info.description
                    ? `\n📝 *Descripción:*\n${info.description.slice(0, 300)}${info.description.length > 300 ? '...' : ''}`
                    : '',
            ].filter(l => l !== undefined);

            await conn.sendMessage(m.chat, { text: lines.join('\n') }, { quoted: m });
            await react(conn, m, '✅');
        } catch (e) {
            await react(conn, m, '❌');
            throw `❌ No se pudo obtener info.\n\`${e.message?.slice(0, 200)}\``;
        }
        return;
    }

    // ── MODOS DESCARGA ─────────────────────────────────────────────────────────
    let statusMsg;
    try {
        // Mensaje de estado editable
        const sent = await conn.sendMessage(m.chat,
            { text: `⏳ Obteniendo info de *${url.length > 50 ? url.slice(0,50)+'…' : url}*...` },
            { quoted: m });
        const statusKey = sent?.key;

        const editStatus = async (txt) => {
            if (!statusKey) return;
            try { await conn.sendMessage(m.chat, { text: txt, edit: statusKey }); }
            catch { /* si falla el edit, ignorar */ }
        };

        // ── Obtener metadata para el mensaje de estado ─────────────────────────
        let title = 'Descargando...';
        let site  = '';
        try {
            const info = await fetchInfo(url);
            title = info.title || 'Descargando...';
            site  = info.extractor_key || '';
        } catch { /* continuar sin metadata */ }

        await editStatus(`⏳ Descargando *${title}*${site ? ` (${site})` : ''}...`);

        // ── Ejecutar descarga ──────────────────────────────────────────────────
        if (isAudio) {
            await downloadAudio(url, outTmpl);
        } else if (isImages) {
            await downloadImages(url, outTmpl);
        } else {
            await downloadVideo(url, outTmpl);
        }

        // ── Buscar archivos descargados ────────────────────────────────────────
        const files = findFiles(prefix);
        if (!files.length)
            throw 'No se encontraron archivos descargados. El sitio puede requerir login o no es compatible.';

        await editStatus(`📤 Enviando ${files.length > 1 ? files.length + ' archivos' : 'archivo'}...`);

        // ── Enviar cada archivo ────────────────────────────────────────────────
        for (const filePath of files) {
            const buffer   = readFileSync(filePath);
            const fileSize = buffer.length;
            const mime     = getMime(filePath);
            const type     = getMediaType(filePath);
            const name     = basename(filePath);

            // Archivos muy grandes → como documento
            const forceDoc = fileSize > WA_LIMIT;

            if (forceDoc) {
                await conn.sendMessage(m.chat, {
                    document: buffer,
                    mimetype: mime,
                    fileName: name,
                    caption: `📦 *${name}*\n📏 Tamaño: ${fmtBytes(fileSize)}\n⚠️ Enviado como documento por superar el límite.`,
                }, { quoted: m });

            } else if (type === 'video') {
                await conn.sendMessage(m.chat, {
                    video:    buffer,
                    mimetype: 'video/mp4',
                    fileName: name,
                    caption:  `🎬 *${title}*`,
                }, { quoted: m });

            } else if (type === 'audio') {
                await conn.sendMessage(m.chat, {
                    audio:    buffer,
                    mimetype: 'audio/mpeg',
                    fileName: name,
                    ptt:      false,
                }, { quoted: m });

            } else if (type === 'image') {
                await conn.sendMessage(m.chat, {
                    image:   buffer,
                    caption: `🖼️ *${title}*`,
                }, { quoted: m });

            } else {
                // Documento genérico
                await conn.sendMessage(m.chat, {
                    document: buffer,
                    mimetype: mime,
                    fileName: name,
                }, { quoted: m });
            }
        }

        await editStatus(`✅ *¡Listo!* ${files.length > 1 ? `Se enviaron ${files.length} archivos.` : `Descarga completada.`}`);
        await react(conn, m, '✅');

    } catch (e) {
        await react(conn, m, '❌');

        // Parsear errores comunes de yt-dlp para mensajes amigables
        const err = e?.message || String(e);
        let userMsg = `❌ *Error al descargar.*\n\`${err.slice(0, 300)}\``;

        if (/HTTP Error 403/i.test(err))
            userMsg = '❌ *Acceso denegado (403).* El sitio bloquea descargas o requiere cookies de sesión.';
        else if (/HTTP Error 429/i.test(err))
            userMsg = '❌ *Demasiadas solicitudes (429).* Espera unos minutos e intenta de nuevo.';
        else if (/login.*required|not available|sign in/i.test(err))
            userMsg = '❌ *El contenido requiere inicio de sesión* (cuenta privada o restricción de edad).';
        else if (/No video formats/i.test(err))
            userMsg = '❌ No se encontraron formatos de video descargables en esa URL.';
        else if (/Unable to download/i.test(err))
            userMsg = '❌ No se pudo descargar. Verifica que el link sea válido y público.';
        else if (/not supported/i.test(err))
            userMsg = '❌ Este sitio web *no es compatible* con yt-dlp.';
        else if (/ffmpeg/i.test(err))
            userMsg = '❌ Error de *FFmpeg*. Asegúrate de tener `pkg install ffmpeg` instalado.';

        throw userMsg;

    } finally {
        // Limpiar archivos temporales siempre
        cleanTmp(prefix);
    }
};

// ── Metadata del plugin ─────────────────────────────────────────────────────
handler.help    = ['ytdlp <url>', 'ytdlpa <url>', 'ytdlpi <url>', 'ytdlpinfo <url>'];
handler.tags    = ['downloader'];
handler.command = /^(ytdlp|ytdlpa|ytdlpaudio|ytdlpi|ytdlpimg|ytdlpinfo|dlpa|dlpi|dlpinfo|ytinfo2|dlp)$/i;

export default handler;
