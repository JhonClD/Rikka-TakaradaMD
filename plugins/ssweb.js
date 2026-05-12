import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { executablePath } from 'puppeteer';

// Configuración del plugin de sigilo para evadir Cloudflare y detecciones
puppeteer.use(StealthPlugin());

const handler = async (m, { conn, args }) => {
  if (!args[0]) return conn.reply(m.chat, "𓂃 ࣪˖ 📎 *Ingresa la URL del sitio web.*", m);

  // Formatear URL
  const url = args[0].startsWith("http") ? args[0] : "https://" + args[0];

  let browser;
  try {
    browser = await puppeteer.launch({
      // CLAVE: Esto busca automáticamente el Chromium descargado en node_modules
      executablePath: executablePath(),
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gl-drawing-for-tests',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();

    // User agent real para saltar protecciones
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36');

    // Configurar tamaño de la captura
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

    // Navegar y esperar a que la red esté inactiva (ayuda con Cloudflare)
    await page.goto(url, { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });

    // Espera extra de 3 segundos para asegurar que carguen los elementos visuales
    await new Promise(resolve => setTimeout(resolve, 3000));

    const screenshotBuffer = await page.screenshot({ fullPage: false, type: 'png' });

    await conn.sendMessage(m.chat, {
      image: screenshotBuffer,
      caption: `𓂃 ࣪˖ 📸 *Captura de:* ${url}`
    }, { quoted: m });

  } catch (e) {
    console.error("ERROR EN SSWEB:", e);
    m.reply(`𓂃 ࣪˖ ❌ *Error de ejecución:* ${e.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};

handler.help = ["ss", "ssweb"].map((v) => v + " <url>");
handler.tags = ["internet"];
handler.command = /^ss(web)?f?$/i;

export default handler;
