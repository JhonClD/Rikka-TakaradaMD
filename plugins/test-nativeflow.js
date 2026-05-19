const { proto, generateWAMessageFromContent, getDevice } =
  await import('@whiskeysockets/baileys')

async function sendInteractive(conn, chat, interactiveMessage, quotedMsg) {
  const msg = generateWAMessageFromContent(
    chat,
    {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage,
        },
      },
    },
    { userJid: conn.user.jid, quoted: quotedMsg }
  )
  await conn.relayMessage(chat, msg.message, { messageId: msg.key.id })
  return msg
}

async function sendSingleSelect(conn, m) {
  const interactiveMessage = proto.Message.InteractiveMessage.fromObject({
    header: proto.Message.InteractiveMessage.Header.fromObject({
      title: '🔘 single_select',
      hasMediaAttachment: false,
    }),
    body: proto.Message.InteractiveMessage.Body.fromObject({
      text: 'Elige una opción del menú desplegable.\nEsta es la variante *single_select* de NativeFlow.',
    }),
    footer: proto.Message.InteractiveMessage.Footer.fromObject({
      text: `${global.botName ?? 'Rikka-TakaradaMD'} — test-nativeflow`,
    }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
      buttons: [
        {
          name: 'single_select',
          buttonParamsJson: JSON.stringify({
            title: '📋 Ver opciones',
            sections: [
              {
                title: '🛠️ Acciones de prueba',
                highlight_label: 'NUEVO',
                rows: [
                  {
                    header:      'Opción Alpha',
                    title:       'Opción Alpha',
                    description: 'Primera opción de la lista',
                    id:          '.testbtn resultado alpha',
                  },
                  {
                    header:      'Opción Beta',
                    title:       'Opción Beta',
                    description: 'Segunda opción de la lista',
                    id:          '.testbtn resultado beta',
                  },
                  {
                    header:      'Opción Gamma',
                    title:       'Opción Gamma',
                    description: 'Tercera opción de la lista',
                    id:          '.testbtn resultado gamma',
                  },
                ],
              },
              {
                title: '⚙️ Configuración',
                rows: [
                  {
                    header:      'Modo rápido',
                    title:       'Modo rápido',
                    description: 'Activa respuestas instantáneas',
                    id:          '.testbtn resultado modo-rapido',
                  },
                  {
                    header:      'Modo silencioso',
                    title:       'Modo silencioso',
                    description: 'Solo responde al owner',
                    id:          '.testbtn resultado modo-silencioso',
                  },
                ],
              },
            ],
          }),
        },
      ],
      messageParamsJson: '',
    }),
  })

  return sendInteractive(conn, m.chat, interactiveMessage, m)
}

async function sendLimitedTimeOffer(conn, m) {

  const expirationMs = Date.now() + 24 * 60 * 60 * 1000
  const expirationSec = Math.floor(expirationMs / 1000)

  const interactiveMessage = proto.Message.InteractiveMessage.fromObject({
    header: proto.Message.InteractiveMessage.Header.fromObject({
      title: '⏳ limited_time_offer',
      hasMediaAttachment: false,
    }),
    body: proto.Message.InteractiveMessage.Body.fromObject({
      text: '🎁 *¡Oferta especial por tiempo limitado!*\n\nEsta oferta expira en *24 horas*.\nEl botón muestra cuenta regresiva en móviles.',
    }),
    footer: proto.Message.InteractiveMessage.Footer.fromObject({
      text: `${global.botName ?? 'Rikka-TakaradaMD'} — test-nativeflow`,
    }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
      buttons: [
        {
          name: 'limited_time_offer',
          buttonParamsJson: JSON.stringify({

            title:              '🛒 Reclamar oferta ahora',

            expiration_time_ms:  expirationMs,

            has_expiration:      true,
          }),
        },
      ],
      messageParamsJson: '',
    }),
  })

  return sendInteractive(conn, m.chat, interactiveMessage, m)
}

async function sendBottomSheet(conn, m) {
  const interactiveMessage = proto.Message.InteractiveMessage.fromObject({
    header: proto.Message.InteractiveMessage.Header.fromObject({
      title: '📋 bottom_sheet',
      hasMediaAttachment: false,
    }),
    body: proto.Message.InteractiveMessage.Body.fromObject({
      text: 'Este botón abre una *hoja inferior* (bottom sheet).\nEs similar a single_select pero con presentación de modal.',
    }),
    footer: proto.Message.InteractiveMessage.Footer.fromObject({
      text: `${global.botName ?? 'Rikka-TakaradaMD'} — test-nativeflow`,
    }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
      buttons: [
        {
          name: 'bottom_sheet',
          buttonParamsJson: JSON.stringify({

            title: '📂 Abrir opciones',
            sections: [
              {
                title: '🎌 Categorías de anime',
                rows: [
                  {
                    id:          '.testbtn resultado accion',
                    title:       'Acción / Aventura',
                    description: 'Shonen, Seinen de lucha',
                  },
                  {
                    id:          '.testbtn resultado romance',
                    title:       'Romance / Slice of Life',
                    description: 'Historias cotidianas',
                  },
                  {
                    id:          '.testbtn resultado isekai',
                    title:       'Isekai / Fantasy',
                    description: 'Otro mundo, magia y sistemas',
                  },
                ],
              },
              {
                title: '🕐 Por temporada',
                rows: [
                  {
                    id:          '.testbtn resultado spring2026',
                    title:       'Spring 2026',
                    description: 'Temporada actual',
                  },
                  {
                    id:          '.testbtn resultado winter2026',
                    title:       'Winter 2026',
                    description: 'Temporada anterior',
                  },
                ],
              },
            ],
          }),
        },
      ],
      messageParamsJson: '',
    }),
  })

  return sendInteractive(conn, m.chat, interactiveMessage, m)
}

