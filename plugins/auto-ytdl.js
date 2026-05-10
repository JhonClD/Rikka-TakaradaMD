/**
 * ╔══════════════════════════════════════════════╗
 * ║        AUTO YOUTUBE DOWNLOADER               ║
 * ║  Detecta links de YouTube automáticamente    ║
 * ║  sin necesidad de comandos.                  ║
 * ║  Pon este archivo en: plugins/auto-ytdl.js   ║
 * ╚══════════════════════════════════════════════╝
 *
 * CÓMO FUNCIONA:
 *  - Usa plugin.all → se ejecuta en CADA mensaje
 *  - Si detecta un link de YouTube, descarga automáticamente
 *  - Respeta grupos: solo actúa si autoYT está activado en el grupo
 *  - En privado: siempre activo
 *  - Ignora mensajes del propio bot
 *  - Ignora si el mensaje ya es un comando (tiene prefijo)
 *
 * COMANDOS DE CONTROL (para admins/owner):
 *  .autoyt on   → activa auto-descarga en el grupo
 *  .autoyt off  → desactiva auto-descarga en el grupo
 *  .autoyt       → muestra estado actual
 */

import {
    YT_REGEX,
    ytInfo,
    ytDownload,
    buildInfoCard,
} from '../src/libraries/youtube-scraper.js';

// ── Regex para detectar links de YouTube en cualquier parte del texto ──────────
const YT_DETECT = /(?:https?:\/\/)?(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|v\/))([a-zA-Z0-9_-]{11})/i;

// ── Extrae la URL completa del texto ──────────────────────────────────────────
const extractYTUrl = (text) => {
    const match = text?.match(YT_DETECT);
    if (!match) return null;
    // Reconstruir URL limpia
    const videoId = match[1];
    return `https://www.youtube.com/watch?v=${videoId}`;
};

// ── Control por grupo (almacenado en global.db) ───────────────────────────────
const isAutoYTEnabled = (chatId) => {
    // En privado siempre activo
    if (!chatId.endsWith('@g.us')) return true;
    // En grupos: verificar la config
    return global.db?.data?.chats?.[chatId]?.autoYT === true;
};

const setAutoYT = (chatId, value) => {
    if (!global.db?.data?.chats) return;
    if (!global.db.data.chats[chatId]) global.db.data.chats[chatId] = {};
    global.db.data.chats[chatId].autoYT = value;
};

// ── Anti-spam: evitar descargar el mismo link dos veces seguidas ───────────────
const _recentDownloads = new Map();
const COOLDOWN_MS = 30_000; // 30 segundos por link

const isOnCooldown = (url) => {
    const last = _recentDownloads.get(url);
    if (!last) return false;
    return Date.now() - last < COOLDOWN_MS;
};

