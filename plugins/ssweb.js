const handler = async (m, { conn, text }) => {
  if (!text) return m.reply('𓂃 ࣪˖ 📎 *Ingresa la URL del sitio web.*')
  
  // Limpiar URL
  let url = text.trim()
  if (!url.startsWith('http')) url = 'https://' + url

  try {
    // Usamos thum.io, una API profesional que toma capturas incluso con Cloudflare
    const ss = `https://image.thum.io/get/width/1200/noAnimate/fullpage/${url}`
    
    await conn.sendMessage(m.chat, { 
      image: { url: ss }, 
      caption: `𓂃 ࣪˖ 📸 *Captura de:* ${url}` 
    }, { quoted: m })

  } catch (e) {
    console.error(e)
    m.reply('𓂃 ࣪˖ ❌ *Error al generar la captura.* Intenta con otra URL.')
  }
}

handler.help = ['ss', 'ssweb'].map(v => v + ' <url>')
handler.tags = ['internet']
handler.command = /^ss(web)?f?$/i

export default handler
