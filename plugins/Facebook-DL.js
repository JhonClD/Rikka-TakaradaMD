let handler = async (m, { args, command, conn }) => {
  if (!args[0]) throw `*⚠️ Ingresa un enlace de Facebook.*\n\n*Ejemplo:* .${command} https://www.facebook.com/watch/?v=12345`

  const fbLink = args[0]
  if (!/facebook\.com|fb\.watch/g.test(fbLink)) throw '*❌ El enlace no parece ser de Facebook.*'

  await m.reply('*[⏳] Descargando video de Facebook...*')

  try {
    const encoded = encodeURIComponent(fbLink)

    const apis = [
      `https://rest.apicausas.xyz//api/v1/descargas/facebook?apikey=causa-nakano-212-jhon=https://www.facebook.com/watch?v=123456789`,
      `https://eliasar-yt-api.vercel.app/api/facebookdl?link=${encoded}`,
      `https://api.vreden.my.id/api/facebook?url=${encoded}`
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

    await conn.sendFile(m.chat, videoUrl, 'fb_video.mp4', `✅ *Video de Facebook descargado*`, m)

  } catch (e) {
    console.error(e)
    m.reply(`❌ *Error:* ${e.message || 'Ocurrió un problema inesperado.'}`)
  }
}

handler.help = ['fb <enlace>']
handler.tags = ['downloader']
handler.command = ['fb', 'facebook', 'fbdl']

export default handler
