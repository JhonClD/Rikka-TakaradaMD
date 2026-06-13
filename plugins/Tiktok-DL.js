import fetch from 'node-fetch'; // o fetch nativo si tu versión de Node lo soporta

let handler = async (m, { conn, text, usedPrefix, command }) => {
    if (!text) throw `❌ Por favor, ingresa un enlace de TikTok válido.\nEjemplo: *${usedPrefix + command} https://vm.tiktok.com/...*`;
    if (!text.includes('tiktok.com')) throw '❌ El enlace no parece ser de TikTok.';

    await conn.reply(m.chat, '⏳ Descargando video de TikTok, por favor espera...', m);
    
    try {
        const response = await fetch(`https://tikwm.com/api/?url=${encodeURIComponent(text)}`);
        const json = await response.json();

        if (json.code === 0 && json.data && json.data.play) {
            const title = json.data.title || "Video de TikTok";
            await conn.sendMessage(m.chat, { 
                video: { url: json.data.play }, 
                caption: `🌸 *TikTok Descargado* 🌸\n\n📌 *Título:* ${title}` 
            }, { quoted: m });
        } else {
            await conn.reply(m.chat, '❌ No se pudo descargar el video. Intenta con otro enlace.', m);
        }
    } catch (err) {
        console.error(err);
        await conn.reply(m.chat, '❌ Ocurrió un error al intentar procesar el enlace de TikTok.', m);
    }
};

handler.help = ['tiktok', 'tt'];
handler.tags = ['downloader'];
handler.command = /^(tiktok|tt|tk)$/i;

export default handler;
