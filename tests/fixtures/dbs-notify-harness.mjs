// Fixture de plugins/dbs-notify.js: se ejecuta en un proceso hijo.
//
// El plugin escribe en `database/`, crea timers globales y habla con
// animedbs.online, mega.nz, mediafire.com y graphql.anilist.co. Aquí se
// sustituyen las rutas y los módulos de red para poder probar el flujo real
// (sondeo → cola → descarga → envío) contra un servidor HTTP local.
//
// Uso: node tests/fixtures/dbs-notify-harness.mjs   (imprime JSON por stdout)
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { Readable } from 'node:stream'
import Module from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'dbs-harness-'))
const fileUrl = relative => new URL(`file://${path.join(ROOT, relative)}`).href
const out = payload => process.stdout.write(JSON.stringify(payload))

// ── Servidor de medios local ────────────────────────────────────────────────

const MEDIA_BYTES = 5 * 1024 * 1024
const IMAGE_BYTES = fs.readFileSync(path.join(ROOT, 'src/assets/menu.png'))
const mediaServer = http.createServer((req, res) => {
  if (req.url.startsWith('/cover.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': IMAGE_BYTES.length })
    res.end(IMAGE_BYTES)
    return
  }
  if (req.url.startsWith('/file.mp4')) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MEDIA_BYTES })
    res.end(Buffer.alloc(MEDIA_BYTES, 7))
    return
  }
  res.writeHead(404).end()
})
await new Promise(resolve => mediaServer.listen(0, '0.0.0.0', resolve))
const mediaUrl = `http://127.0.0.1:${mediaServer.address().port}/file.mp4`
const coverUrl = `http://127.0.0.1:${mediaServer.address().port}/cover.png`

// ── Dobles de red ────────────────────────────────────────────────────────────

const dbs = {
  home: [],
  directory: [],
  series: {},
  episodes: {},
  status: {},
  log: [],
}

const axiosImpl = async (url, config = {}) => {
  const target = String(url)
  dbs.log.push({ url: target, method: config.responseType || 'text' })
  if (!target.startsWith('http')) throw new Error(`URL inválida: ${JSON.stringify(url)} (${typeof url})`)
  if (dbs.status[target]) {
    const status = dbs.status[target]
    throw Object.assign(new Error(`HTTP ${status}`), { response: { status, data: '' } })
  }
  // Archivo real servido por el servidor local.
  if (target.startsWith('http://127.0.0.1:')) {
    if (config.responseType === 'stream') {
      const stream = Readable.from([Buffer.alloc(MEDIA_BYTES, 7)])
      return { status: 200, data: stream, headers: { 'content-type': 'video/mp4', 'content-length': String(MEDIA_BYTES) } }
    }
    const response = await fetch(target)
    const data = Buffer.from(await response.arrayBuffer())
    return { status: 200, data, headers: Object.fromEntries(response.headers), config }
  }
  if (target === 'https://www.animedbs.online') return { status: 200, data: dbs.home.join('') }
  if (target === 'https://www.animedbs.online/anime/?status=&type=&order=update') {
    return { status: 200, data: dbs.directory.join('') }
  }
  if (dbs.series[target] !== undefined) return { status: 200, data: dbs.series[target] }
  if (dbs.episodes[target] !== undefined) return { status: 200, data: dbs.episodes[target] }
  if (target === coverUrl) {
    const data = fs.readFileSync(path.join(ROOT, 'src/assets/menu.png'))
    return { status: 200, data, headers: { 'content-type': 'image/png' } }
  }
  // Página de MediaFire: apunta al archivo del servidor local.
  if (/mediafire\.com\/file\//.test(target)) {
    return { status: 200, data: `<a id="downloadButton" href="${mediaUrl}"></a>` }
  }
  throw new Error(`URL no simulada: ${target}`)
}
axiosImpl.get = axiosImpl
axiosImpl.head = async url => {
  if (String(url).startsWith('http://127.0.0.1:')) {
    return { headers: { 'content-length': String(MEDIA_BYTES), 'accept-ranges': 'none' } }
  }
  return { headers: {} }
}
axiosImpl.post = async () => ({ data: { data: { Page: { media: [] } } } })

// ── Redirección de módulos ───────────────────────────────────────────────────

const overrideDir = path.join(TMP, 'overrides')
fs.mkdirSync(overrideDir, { recursive: true })
const writeOverride = (name, source) => {
  const file = path.join(overrideDir, name)
  fs.writeFileSync(file, source)
  return `file://${file}`
}

const calls = { mensajes: [], enviados: [], compress: 0, error: null, descargas: [] }

