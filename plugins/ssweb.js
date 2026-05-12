import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const handler = async (m, { conn, text, args }) => {
  if (!args[0]) return conn.reply(m.chat, "𓂃 ࣪˖ 📎 *Ingresa la URL del sitio web.*", m);

  const url = args[0].startsWith("http") ? args[0] : "https://" + args[0];

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true, // Cambiar a 'new' para el nuevo modo headless o false para ver el navegador
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

    // Configurar el viewport para HD
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 8 });

    // Navegar a la URL
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Esperar un tiempo adicional para asegurar que todo el contenido se cargue, incluyendo Cloudflare
    await page.waitForTimeout(5000); // Espera 5 segundos adicionales

    const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png', quality: 100 });

    if (screenshotBuffer.length < 10000) {
      throw new Error("La captura de pantalla es demasiado pequeña, posiblemente falló.");
    }

    await conn.sendMessage(m.chat, {
      image: screenshotBuffer,
      caption: `𓂃 ࣪˖ 📸 *Captura de:* ${url}`
    }, { quoted: m });

  } catch (e) {
    console.error("Error al tomar la captura de pantalla:", e);
    m.reply(`𓂃 ࣪˖ ❌ *Error:* No se pudo obtener la captura. ${e.message || 'La página puede tener protección o hubo un problema con el navegador.'}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
};

handler.help = ["ss", "ssf"].map((v) => v + " <url>");
handler.tags = ["internet"];
handler.command = /^ss(web)?f?$/i;

export default handler;
  