const markDownloaded = (url) => {
    _recentDownloads.set(url, Date.now());
    // Limpiar entradas viejas cada cierto tiempo
    if (_recentDownloads.size > 50) {
        const now = Date.now();
        for (const [k, v] of _recentDownloads)
            if (now - v > COOLDOWN_MS * 2) _recentDownloads.delete(k);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  HANDLER COMANDO: .autoyt on/off
// ══════════════════════════════════════════════════════════════════════════════
const handler = async (m, { conn, text, usedPrefix, command }) => {
    const isGroup = m.chat.endsWith('@g.us');

    if (!isGroup) {
        return conn.sendMessage(m.chat,
            { text: `ℹ️ En privado la auto-descarga de YouTube *siempre está activa*.` },
            { quoted: m });
    }

    const arg = text?.trim().toLowerCase();

    if (!arg) {
        const estado = isAutoYTEnabled(m.chat);
        return conn.sendMessage(m.chat, {
            text: `*[ 📺 AUTO YOUTUBE ]*\n\nEstado actual: ${estado ? '✅ *Activado*' : '❌ *Desactivado*'}\n\nUsa:\n• *${usedPrefix}autoyt on* — activar\n• *${usedPrefix}autoyt off* — desactivar`
        }, { quoted: m });
    }

    if (arg === 'on') {
        setAutoYT(m.chat, true);
        return conn.sendMessage(m.chat, {
            text: `✅ *Auto YouTube activado.*\nAhora cuando alguien mande un link de YouTube lo descargaré automáticamente.`
        }, { quoted: m });
    }

    if (arg === 'off') {
        setAutoYT(m.chat, false);
        return conn.sendMessage(m.chat, {
            text: `❌ *Auto YouTube desactivado.*\nSeguirás pudiendo usar los comandos manuales: .ytmp3 y .ytmp4`
        }, { quoted: m });
    }

    return conn.sendMessage(m.chat,
        { text: `⚠️ Uso: *${usedPrefix}autoyt on* o *${usedPrefix}autoyt off*` },
        { quoted: m });
};

handler.help    = ['autoyt on/off'];
handler.tags    = ['downloader', 'group'];
handler.command = /^(autoyt|autoytdl|autoyoutube)$/i;

// ══════════════════════════════════════════════════════════════════════════════
//  PLUGIN.ALL — Se ejecuta en CADA mensaje para detectar links
// ══════════════════════════════════════════════════════════════════════════════
handler.all = async function (m) {
    // 1. Ignorar mensajes del bot mismo
    if (m.isBaileys || m.fromMe) return;

    // 2. Ignorar si no hay texto
    const text = m.text || m.body || '';
    if (!text) return;

    // 3. Verificar si auto-descarga está habilitada en este chat
    if (!isAutoYTEnabled(m.chat)) return;

    // 4. Ignorar si el mensaje empieza con un prefijo de comando
    //    (no interferir con .ytmp3, .ytmp4, etc.)
    const prefixes = global.prefix instanceof RegExp
        ? null
        : (Array.isArray(global.prefix) ? global.prefix : [global.prefix]);
    if (prefixes && prefixes.some(p => text.startsWith(p))) return;
    if (global.prefix instanceof RegExp && global.prefix.test(text[0])) return;

    // 5. Detectar link de YouTube
    const ytUrl = extractYTUrl(text);
    if (!ytUrl) return;

    // 6. Anti-cooldown
    if (isOnCooldown(ytUrl)) return;
    markDownloaded(ytUrl);

    const socket = this; // conn

    try {
        // Reacción de carga
        await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } });

        // Descargar como VIDEO por defecto (más visual al compartir links)
        // Cambia 'video' a 'audio' si prefieres MP3 por defecto
        const { buffer, meta: dlMeta } = await ytDownload(ytUrl, 'video', { quality: '720p' });

        // Enriquecer metadata
        const ytsMeta = await ytInfo(ytUrl).catch(() => null);
        const meta = {
            title:    ytsMeta?.title    || dlMeta?.title    || 'Video_YouTube',
            channel:  ytsMeta?.channel  || dlMeta?.channel  || 'N/A',
            views:    ytsMeta?.views    ?? dlMeta?.views,
            duration: ytsMeta?.duration || dlMeta?.duration,
            date:     ytsMeta?.date     || dlMeta?.date,
            url:      ytsMeta?.url      || ytUrl,
        };

        const title    = meta.title || 'Video_YouTube';
        const fileName = `${title.replace(/[\\/:*?"<>|]/g, '')}.mp4`;

        // Enviar tarjeta de info
        await socket.sendMessage(m.chat,
            { text: buildInfoCard(meta, 'video') },
            { quoted: m });

        // Enviar video
        await socket.sendMessage(m.chat, {
            video:    buffer,
            mimetype: 'video/mp4',
            fileName,
        }, { quoted: m });

        await socket.sendMessage(m.chat, { react: { text: '✅', key: m.key } });

    } catch (e) {
        // En auto-mode, fallar silenciosamente (no spamear con errores)
        console.error(`[auto-ytdl ERROR] ${e.message}`);
        await socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {});
    }
};

export default handler;