globalThis.__dbsAxiosStub = axiosImpl
globalThis.__dbsMegajsStub = { File: { fromURL: () => ({ async loadAttributes() {}, download: () => null }) } }
globalThis.__dbsThumbStub = { createJpegThumbnail: async () => Buffer.from('thumb') }
globalThis.__dbsCompressStub = { compressDw4: async () => { calls.compress++ } }

const overrides = {
  'src/funcion/paths.js': writeOverride('paths.mjs', [
    `export * from ${JSON.stringify(fileUrl('src/funcion/paths.js'))};`,
    `export const DATA_DIR = ${JSON.stringify(path.join(TMP, 'database'))};`,
    `export const TEMP_VIDEOS_DIR = ${JSON.stringify(path.join(TMP, 'temp_videos'))};`,
    `export const __harnessTmp = ${JSON.stringify(TMP)};`,
  ].join('\n')),
  axios: writeOverride('axios.mjs', 'export default globalThis.__dbsAxiosStub;'),
  megajs: writeOverride('megajs.mjs', 'export const File = globalThis.__dbsMegajsStub.File;'),
  'animev1-download.cjs': writeOverride('thumb.mjs',
    'const api = globalThis.__dbsThumbStub; export default api; export const createJpegThumbnail = api.createJpegThumbnail;'),
  'dw4-compress.js': writeOverride('compress.mjs', 'export const compressDw4 = globalThis.__dbsCompressStub.compressDw4;'),
  // Cliente HTTP escalado: el doble de axios hace las veces de sitio simulado,
  // así el test sigue probando el plugin y no la capa de red.
  'src/libraries/dbs-http.js': writeOverride('dbs-http.mjs', [
    "export const HEADERS = { 'User-Agent': 'harness', Accept: 'text/html' };",
    'export async function fetchDbs(url, opciones = {}) {',
    '  try {',
    '    const respuesta = await globalThis.__dbsAxiosStub(url, { responseType: opciones.responseType, headers: opciones.headers });',
    '    const datos = Buffer.isBuffer(respuesta.data) ? respuesta.data.toString("utf8") : respuesta.data;',
    '    return { data: datos, status: respuesta.status || 200, headers: respuesta.headers || {} };',
    '  } catch (error) {',
    '    // Mismo contrato que el cliente real: el 403 llega como DBS_FORBIDDEN.',
    '    if (error?.response?.status === 403) {',
    '      const bloqueo = new Error("AnimeDBS bloqueó la petición (HTTP 403). Configura DBS_PROXY_URL o DBS_FLARESOLVERR_URL.");',
    '      bloqueo.code = "DBS_FORBIDDEN";',
    '      throw bloqueo;',
    '    }',
    '    throw error;',
    '  }',
    '}',
    'export function esErrorDeBloqueo(error) { return error?.code === "DBS_FORBIDDEN" || error?.status === 403 || error?.response?.status === 403; }',
    'export const ANIMEDBS_URL = "https://www.animedbs.online";',
  ].join('\n')),
}

const hookSource = `
const MAP = ${JSON.stringify(overrides)};
export async function resolve(specifier, context, nextResolve) {
  const limpio = specifier.split('?')[0];
  for (const [needle, target] of Object.entries(MAP)) {
    if (limpio === needle || limpio.endsWith('/' + needle)) {
      return { url: target, shortCircuit: true, format: 'module' };
    }
  }
  return nextResolve(specifier, context);
}
`
Module.register(`data:text/javascript,${encodeURIComponent(hookSource)}`, import.meta.url)

