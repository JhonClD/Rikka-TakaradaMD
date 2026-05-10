import syntaxerror from 'syntax-error'
import { format } from 'util'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { createRequire } from 'module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(__dirname)

const handler = async (m, { conn, client, args, text, command, isOwner }) => {
  const socket = conn || client

  if (!isOwner)
    return socket.sendMessage(
      m.chat,
      { text: '🔗 *Acceso denegado.*\nSolo el *owner* puede ejecutar código.' },
      { quoted: m }
    )

  if (!text?.trim())
    return socket.sendMessage(
      m.chat,
      {
        text:
          `⚙️ *Ejecutor de código — Rikka-TakaradaMD*\n\n` +
          `Debes proporcionar código a ejecutar.\n\n` +
          `*Uso:*\n` +
          `• *.ex* <código>  → ejecuta (sin return)\n` +
          `• *.e* <expresión> → evalúa y retorna resultado`
      },
      { quoted: m }
    )

  const _text = (command === 'e' ? 'return ' : '') + text
  const old = m.exp * 1

  let _return, _syntax = ''

  try {
    await socket.sendMessage(m.chat, { react: { text: '⏳', key: m.key } })

    let i = 15
    let f = { exports: {} }

    const exec = new (async () => {}).constructor(
      'print', 'm', 'client', 'conn', 'require',
      'Array', 'process', 'args', 'module', 'exports', 'argument',
      _text
    )

    _return = await exec.call(
      socket,
      (...a) => {
        if (--i < 1) return
        return socket.sendMessage(m.chat, { text: format(...a) }, { quoted: m })
      },
      m, socket, socket, require,
      Array, process, args, f, f.exports,
      [socket]
    )

    await socket.sendMessage(m.chat, { react: { text: '🔗', key: m.key } })

  } catch (e) {
    const err = syntaxerror(_text, 'Execution Function', {
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      sourceType: 'module'
    })
    if (err) _syntax = '```' + err + '```\n\n'
    _return = e

    await socket.sendMessage(m.chat, { react: { text: '❌', key: m.key } })

  } finally {
    await socket.sendMessage(
      m.chat,
      { text: _syntax + format(_return) },
      { quoted: m }
    )
    m.exp = old
  }
}

handler.help = ['ex <código>', 'e <expresión>']
handler.tags = ['owner']
handler.command = /^(ex|e)$/i
handler.owner = true

export default handler
