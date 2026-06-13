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
                const videoUrl = json.data.play || json.data.wmplay;

                // Descargar el buffer con cabecera User-Agent
                const resVideo = await fetch(videoUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                const buffer = resVideo.buffer ? await resVideo.buffer() : Buffer.from(await resVideo.arrayBuffer());

                // Formato de caption
                const title = json.data.title || "Video de TikTok";
                const nickname = json.data.author?.nickname || "Desconocido";
                const uniqueId = json.data.author?.unique_id || "";
                const duration = json.data.duration || "0";
                const music = json.data.music_info?.title || "Sonido original";

                const caption = `❀ *Título ›* ${title}

☕ *Autor ›* ${nickname}
${uniqueId ? `@${uniqueId}` : ''}
✨ *Duración ›* ${duration}
🎵 *Música ›* ${music}`;

                const limit = 16 * 1024 * 1024; // Límite de 16 MB de WhatsApp
                const isLarge = buffer.length > limit;

                if (isLarge) {
                    await m.reply(`⚠️ El video pesa *${(buffer.length / (1024 * 1024)).toFixed(1)} MB* (excede el límite de 16 MB de WhatsApp).\nEnviando como documento para evitar errores de reproducción...`);
                }

                if (typeof conn.sendFile === 'function') {
                    await conn.sendFile(m.chat, buffer, 'tiktok.mp4', caption, m, false, { asDocument: isLarge });
                } else {
                    if (isLarge) {
                        await conn.sendMessage(m.chat, { 
                            document: buffer, 
                            mimetype: 'video/mp4', 
                            fileName: `${title.slice(0, 20)}.mp4`,
                            caption: caption
                        }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.chat, { video: buffer, caption: caption }, { quoted: m });
                    }
                }
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
            const response = await fetch(`https://tikwm.com/api/feed/search?keywords=${encodeURIComponent(text)}&count=15&cursor=0`, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });
            const json = await response.json();

            if (json.code === 0 && json.data && json.data.videos && json.data.videos.length > 0) {
                const videos = json.data.videos.filter(v => v.play || v.wmplay).slice(0, 10);
                if (videos.length === 0) {
                    return m.reply('❌ No se encontraron videos con enlace de descarga para tu búsqueda.');
                }

                await m.reply(`✨ Se encontraron resultados. Enviando ${videos.length} videos...`);

                for (let i = 0; i < videos.length; i++) {
                    const video = videos[i];
                    const videoUrl = video.play || video.wmplay;
                    const title = video.title || `Video ${i + 1}`;
                    const nickname = video.author?.nickname || "Desconocido";
                    const uniqueId = video.author?.unique_id || "";
                    const duration = video.duration || "0";
                    const music = video.music_info?.title || "Sonido original";

                    const caption = `❀ *Título ›* ${title}

☕ *Autor ›* ${nickname}
${uniqueId ? `@${uniqueId}` : ''}
✨ *Duración ›* ${duration}
🎵 *Música ›* ${music}`;

                    try {
                        const resVideo = await fetch(videoUrl, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                            }
                        });
                        const buffer = resVideo.buffer ? await resVideo.buffer() : Buffer.from(await resVideo.arrayBuffer());

                        const limit = 16 * 1024 * 1024; // Límite de 16 MB
                        const isLarge = buffer.length > limit;

                        if (typeof conn.sendFile === 'function') {
                            await conn.sendFile(m.chat, buffer, 'tiktok.mp4', caption, m, false, { asDocument: isLarge });
                        } else {
                            if (isLarge) {
                                await conn.sendMessage(m.chat, { 
                                    document: buffer, 
                                    mimetype: 'video/mp4', 
                                    fileName: `${title.slice(0, 20)}.mp4`,
                                    caption: caption
                                }, { quoted: m });
                            } else {
                                await conn.sendMessage(m.chat, { video: buffer, caption: caption }, { quoted: m });
                            }
                        }
                        
                        // Esperar 2 segundos entre envíos
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