// Module.register instala el hook de forma asíncrona: los imports emitidos en
// el mismo tick se resuelven con el cargador normal. Se sondea hasta que la
// redirección esté viva antes de cargar el plugin.
async function esperarHooks() {
  const probe = fileUrl('src/funcion/paths.js')
  for (let intento = 0; intento < 100; intento++) {
    const mod = await import(`${probe}?probe=${intento}`)
    if (mod.__harnessTmp === TMP) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('el hook de módulos no se activó')
}

// ── Escenario ───────────────────────────────────────────────────────────────

const EP5_PATH = '/ver/one-piece-temporada-2-episodio-5'
const EP6_PATH = '/ver/one-piece-temporada-2-episodio-6'
const EPISODE_URL = `https://www.animedbs.online${EP5_PATH}`
const EP6_URL = `https://www.animedbs.online${EP6_PATH}`
const SERIES_URL = 'https://www.animedbs.online/anime/one-piece'
const MEDIAFIRE_PAGE = 'https://www.mediafire.com/file/abc123/one-piece-5.mp4'

// La ficha real de AnimeDBS trae dos grupos: SUB ("Descargar MP4") y
// LAT ("Descargar MP4 Latino"). Aquí el de LAT apunta a otro enlace para
// comprobar que solo se descarga una variante por episodio.
const MEDIAFIRE_PAGE_LAT = 'https://www.mediafire.com/file/def456/one-piece-5-lat.mp4'
const episodioHtml = (numero, fecha) =>
  `<div class="year">${fecha}</div>` +
  '<div class="episode-download-group"><h3>Descargar MP4</h3>' +
  '<span class="download-quality">720p</span>' +
  `<div class="download-hosts"><a href="${MEDIAFIRE_PAGE}">MediaFire</a></div></div>` +
  '<div class="episode-download-group"><h3>Descargar MP4 Latino</h3>' +
  '<span class="download-quality">720p</span>' +
  `<div class="download-hosts"><a href="${MEDIAFIRE_PAGE_LAT}">MediaFire</a></div></div>`

const homeHtml = (...episodios) => '<div class="listupd">' + episodios.flat().map(([href, titulo, epx, edad]) =>
  '<div class="bs"><div class="bsx">' +
  `<a href="${href}"></a><div class="epx">${epx}</div>` +
  `<h2 class="tite1">${titulo}</h2>` +
  `<span class="sosev">${edad}</span><span class="lg">SUB LAT</span>` +
  '</div></div>').join('') + '</div>'

const directoryHtml = () =>
  '<div class="listupd">' +
  `<div class="bs"><a href="/anime/one-piece"></a><h2 class="tite1">One Piece</h2><span class="lg">SUB LAT</span></div>` +
  '</div>'

function escenarioEp5() {
  dbs.home.length = 0
  dbs.home.push(homeHtml([[EP5_PATH, 'One Piece', 5, 'Hace 5 minutos']]))
  dbs.directory.length = 0
  dbs.directory.push(directoryHtml())
  dbs.series[SERIES_URL] =
    `<div class="thumb"><img src="${coverUrl}" /></div><h1>One Piece</h1>` +
    `<ul class="eplister"><li><a href="${EP5_PATH}">Episodio 5</a></li></ul>`
  dbs.episodes[EPISODE_URL] = episodioHtml(5, '2024-01-02 03:04:05')
}

// ── Carga del plugin ────────────────────────────────────────────────────────

const originalError = console.error
console.error = (...args) => { calls.error = String(args[0] ?? '') }

const originalWarn = console.warn
console.warn = () => {}

let handler
try {
  await esperarHooks()
  handler = (await import(`${fileUrl('plugins/dbs-notify.js')}?v=${Date.now()}`)).default
} catch (error) {
  out({ ok: false, fase: 'import', error: String(error?.stack || error) })
  process.exit(0)
}

const conn = {
  user: { jid: 'bot@s.whatsapp.net', id: 'bot@s.whatsapp.net' },
  async sendMessage(chatId, content) {
    calls.mensajes.push({
      chatId,
      texto: content?.text,
      caption: content?.caption,
      image: Boolean(content?.image),
      document: content?.document?.url ? String(content.document.url) : null,
      fileName: content?.fileName,
      mimetype: content?.mimetype,
    })
    if (content?.text) calls.enviados.push(content.text)
    return { key: { id: `msg-${calls.mensajes.length}`, remoteJid: chatId } }
  },
}

const CHAT = '120363000000000001@g.us'
const m = {
  chat: CHAT,
  sender: CHAT,
  isGroup: true,
  reply: async texto => { calls.enviados.push(texto) },
}

const call = (command, text) => handler(m, { conn, text, usedPrefix: '.', command, isOwner: true })
const leerJson = nombre => {
  try { return JSON.parse(fs.readFileSync(path.join(TMP, 'database', nombre), 'utf8')) } catch { return null }
}
const documentos = () => calls.mensajes.filter(msg => msg.document)
const consultasFicha = url => dbs.log.filter(entry => entry.url === url).length
const esperarDocumentos = async cantidad => {
  for (let espera = 0; espera < 400; espera++) {
    if (documentos().length >= cantidad) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

let fase = 'inicio'
try {
  escenarioEp5()

  fase = 'dbsstart'
  await call('dbsstart', '15')
  const trasStart = {
    seen: leerJson('dbs_seen.json'),
    state: leerJson('dbs_state.json'),
    consultasFicha: consultasFicha(EPISODE_URL),
    mensajes: calls.mensajes.length,
  }

  // dbscheck con el mismo episodio ya registrado: no debe enviar nada.
  fase = 'dbscheck sin novedades'
  await call('dbscheck')
  const sinNovedades = { documentos: documentos().length }

  // Capítulo que aparece DESPUÉS de dbsstart: la portada trae el 6 y la ficha
  // lo ofrece con SUB y LAT. Debe enviarse una sola vez.
  fase = 'episodio nuevo (SUB + LAT)'
  dbs.home.length = 0
  dbs.home.push(homeHtml([[EP6_PATH, 'One Piece', 6, 'Hace 1 minuto']]))
  dbs.series[SERIES_URL] =
    `<div class="thumb"><img src="${coverUrl}" /></div><h1>One Piece</h1>` +
    `<ul class="eplister"><li><a href="${EP6_PATH}">Episodio 6</a></li></ul>`
  dbs.episodes[EP6_URL] = episodioHtml(6, '2024-01-03 03:04:05')
  await call('dbscheck')
  await esperarDocumentos(1)
  await new Promise(resolve => setTimeout(resolve, 200))
  const nuevo = {
    documentos: documentos().map(doc => ({ url: doc.document, nombre: doc.fileName, mimetype: doc.mimetype })),
    portadas: calls.mensajes.filter(msg => msg.image).length,
    caption: calls.mensajes.find(msg => msg.caption)?.caption || null,
    enviados: calls.enviados.length,
    consultasFicha: consultasFicha(EP6_URL),
    compress: calls.compress,
    visto: leerJson('dbs_seen.json')?.[CHAT] || [],
    tempRestante: fs.existsSync(path.join(TMP, 'temp_videos')) ? fs.readdirSync(path.join(TMP, 'temp_videos')) : [],
    descargas: calls.descargas.length,
  }

  // Mismo episodio, otra pasada: nada nuevo.
  fase = 'sin duplicados'
  const mensajesAntes = calls.mensajes.length
  await call('dbscheck')
  await new Promise(resolve => setTimeout(resolve, 400))
  const sinDuplicados = { mensajesNuevos: calls.mensajes.length - mensajesAntes }

  // Ficha caída: el episodio NO debe marcarse como visto (se reintenta luego).
  fase = 'ficha caída (503)'
  dbs.home.length = 0
  dbs.home.push(homeHtml([[EP5_PATH, 'One Piece', 5, 'Hace 5 minutos']]))
  dbs.status[EPISODE_URL] = 503
  dbs.series[SERIES_URL] =
    `<div class="thumb"><img src="${coverUrl}" /></div><h1>One Piece</h1>` +
    `<ul class="eplister"><li><a href="${EP5_PATH}">Episodio 5</a></li></ul>`
  fs.writeFileSync(path.join(TMP, 'database', 'dbs_seen.json'), JSON.stringify({ [CHAT]: ['dbs-marcador-previo-1'] }, null, 2))
  await call('dbscheck')
  const fichaCaida = {
    visto: leerJson('dbs_seen.json')?.[CHAT] || [],
    documentos: documentos().length,
  }

  fase = 'sitio bloqueando (403 en todo)'
  delete dbs.status[EPISODE_URL]
  // El plugin pide la portada sin barra final (ANIMEDBS_URL = '...online').
  dbs.status['https://www.animedbs.online'] = 403
  dbs.status['https://www.animedbs.online/'] = 403
  const mensajesAntes403 = calls.enviados.slice()
  await call('dbsexample', '1')
  const nuevos403 = calls.enviados.slice(mensajesAntes403.length)
  const bloqueo = {
    // El chat debe recibir el aviso accionable, no el texto crudo de axios.
    mensajes: nuevos403,
    ultimoMensaje: nuevos403.at(-1) || null,
  }

  // Con el sitio bloqueando y un capítulo sin ver, el sondeo no debe marcarlo
  // como visto: cuando se arregle el acceso tiene que enviarse.
  dbs.episodes[EPISODE_URL] = episodioHtml(5, '2024-01-02 03:04:05')
  dbs.series[SERIES_URL] =
    `<div class="thumb"><img src="${coverUrl}" /></div><h1>One Piece</h1>` +
    `<ul class="eplister"><li><a href="${EP5_PATH}">Episodio 5</a></li></ul>`
  fs.writeFileSync(path.join(TMP, 'database', 'dbs_seen.json'), JSON.stringify({ [CHAT]: [] }, null, 2))
  await call('dbscheck')
  bloqueo.vistoTrasBloqueo = leerJson('dbs_seen.json')?.[CHAT] || []

  fase = 'dbsstatus'
  delete dbs.status['https://www.animedbs.online']
  delete dbs.status['https://www.animedbs.online/']
  await call('dbsstatus')

  out({
    ok: true,
    trasStart,
    sinNovedades,
    nuevo,
    sinDuplicados,
    fichaCaida,
    bloqueo,
    estado: calls.enviados.at(-1) || null,
    errorLog: calls.error,
  })
} catch (error) {
  out({ ok: false, fase, error: String(error?.stack || error) })
} finally {
  mediaServer.close()
  console.error = originalError
  console.warn = originalWarn
  process.exit(0)
}