async function sendAllButtons(conn, m) {
  const expirationMs = Date.now() + 6 * 60 * 60 * 1000

  const interactiveMessage = proto.Message.InteractiveMessage.fromObject({
    header: proto.Message.InteractiveMessage.Header.fromObject({
      title: '🧪 NativeFlow — Test completo',
      hasMediaAttachment: false,
    }),
    body: proto.Message.InteractiveMessage.Body.fromObject({
      text:
        '╔══ *NativeFlow Buttons Test* ══╗\n' +
        '║ 1️⃣  *single_select* → lista\n' +
        '║ 2️⃣  *limited_time_offer* → oferta\n' +
        '║ 3️⃣  *bottom_sheet* → hoja modal\n' +
        '╚════════════════════════════╝\n\n' +
        '_Toca cualquier botón para probarlo._',
    }),
    footer: proto.Message.InteractiveMessage.Footer.fromObject({
      text: `${global.botName ?? 'Rikka-TakaradaMD'} — test-nativeflow`,
    }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
      buttons: [

        {
          name: 'single_select',
          buttonParamsJson: JSON.stringify({
            title: '1️⃣ single_select',
            sections: [
              {
                title: 'Lista de prueba',
                rows: [
                  { id: '.testbtn resultado alpha',  title: 'Alpha',  description: 'Primera fila'   },
                  { id: '.testbtn resultado beta',   title: 'Beta',   description: 'Segunda fila'   },
                  { id: '.testbtn resultado gamma',  title: 'Gamma',  description: 'Tercera fila'   },
                ],
              },
            ],
          }),
        },

        {
          name: 'limited_time_offer',
          buttonParamsJson: JSON.stringify({
            title:              '2️⃣ limited_time_offer',
            expiration_time_ms:  expirationMs,
            has_expiration:      true,
          }),
        },

        {
          name: 'bottom_sheet',
          buttonParamsJson: JSON.stringify({
            title: '3️⃣ bottom_sheet',
            sections: [
              {
                title: 'Hoja modal',
                rows: [
                  { id: '.testbtn resultado fila-1', title: 'Fila 1', description: 'Opción A' },
                  { id: '.testbtn resultado fila-2', title: 'Fila 2', description: 'Opción B' },
                ],
              },
            ],
          }),
        },
      ],
      messageParamsJson: '',
    }),
  })

  return sendInteractive(conn, m.chat, interactiveMessage, m)
}

const handler = async (m, { conn, args }) => {
  const device = getDevice(m.key.id)
  const isMobile = device !== 'desktop' && device !== 'web'

  const sub = (args[0] || '').toLowerCase()

  if (!isMobile) {
    await conn.sendMessage(
      m.chat,
      {
        text:
          `⚠️ *Dispositivo detectado:* \`${device}\`\n\n` +
          `Los botones NativeFlow *no se renderizan* en WhatsApp Web/Desktop.\n` +
          `Úsalo desde un dispositivo móvil para ver los botones correctamente.\n\n` +
          `_Enviando de todas formas..._`,
      },
      { quoted: m }
    )
  }

  if (sub === 'single' || sub === 's') {
    await sendSingleSelect(conn, m)
  } else if (sub === 'offer' || sub === 'o') {
    await sendLimitedTimeOffer(conn, m)
  } else if (sub === 'sheet' || sub === 'sh') {
    await sendBottomSheet(conn, m)
  } else if (sub === 'all' || sub === 'a') {
    await sendAllButtons(conn, m)
  } else if (sub === 'resultado') {

    const eleccion = args.slice(1).join(' ')
    await conn.sendMessage(
      m.chat,
      { text: `✅ *Selección recibida (fallback texto):*\n🎯 *${eleccion}*` },
      { quoted: m }
    )
  } else {
    await conn.sendMessage(
      m.chat,
      {
        text:
          `🧪 *test-nativeflow — Ayuda*\n\n` +
          `\`\`\`\n` +
          `.testbtn single  → single_select\n` +
          `.testbtn offer   → limited_time_offer\n` +
          `.testbtn sheet   → bottom_sheet\n` +
          `.testbtn all     → los 3 juntos\n` +
          `\`\`\`\n\n` +
          `_Requiere WhatsApp móvil para ver los botones._`,
      },
      { quoted: m }
    )
  }
}

handler.command = /^testbtn$/i
handler.tags    = ['owner', 'test']
handler.help    = ['testbtn <single|offer|sheet|all>']
handler.description = 'Prueba de botones NativeFlow: single_select, limited_time_offer, bottom_sheet'

handler.before = async function (m, { conn }) {
  const nativeFlow = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage
  if (!nativeFlow) return false

  try {
    const params     = JSON.parse(nativeFlow.paramsJson || '{}')
    const selectedId = params?.id || null
    if (!selectedId) return false

    if (!selectedId.startsWith('.testbtn resultado')) return false

    const eleccion = selectedId.replace('.testbtn resultado ', '')
    await conn.sendMessage(
      m.chat,
      {
        text:
          `✅ *NativeFlow — respuesta recibida*\n\n` +
          `👤 *Usuario:* @${m.sender.split('@')[0]}\n` +
          `🆔 *Row ID:* \`${selectedId}\`\n` +
          `🎯 *Selección:* *${eleccion}*\n\n` +
          `_handler.before interceptó correctamente el interactiveResponseMessage._`,
        mentions: [m.sender],
      },
      { quoted: m }
    )
    return true
  } catch (e) {
    console.error('[testbtn before]', e.message)
    return false
  }
}

export default handler
                   
