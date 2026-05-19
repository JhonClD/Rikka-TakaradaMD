const { getDevice } = await import('@whiskeysockets/baileys')


const IMG_URL = 'https://files.evogb.win/j3nZpp.jpg'

async function fetchImageBuffer (url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
    },
  })
  if (!res.ok) throw new Error('fetch image failed: ' + res.status)
  return Buffer.from(await res.arrayBuffer())
}

const handler = async (m, { conn, args }) => {
  const device = getDevice(m.key.id)
  const isMobile = device !== 'desktop' && device !== 'web'
  const sub = (args[0] || '').toLowerCase()
  const footer = global.botName ?? 'Rikka-TakaradaMD'

  if (!isMobile && sub !== 'list' && sub !== 'l' && sub !== 'template' && sub !== 't') {
    await conn.sendMessage(
      m.chat,
      {
        text:
          `⚠️ *Dispositivo detectado:* \`${device}\`\n\n` +
          `Los botones NativeFlow *no se renderizan* en WhatsApp Web/Desktop.\n` +
          `Úsalo desde móvil para ver los botones correctamente.\n\n` +
          `_Enviando de todas formas..._`,
      },
      { quoted: m }
    )
  }

  if (sub === 'quick' || sub === 'q') {
    await conn.sendMessage(
      m.chat,
      {
        image: await fetchImageBuffer(IMG_URL),
        caption:
          '╔══ *quick_reply Test* ══╗\n' +
          '║ Botones de respuesta rápida.\n' +
          '║ Cada botón envía un comando\n' +
          '║ directamente al handler.\n' +
          '╚═════════════════════╝',
        footer,
        nativeFlow: [
          { text: '⚡ Acción Alpha',  id: '.testbtn resultado alpha',  icon: 'review'  },
          { text: '🔥 Acción Beta',   id: '.testbtn resultado beta',   icon: 'review'  },
          { text: '🎯 Acción Gamma',  id: '.testbtn resultado gamma',  icon: 'default' },
        ],
      },
      { quoted: m }
    )

  } else if (sub === 'copy' || sub === 'c') {
    await conn.sendMessage(
      m.chat,
      {
        text:
          '╔══ *cta_copy Test* ══╗\n' +
          '║ Botón para copiar texto\n' +
          '║ al portapapeles del usuario.\n' +
          '╚══════════════════╝',
        footer,
        nativeFlow: [
          { text: '📋 Copiar código',  copy: 'RIKKA2026',    icon: 'default' },
          { text: '📋 Copiar token',   copy: 'TOKEN-XYZ-99', icon: 'default' },
        ],
      },
      { quoted: m }
    )

  } else if (sub === 'url' || sub === 'u') {
    await conn.sendMessage(
      m.chat,
      {
        text:
          '╔══ *cta_url Test* ══╗\n' +
          '║ Botón que abre una URL.\n' +
          '║ useWebview = abre dentro de WA.\n' +
          '╚═════════════════╝',
        footer,
        nativeFlow: [
          { text: '🌐 GitHub (webview)',  url: 'https://github.com',            useWebview: true,  icon: 'default' },
          { text: '🔗 Repo del bot',      url: 'https://github.com/rikka-md',   useWebview: false, icon: 'default' },
        ],
      },
      { quoted: m }
    )

  } else if (sub === 'call' || sub === 'ca') {
    await conn.sendMessage(
      m.chat,
      {
        text:
          '╔══ *cta_call Test* ══╗\n' +
          '║ Botón que inicia una llamada\n' +
          '║ telefónica al número indicado.\n' +
          '╚══════════════════╝',
        footer,
        nativeFlow: [
          { text: '📞 Llamar soporte', call: '51925092348', icon: 'default' },
        ],
      },
      { quoted: m }
    )

  } else if (sub === 'single' || sub === 's') {
    await conn.sendMessage(
      m.chat,
      {
        text:
          '╔══ *single_select Test* ══╗\n' +
          '║ Lista desplegable con secciones.\n' +
          '║ Elige una opción del menú.\n' +
          '╚════════════════════════╝',
        footer,
        nativeFlow: [
          {
            text: '📋 Ver opciones',
            icon: 'default',
            sections: [
              {
                title: '🛠️ Acciones de prueba',
                highlight_label: 'NUEVO',
                rows: [
                  { header: 'Opción Alpha', title: 'Opción Alpha', description: 'Primera opción de la lista',  id: '.testbtn resultado alpha'  },
                  { header: 'Opción Beta',  title: 'Opción Beta',  description: 'Segunda opción de la lista', id: '.testbtn resultado beta'   },
                  { header: 'Opción Gamma', title: 'Opción Gamma', description: 'Tercera opción de la lista', id: '.testbtn resultado gamma'  },
                ],
              },
              {
                title: '⚙️ Configuración',
                rows: [
                  { header: 'Modo rápido',     title: 'Modo rápido',     description: 'Activa respuestas instantáneas', id: '.testbtn resultado modo-rapido'     },
                  { header: 'Modo silencioso', title: 'Modo silencioso', description: 'Solo responde al owner',         id: '.testbtn resultado modo-silencioso' },
                ],
              },
            ],
          },
        ],
      },
      { quoted: m }
    )

  } else if (sub === 'offer' || sub === 'o') {
    await conn.sendMessage(
      m.chat,
      {
        text:
          '╔══ *limited_time_offer Test* ══╗\n' +
          '║ 🎁 ¡Oferta especial por tiempo limitado!\n' +
          '║ Esta oferta expira en *24 horas*.\n' +
          '║ El botón muestra cuenta regresiva en móvil.\n' +
          '╚══════════════════════════════╝',
        footer,
        offerText:       '🏷️ Oferta exclusiva 24h',
        offerCode:       'RIKKA2026',
        offerExpiration:  Date.now() + 24 * 60 * 60 * 1000,
        nativeFlow: [
          { text: '🛒 Reclamar oferta', id: '.testbtn resultado oferta-reclamada', icon: 'review' },
        ],
      },
      { quoted: m }
    )

  } else if (sub === 'sheet' || sub === 'sh') {
    await conn.sendMessage(
      m.chat,
      {
        text:
          '╔══ *bottom_sheet Test* ══╗\n' +
          '║ Este botón abre una hoja inferior.\n' +
          '║ Similar a single_select pero modal.\n' +
          '╚═════════════════════╝',
        footer,
        optionText:  '📂 Abrir opciones',
        optionTitle: '🎌 Categorías',
        nativeFlow: [
          {
            text: '📂 Abrir opciones',
            icon: 'default',
            sections: [
              {
                title: '🎌 Categorías de anime',
                rows: [
                  { id: '.testbtn resultado accion',  title: 'Acción / Aventura',      description: 'Shonen, Seinen de lucha'   },
                  { id: '.testbtn resultado romance',  title: 'Romance / Slice of Life', description: 'Historias cotidianas'       },
                  { id: '.testbtn resultado isekai',   title: 'Isekai / Fantasy',        description: 'Otro mundo, magia y sistemas' },
                ],
              },
              {
                title: '🕐 Por temporada',
                rows: [
                  { id: '.testbtn resultado spring2026', title: 'Spring 2026', description: 'Temporada actual'   },
                  { id: '.testbtn resultado winter2026', title: 'Winter 2026', description: 'Temporada anterior' },
                ],
              },
            ],
          },
        ],
      },
      { quoted: m }
    )

  } else if (sub === 'carousel' || sub === 'cr') {
    await conn.sendMessage(
      m.chat,
      {
        text:   '🎠 *Carrusel interactivo — cards Test*',
        footer,
        cards: [
          {
            image: await fetchImageBuffer(IMG_URL),
            caption: '🃏 *Tarjeta 1* — Acción',
            footer:  'card footer 1',
            nativeFlow: [
              { text: '⚡ Ver más',   id:  '.testbtn resultado card1',              icon: 'review'  },
              { text: '🌐 GitHub',    url: 'https://github.com', useWebview: true,  icon: 'default' },
            ],
          },
          {
            image: await fetchImageBuffer(IMG_URL),
            caption: '🃏 *Tarjeta 2* — Oferta',
            footer:  'card footer 2',
            offerText:       '🏷️ Solo hoy',
            offerExpiration:  Date.now() + 6 * 60 * 60 * 1000,
            nativeFlow: [
              { text: '🛒 Reclamar', id: '.testbtn resultado card2-oferta', icon: 'review' },
            ],
          },
          {
            image: await fetchImageBuffer(IMG_URL),
            caption: '🃏 *Tarjeta 3* — Lista',
            footer:  'card footer 3',
            optionText:  '📋 Opciones',
            optionTitle: 'Tarjeta 3',
            nativeFlow: [
              {
                text: '📋 Opciones',
                icon: 'default',
                sections: [
                  {
                    title: 'Opciones de tarjeta',
                    rows: [
                      { id: '.testbtn resultado card3-a', title: 'Opción A', description: 'Primera' },
                      { id: '.testbtn resultado card3-b', title: 'Opción B', description: 'Segunda' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      { quoted: m }
    )

  } else if (sub === 'template' || sub === 't') {
    await conn.sendMessage(
      m.chat,
      {
        title:   '📄 Hydrated Template',
        image: await fetchImageBuffer(IMG_URL),
        caption:
          '╔══ *templateButtons Test* ══╗\n' +
          '║ Botones de plantilla hidratada.\n' +
          '║ Funcionan en Web y Móvil.\n' +
          '╚═══════════════════════╝',
        footer,
        templateButtons: [
          { text: '⚡ Acción rápida',  id:   '.testbtn resultado template-btn'      },
          { text: '🌐 GitHub',          url:  'https://github.com'                   },
          { text: '📞 Soporte',         call: '51925092348'                          },
        ],
        interactiveAsTemplate: true,
      },
      { quoted: m }
    )

  } else if (sub === 'list' || sub === 'l') {
    await conn.sendMessage(
      m.chat,
      {
        text:       '📋 *Lista clásica Test*\n\nElige una opción de la lista (solo funciona en chats privados).',
        footer,
        buttonText: '📋 Ver lista',
        title:      'Lista de opciones',
        sections: [
          {
            title: '🛠️ Acciones',
            rows: [
              { title: 'Opción 1', description: 'Primera opción',  rowId: '.testbtn resultado lista-1' },
              { title: 'Opción 2', description: 'Segunda opción', rowId: '.testbtn resultado lista-2' },
              { title: 'Opción 3', description: 'Tercera opción',  rowId: '.testbtn resultado lista-3' },
            ],
          },
          {
            title: '⚙️ Extra',
            rows: [
              { title: 'Ayuda',     description: 'Muestra la ayuda',      rowId: '.testbtn resultado lista-ayuda'     },
              { title: 'Configurar',description: 'Configuración del bot', rowId: '.testbtn resultado lista-configurar' },
            ],
          },
        ],
      },
      { quoted: m }
    )

  } else if (sub === 'all' || sub === 'a') {
    await conn.sendMessage(
      m.chat,
      {
        image: await fetchImageBuffer(IMG_URL),
        caption:
          '╔══ *NativeFlow — Test completo* ══╗\n' +
          '║ 1️⃣  quick_reply    → botón con id\n' +
          '║ 2️⃣  single_select  → lista desplegable\n' +
          '║ 3️⃣  bottom_sheet   → hoja modal\n' +
          '╚══════════════════════════════╝\n\n' +
          '_Toca cualquier botón para probarlo._',
        footer,
        offerText:       '🏷️ Oferta 6h',
        offerCode:       'RIKKA2026',
        offerExpiration:  Date.now() + 6 * 60 * 60 * 1000,
        optionText:  '📋 Ver todo',
        optionTitle: 'Menú principal',
        nativeFlow: [
          { text: '⚡ quick_reply', id: '.testbtn resultado all-quickreply', icon: 'review' },
          {
            text: '1️⃣ single_select',
            icon: 'default',
            sections: [
              {
                title: 'Lista de prueba',
                rows: [
                  { id: '.testbtn resultado alpha', title: 'Alpha', description: 'Primera fila'  },
                  { id: '.testbtn resultado beta',  title: 'Beta',  description: 'Segunda fila'  },
                  { id: '.testbtn resultado gamma', title: 'Gamma', description: 'Tercera fila'  },
                ],
              },
            ],
          },
          {
            text: '3️⃣ bottom_sheet',
            icon: 'default',
            sections: [
              {
                title: 'Hoja modal',
                rows: [
                  { id: '.testbtn resultado fila-1', title: 'Fila 1', description: 'Opción A' },
                  { id: '.testbtn resultado fila-2', title: 'Fila 2', description: 'Opción B' },
                ],
              },
            ],
          },
        ],
        viewOnce: true,
      },
      { quoted: m }
    )

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
          `.testbtn quick    → quick_reply buttons\n` +
          `.testbtn copy     → cta_copy\n` +
          `.testbtn url      → cta_url\n` +
          `.testbtn call     → cta_call\n` +
          `.testbtn single   → single_select\n` +
          `.testbtn offer    → limited_time_offer\n` +
          `.testbtn sheet    → bottom_sheet\n` +
          `.testbtn carousel → cards / carrusel\n` +
          `.testbtn template → templateButtons\n` +
          `.testbtn list     → lista clásica\n` +
          `.testbtn all      → quick+single+sheet\n` +
          `\`\`\`\n\n` +
          `_Requiere WhatsApp móvil excepto \`template\` y \`list\`._`,
      },
      { quoted: m }
    )
  }
}

handler.command   = /^testbtn$/i
handler.tags      = ['owner', 'test']
handler.help      = ['testbtn <sub>']
handler.description = 'Prueba completa de NativeFlow: quick_reply, cta_copy, cta_url, cta_call, single_select, limited_time_offer, bottom_sheet, cards, templateButtons, lista clásica'

handler.before = async function (m, { conn }) {
  const nf = m.message?.interactiveResponseMessage?.nativeFlowResponseMessage
  const lr = m.message?.listResponseMessage
  const br = m.message?.buttonsResponseMessage
  const tr = m.message?.templateButtonReplyMessage

  let selectedId = null

  if (nf?.paramsJson) {
    try {
      const p = JSON.parse(nf.paramsJson)
      selectedId = p?.id ?? null
    } catch { return false }
  } else if (lr?.singleSelectReply?.selectedRowId) {
    selectedId = lr.singleSelectReply.selectedRowId
  } else if (br?.selectedButtonId) {
    selectedId = br.selectedButtonId
  } else if (tr?.selectedId) {
    selectedId = tr.selectedId
  }

  if (!selectedId) return false
  if (!selectedId.startsWith('.testbtn resultado')) return false

  const eleccion = selectedId.replace('.testbtn resultado ', '').trim()

  await conn.sendMessage(
    m.chat,
    {
      text:
        `✅ *NativeFlow — respuesta recibida*\n\n` +
        `👤 *Usuario:* @${m.sender.split('@')[0]}\n` +
        `🆔 *ID:* \`${selectedId}\`\n` +
        `🎯 *Selección:* *${eleccion}*\n\n` +
        `_handler.before interceptó el mensaje correctamente._`,
      mentions: [m.sender],
    },
    { quoted: m }
  )
  return true
}

export default handler
  
