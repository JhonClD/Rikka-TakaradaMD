let handler = async (m, { args, command, conn }) => {
  if (!args[0]) throw `*⚠️ Ingresa un enlace de Facebook.*\n\n*Ejemplo:* .${command} https://www.facebook.com/watch/?v=12345`

  const fbLink = args[0]
  if (!/facebook\.com|fb\.watch/g.test(fbLink)) throw '*❌ El enlace no parece ser de Facebook.*'

  try {
    const encoded = encodeURIComponent(fbLink)

    const apis = [
      `https://rest.apicausas.xyz//api/v1/descargas/facebook?apikey=causa-nakano-212-jhon=https://www.facebook.com/watch?v=123456789`
    ]

    let videoUrl = null

    for (const api of apis) {
      try {
        const res = await fetch(api)
        if (!res.ok) continue
        const json = await res.json()

        videoUrl = json.resultado?.url ||
                   json.data?.url ||
                   json.result?.url ||
                   (Array.isArray(json.data) ? json.data[0].url : null) ||
                   json.url

        if (videoUrl && videoUrl.startsWith('http')) break
      } catch (err) {
        console.error(`Fallo en API: ${api}`, err.message)
        continue
      }
    }

    if (!videoUrl) throw '*[ ❌ ] No se pudo extraer el video. Las APIs podrían estar caídas.*'

    // Descargar como buffer directo, sin guardar en disco
    const videoRes = await fetch(videoUrl)
    if (!videoRes.ok) throw '*[ ❌ ] No se pudo descargar el video.*'
    const buffer = Buffer.from(await videoRes.arrayBuffer())

    await conn.sendMessage(m.chat, {
      video: buffer,
      caption: '✅ *Video de Facebook descargado*',
      fileName: 'fb_video.mp4',
      mimetype: 'video/mp4'
    }, { quoted: m })

  } catch (e) {
    console.error(e)
    m.reply(`❌ *Error:* ${e.message || e || 'Ocurrió un problema inesperado.'}`)
  }
}

handler.help = ['fb <enlace>']
handler.tags = ['downloader']
handler.command = ['fb', 'facebook', 'fbdl']

export default handler
