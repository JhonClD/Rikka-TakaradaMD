import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { executablePath } from 'puppeteer'; // Importación clave

puppeteer.use(StealthPlugin());

const handler = async (m, { conn, text, args }) => {
  if (!args[0]) return conn.reply(m.chat, "𓂃 ࣪˖ 📎 *Ingresa la URL del sitio web.*", m);

  const url = args[0].startsWith("http") ? args[0] : "https://" + args[0];

  let browser;
  try {
    browser = await puppeteer.launch({
      // Esto intenta encontrar el Chromium que viene con Puppeteer automáticamente
      executablePath: executablePath(), 
      headless: 'new', // Recomendado para versiones recientes
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gl-drawing-for-tests',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();

    // User agent para parecer un navegador real y evitar bloqueos
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

    // Navegar con timeout ajustado
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    // En versiones nuevas de puppeteer, waitForTimeout está deprecado. Usamos una promesa simple:
    await new Promise(resolve => setTimeout(resolve, 3000));

    const screenshotBuffer = await page.screenshot({ fullPage: false });

    await conn.sendMessage(m.chat, {
      image: screenshotBuffer,
      caption: `𓂃 ࣪˖ 📸 *Captura de:* ${url}`
    }, { quoted: m });

  } catch (e) {
    console.error("Error en Puppeteer:", e);
    // Si el error persiste, es que el Panel no tiene las librerías de Linux necesarias
    m.reply(`𓂃 ࣪˖ ❌ *Error de entorno:* No se encontró Chromium o faltan librerías en el servidor. Verifica el Egg de Pelican.`);
  } finally {
    if (browser) await browser.close();
  }
};

handler.help = ["ss", "ssweb"].map((v) => v + " <url>");
handler.tags = ["internet"];
handler.command = /^ss(web)?f?$/i;

export default handler;
