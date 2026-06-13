import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import config from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpDir = path.join(__dirname, '..', 'tmp');

// Función para intentar descargar usando el yt-dlp instalado globalmente en el servidor
function downloadWithGlobalYtDlp(url, outputName) {
    return new Promise((resolve, reject) => {
        // Escapar comillas
        const cleanUrl = url.replace(/"/g, '\\"');
        
        // Comando para ejecutar yt-dlp instalado globalmente en Linux/Windows
        const cmdStr = `yt-dlp -f "best[ext=mp4]/best" --no-playlist --max-filesize 50M -o "${outputName}" "${cleanUrl}"`;
        
        exec(cmdStr, (error, stdout, stderr) => {
            if (error) {
                return reject({ error, stderr });
            }
            resolve(stdout);
        });
    });
}

// Función para descargar usando APIs web (Cobalt) con cabeceras simuladoras de navegador
async function downloadWithCobaltApi(url) {
    const instances = [
        'https://api.cobalt.tools/',
        'https://cobalt.api.ryz.cx/',
        'https://cobalt.kudo.fun/'
    ];

    let errorMsg = '';

    for (const instance of instances) {
        try {
            console.log(`[YouTube] Intentando descargar con: ${instance}`);
            const response = await fetch(instance, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    // Cabeceras cruciales para burlar Cloudflare / Bloqueos antibot
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Origin': 'https://cobalt.tools',
                    'Referer': 'https://cobalt.tools/'
                },
                body: JSON.stringify({
                    url: url,
                    videoQuality: '720',
                    filenamePattern: 'basic'
                })
            });

            const json = await response.ok ? await response.json() : null;

            if (json && json.url && json.status !== 'error') {
                return { success: true, url: json.url };
            } else if (json && json.text) {
                errorMsg = json.text;
            }
        } catch (e) {
            console.warn(`[YouTube] Fallo en la instancia ${instance}: ${e.message}`);
        }
    }

    return { success: false, error: errorMsg || 'No se pudo obtener el enlace de descarga.' };
}

export default {
    name: 'youtube',
    aliases: ['yt', 'ytmp4'],
    desc: 'Descarga videos de YouTube de forma estable (sin binarios en la carpeta, compatible con Pelican Panel)',
    run: async (sock, msg, from, args, text, reply) => {
        if (!text) return reply(`❌ Por favor, ingresa un enlace de YouTube válido.\nEjemplo: \`${config.prefix}youtube https://www.youtube.com/watch?v=...\``);
        if (!text.includes('youtube.com') && !text.includes('youtu.be')) return reply('❌ El enlace no parece ser de YouTube.');

        try {
            await reply('⏳ Procesando video de YouTube, por favor espera...');

            const outputName = path.join(tmpDir, `yt_${Date.now()}.mp4`);
            
            // Asegurar que exista la carpeta temporal
            if (!fs.existsSync(tmpDir)) {
                fs.mkdirSync(tmpDir, { recursive: true });
            }

            console.log('[YouTube] Método 1: Intentando con yt-dlp global...');
            try {
                await downloadWithGlobalYtDlp(text, outputName);
                
                // Si la descarga por yt-dlp global fue exitosa
                if (fs.existsSync(outputName)) {
                    await sock.sendMessage(from, { 
                        video: fs.readFileSync(outputName), 
                        caption: `🎥 *YouTube Descargado con Éxito* 🌸\n\n⚙️ _Video procesado localmente con el motor del servidor._` 
                    }, { quoted: msg });
                    
                    fs.unlinkSync(outputName);
                    return; // Fin del comando
                }
            } catch (ytDlpErr) {
                console.log('[YouTube] yt-dlp global no disponible o falló. Pasando al Método 2 (API Cobalt)...');
            }

            // Método 2: Descarga por API web (Cobalt con headers de navegador)
            const apiResult = await downloadWithCobaltApi(text);
            
            if (apiResult.success && apiResult.url) {
                await sock.sendMessage(from, { 
                    video: { url: apiResult.url }, 
                    caption: `🎥 *YouTube Descargado con Éxito* 🌸\n\n⚙️ _Video procesado mediante API Web._` 
                }, { quoted: msg });
            } else {
                await reply(`❌ No se pudo descargar el video.\n\n${apiResult.error || 'Asegúrate de que el enlace sea correcto o intenta de nuevo más tarde.'}`);
            }

        } catch (err) {
            console.error('Error general en el comando youtube:', err);
            await reply('❌ Ocurrió un error inesperado al procesar la descarga de YouTube.');
        }
    }
};
