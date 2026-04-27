import fetch from 'node-fetch';

const handler = async (m, { conn, text, args }) => {
  if (!args[0]) return conn.reply(m.chat, "𓂃 ࣪˖ 📎 *Ingresa la URL del sitio web.*", m);

  const url = args[0].startsWith("http") ? args[0] : "https://" + args[0];

  const apis = [
    `https://image.thum.io/get/width/1920/fullpage/${url}`,
    `https://api.screenshotmachine.com/?key=c04d3a&url=${url}&dimension=1920x1080`,
    `https://api.microlink.io?url=${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url`,
    `https://api.lolhuman.xyz/api/SSWeb?apikey=${global.lolkeysapi}&url=${url}`
  ];

  let success = false;

  for (const api of apis) {
    try {
      const res = await fetch(api);
      if (!res.ok) continue;

      const buffer = Buffer.from(await res.arrayBuffer());

      if (buffer.length < 10000) continue;

      await conn.sendMessage(m.chat, { 
        image: buffer, 
        caption: `𓂃 ࣪˖ 📸 *Captura de:* ${url}` 
      }, { quoted: m });
      
      success = true;
      break; 
    } catch (e) {
      continue;
    }
  }

  if (!success) {
    m.reply("𓂃 ࣪˖ ❌ *Error:* No se pudo obtener la captura. La página puede tener protección o las APIs están saturadas.");
  }
};

handler.help = ["ss", "ssf"].map((v) => v + " <url>");
handler.tags = ["internet"];
handler.command = /^ss(web)?f?$/i;

export default handler;
