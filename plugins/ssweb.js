import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Activamos el plugin de sigilo para evitar detecciones (Cloudflare, etc.)
puppeteer.use(StealthPlugin());

const handler = async (m, { conn, text, args }) => {
  if (!args[0]) return conn.reply(m.chat, "𓂃 ࣪˖ 📎 *Ingresa la URL del sitio web para capturar.*", m);

  // Validar y formatear la URL
  const url = args[0].startsWith("http") ? args[0] : "https://" + args[0];

  let browser;
  try {
    // Lanzamos el navegador sin definir executablePath para que use el del entorno local
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();

    // Definimos un User-Agent real para mayor compatibilidad
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

    // Configuración de pantalla (HD)
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

    // Navegar a la web
    await page.goto(url, { 
      waitUntil: 'networkidle2', 
      timeout: 40000 
    });

    // Pequeña pausa para asegurar carga de imágenes dinámicas
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Tomar la captura en buffer
    const screenshotBuffer = await page.screenshot({ fullPage: false, type: 'png' });

    // Enviar el resultado
    await conn.sendMessage(m.chat, {
      image: screenshotBuffer,
      caption: `𓂃 ࣪˖ 📸 *Captura de:* ${url}`
    }, { quoted: m });

  } catch (e) {
    console.error("Error en SSWEB:", e);
    m.reply(`𓂃 ࣪˖ ❌ *Error:* No se pudo obtener la captura.\n\n*Detalle:* ${e.message}`);
  } finally {
    // Cerrar siempre el navegador para no consumir RAM innecesaria
    if (browser) {
      await browser.close();
    }
  }
};

handler.help = ["ss", "ssweb"].map((v) => v + " <url>");
handler.tags = ["internet"];
handler.command = /^ss(web)?f?$/i;

export default handler;
