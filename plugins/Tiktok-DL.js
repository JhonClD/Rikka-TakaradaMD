import fetch from 'node-fetch';

let handler = async (m, { conn, text, usedPrefix, command }) => {
    if (!text) throw `❌ Por favor, ingresa un enlace de TikTok o un término de búsqueda.\n\nEjemplos:\n📌 *Con enlace:* ${usedPrefix + command} https://vm.tiktok.com/...\n📌 *Con búsqueda:* ${usedPrefix + command} videos de minecraft`;

    const isLink = text.match(/(https?:\/\/)?(www\.)?(vt|vm|v)\.tiktok\.com\/[a-zA-Z0-9]+/gi) || 
                   text.match(/(https?:\/\/)?(www\.)?tiktok\.com\/@[a-zA-Z0-9._]+\/video\/[0-9]+/gi) || 
                   text.includes('tiktok.com');

    if (isLink) {
        try {
            await m.reply('⏳ Descargando video de TikTok, por favor espera...');
            const response = await fetch(`https://tikwm.com/api/?url=${encodeURIComponent(text)}`);
            const json = await response.json();

            if (json.code === 0 && json.data && json.data.play) {
                const title = json.data.title || "Video de TikTok";
                await conn.sendMessage(m.chat, { 
                    video: { url: json.data.play }, 
                    caption: `🌸 *TikTok Descargado* 🌸\n\n📌 *Título:* ${title}` 
                }, { quoted: m });
            } else {
                await m.reply('❌ No se pudo descargar el video. Intenta con otro enlace o comprueba que no sea privado.');
            }
        } catch (err) {
            console.error(err);
            await m.reply('❌ Ocurrió un error al intentar procesar el enlace de TikTok.');
        }
    } else {
        try {
            await m.reply(`🔍 Buscando "${text}" en TikTok...`);
            const response = await fetch(`https://tikwm.com/api/feed/search?keywords=${encodeURIComponent(text)}&count=12&cursor=0`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            const json = await response.json();

            if (json.code === 0 && json.data && json.data.videos && json.data.videos.length > 0) {
                const videos = json.data.videos.filter(v => v.play || v.wmplay).slice(0, 6);
                if (videos.length === 0) {
                    return m.reply('❌ No se encontraron videos con enlace de descarga para tu búsqueda.');
                }

                await m.reply(`✨ Se encontraron resultados. Enviando ${videos.length} videos...`);

                for (let i = 0; i < videos.length; i++) {
                    const video = videos[i];
                    const videoUrl = video.play || video.wmplay;
                    const title = video.title || `Video ${i + 1}`;
                    const author = video.author?.nickname || "Desconocido";

                    try {
                        await conn.sendMessage(m.chat, {
                            video: { url: videoUrl },
                            caption: `🎥 *Video ${i + 1}/${videos.length}*\n\n📌 *Título:* ${title}\n👤 *Autor:* ${author}`
                        }, { quoted: m });
                        // Pequeño retardo de 2 segundos para no saturar la conexión de red
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    } catch (e) {
                        console.error(`Error al enviar el video ${i + 1}:`, e);
                    }
                }
            } else {
                await m.reply('❌ No se encontraron resultados para tu búsqueda.');
            }
        } catch (err) {
            console.error(err);
            await m.reply('❌ Ocurrió un error al realizar la búsqueda en TikTok.');
        }
    }
};

handler.help = ['tiktok', 'tt'].map(v => v + ' <enlace o búsqueda>');
handler.tags = ['downloader'];
handler.command = /^(tiktok|tt|tk)$/i;

export default handler;
