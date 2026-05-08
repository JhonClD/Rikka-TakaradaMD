/**
 * y2mate.js — Rikka-TakaradaMD
 * Descarga de YouTube via y2mate con rotación de servidores, timeout y retry
 */

import fetch  from 'node-fetch';
import { JSDOM } from 'jsdom';

const TIMEOUT_MS = 25_000;
const SERVERS    = ['en68', 'en60', 'en61', 'id4'];

export const ytIdRegex = /(?:http(?:s|):\/\/|)(?:(?:www\.|)youtube(?:\-nocookie|)\.com\/(?:shorts\/)?(?:watch\?.*(?:|\&)v=|embed\/|v\/)|youtu\.be\/)([-_0-9A-Za-z]{11})/;

// ── Utilidades ────────────────────────────────────────────────────────────────
function extractVideoId(url) {
    const m = ytIdRegex.exec(url);
    return m ? m[1] : null;
}

function postWithTimeout(url, formdata, ms = TIMEOUT_MS) {
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, {
        method:  'POST',
        signal:  ctrl.signal,
        headers: {
            'accept':          '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'content-type':    'application/x-www-form-urlencoded; charset=UTF-8',
            'user-agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: new URLSearchParams(Object.entries(formdata)),
    }).finally(() => clearTimeout(t));
}

// ── Descarga principal ────────────────────────────────────────────────────────
/**
 * @param {string} url     - URL de YouTube
 * @param {string} quality - '144p'|'240p'|'360p'|'480p'|'720p'|'1080p'|'128kbps'
 * @param {string} type    - 'mp4' | 'mp3'
 * @param {string} bitrate - '144'|'240'|'360'|'480'|'720'|'1080'|'128'
 * @param {string} [server]- servidor fijo (opcional; si se omite rota automáticamente)
 */
async function yt(url, quality, type, bitrate, server) {
    const vtId = extractVideoId(url);
    if (!vtId) throw new Error('URL de YouTube inválida');

    const cleanUrl = `https://youtu.be/${vtId}`;
    const servers  = server
        ? [server, ...SERVERS.filter(s => s !== server)]   // el pedido primero, luego el resto
        : [...SERVERS].sort(() => Math.random() - 0.5);    // orden aleatorio

    let lastErr = new Error('y2mate: todos los servidores fallaron');

    for (const srv of servers) {
        try {
            // ── Paso 1: analyze ───────────────────────────────────────────
            const r1 = await postWithTimeout(
                `https://www.y2mate.com/mates/${srv}/analyze/ajax`,
                { url: cleanUrl, q_auto: 0, ajax: 1 }
            );
            if (!r1.ok) continue;

            const j1 = await r1.json();
            if (!j1?.result) continue;

            const { document } = new JSDOM(j1.result).window;
            const tables = document.querySelectorAll('table');
            const table  = tables[{ mp4: 0, mp3: 1 }[type] ?? 0];
            if (!table) continue;

            // ── Obtener filesize ──────────────────────────────────────────
            let filesize = 'N/A';
            if (type === 'mp4') {
                const links = [...table.querySelectorAll('td > a[href="#"]')]
                    .filter(v => !/\.3gp/.test(v.innerHTML));
                // buscar la calidad solicitada; si no está, tomar la primera disponible
                const match = links.find(v =>
                    v.innerHTML.toLowerCase().includes(quality.replace('kbps','').trim())
                ) || links[0];
                filesize = match?.parentElement?.nextSibling?.nextSibling?.innerHTML || 'N/A';
            } else {
                const tdLink = table.querySelector('td > a[href="#"]');
                filesize = tdLink?.parentElement?.nextSibling?.nextSibling?.innerHTML || 'N/A';
            }

            // ── k__id, thumb, title ───────────────────────────────────────
            const kidMatch = /var k__id = "(.*?)"/.exec(document.body.innerHTML);
            const kid      = kidMatch?.[1] || '';
            if (!kid) continue;

            const thumb = document.querySelector('img')?.src || '';
            const title = document.querySelector('b')?.innerHTML || 'Video';

            // ── Paso 2: convert ───────────────────────────────────────────
            const r2 = await postWithTimeout(
                `https://www.y2mate.com/mates/${srv}/convert`,
                { type: 'youtube', _id: kid, v_id: vtId, ajax: '1', token: '', ftype: type, fquality: bitrate }
            );
            if (!r2.ok) continue;

            const j2      = await r2.json();
            const dlMatch = /<a.+?href="(.+?)"/.exec(j2?.result || '');
            if (!dlMatch) continue;

            const KB = parseFloat(filesize) * (/MB$/i.test(filesize) ? 1000 : 1);
            return {
                dl_link:   dlMatch[1],
                thumb,
                title,
                filesizeF: filesize,
                filesize:  isNaN(KB) ? 0 : KB,
                server:    srv,
            };

        } catch (e) {
            lastErr = e;
        }
    }

    throw lastErr;
}

// ── Exports ───────────────────────────────────────────────────────────────────
export default {
    yt,
    ytIdRegex,
    servers: SERVERS,

    /** Audio MP3 128 kbps */
    yta(url, server) {
        return yt(url, '128kbps', 'mp3', '128', server);
    },

    /** Video MP4 (calidad configurable, por defecto 360p) */
    ytv(url, quality = '360p', server) {
        const bitrate = quality.replace('p', '');
        return yt(url, quality, 'mp4', bitrate, server);
    },
};
