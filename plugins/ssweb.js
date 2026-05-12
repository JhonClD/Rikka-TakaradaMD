import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const handler = async (m, { conn, text, args }) => {
  if (!args[0]) return conn.reply(m.chat, "𓂃 ࣪˖ 📎 *Ingresa la URL del sitio web.*", m);

  const url = args[0].startsWith("http") ? args[0] : "https://" + args[0];

  let browser;
  try {
    browser = await puppeteer.launch({
      // RUTA EXACTA QUE ENCONTRAMOS EN TU KANAARIMA-MD
      executablePath: './.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome',
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
        '--no-zygote',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });

    // Navegar y esperar carga
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Espera extra para Cloudflare
    await new Promise(resolve => setTimeout(resolve, 5000));

    const screenshotBuffer = await page.screenshot({ type: 'png' });

    await conn.sendMessage(m.chat, {
      image: screenshotBuffer,
      caption: `𓂃 ࣪˖ 📸 *Captura de:* ${url}`
    }, { quoted: m });

  } catch (e) {
    console.error(e);
    // Si sale error de "shared libraries", el problema es la imagen de Docker (Nodejs 24)
    m.reply(`𓂃 ࣪˖ ❌ *Error:* ${e.message.includes('shared libraries') ? 'Al servidor le faltan librerías gráficas de Linux.' : e.message}`);
  } finally {
    if (browser) await browser.close();
  }
};

handler.help = ["ss", "ssweb"].map((v) => v + " <url>");
handler.tags = ["internet"];
handler.command = /^ss(web)?$/i;

export default handler;
