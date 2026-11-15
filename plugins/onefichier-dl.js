import * as cheerio from 'cheerio'
import { createSession } from 'wreq-js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_DOWNLOAD_BYTES = Math.min(4096, Math.max(20, Number(process.env.ONEFICHIER_MAX_MB) || 4096)) * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = Math.max(60_000, Number(process.env.ONEFICHIER_TIMEOUT_MS) || 60 * 60_000)
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MIN_VALID_BYTES = 32 * 1024
const TEMP_ROOT = path.resolve(process.env.ONEFICHIER_TEMP_DIR || path.join(os.tmpdir(), 'rikka-1fichier'))

function allowedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '')
  return host === '1fichier.com' || host.endsWith('.1fichier.com')
}

export function parseOneFichierUrl(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch (_) {
    throw new Error('El enlace no es una URL válida de 1fichier.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !allowedHost(url.hostname)) {
    throw new Error('Solo acepto enlaces de 1fichier.com.')
  }
  return url.href
}

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  return hours ? `${hours}h ${minutes}m ${secs}s` : `${minutes}m ${secs}s`
}

async function waitWithProgress(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  if (!total) return
  console.log(`[1FICHIER] Esperando ${total}s, tal como pide el servidor.`)
  let lastLogged = 0
  for (let elapsed = 1; elapsed <= total; elapsed += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const percent = Math.floor(elapsed / total * 100)
    if (process.stdout.isTTY) {
      const width = 22
      const filled = Math.round(width * elapsed / total)
      const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
      process.stdout.write(`\r[1FICHIER] Espera [${bar}] ${String(percent).padStart(3)}% · ${total - elapsed}s restantes   `)
      if (elapsed === total) process.stdout.write('\n')
    } else if (elapsed === total || elapsed - lastLogged >= 10) {
      console.log(`[1FICHIER] Espera ${elapsed}/${total}s (${percent}%)`)
      lastLogged = elapsed
    }
  }
}

function cleanFilename(value, fallback) {
  const decoded = String(value || '').replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_m, hex, dec) => String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10)))
  const safe = path.basename(decoded).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[\r\n]/g, '').trim().slice(0, 180)
  return safe || fallback
}

function getHeader(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) || ''
  return headers?.[name.toLowerCase()] || ''
}

async function readLimitedHtml(stream) {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (total > MAX_HTML_BYTES) {
      stream.destroy()
      throw new Error('La página de 1fichier supera el tamaño máximo permitido para analizarla.')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function findWaitSeconds(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ')
  const scriptTimer = normalized.match(/\bvar\s+ct\s*=\s*(\d{1,3})\b/i)
  if (scriptTimer) return Math.min(Number(scriptTimer[1]), 600)
  const patterns = [
    /(?:please\s+)?wait\s+(\d{1,3})\s*(?:seconds?|secs?)/i,
    /(?:attendez|espera|espere)\s+(\d{1,3})\s*(?:secondes?|segundos?|s)\b/i,
    /(?:wait|attendre|esperar)[^\d]{0,35}(\d{1,3})\s*(?:s|sec|seconds?|segundos?)/i,
  ]
  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match) return Math.min(Number(match[1]), 600)
  }
  return 0
}

function detectCaptcha(html) {
  const $ = cheerio.load(html)
  if ($('[name*="captcha" i], [id*="captcha" i], .g-recaptcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], [data-sitekey]').length) return true
  return /recaptcha\/api|hcaptcha\.com|cf-turnstile|g-recaptcha-response|verify you are human/i.test(html)
}

function getDownloadForm(html, baseUrl) {
  const $ = cheerio.load(html)
  for (const element of $('form').toArray()) {
    const form = $(element)
    const action = form.attr('action') || baseUrl
    let actionUrl
    try { actionUrl = new URL(action, baseUrl) } catch (_) { continue }
    if (!['https:', 'http:'].includes(actionUrl.protocol) || !allowedHost(actionUrl.hostname)) continue
    const fields = new URLSearchParams()
    form.find('input[name], select[name], textarea[name]').each((_, field) => {
      const item = $(field)
      const type = String(item.attr('type') || '').toLowerCase()
      if (['submit', 'button', 'file', 'reset'].includes(type)) return
      if (['checkbox', 'radio'].includes(type) && !item.is(':checked')) return
      fields.append(item.attr('name'), item.val() || '')
    })
    const submit = form.find('button[type="submit"], input[type="submit"]').first()
    if (submit.attr('name')) fields.append(submit.attr('name'), submit.val() || submit.text().trim() || '')
    return { url: actionUrl.href, method: String(form.attr('method') || 'GET').toUpperCase(), fields }
  }
  return null
}

function findDirectDownloadLink(html, baseUrl) {
  const $ = cheerio.load(html)
  for (const element of $('a[href]').toArray()) {
    const anchor = $(element)
    const label = `${anchor.text()} ${anchor.attr('title') || ''}`.toLowerCase()
    const href = anchor.attr('href') || ''
    if (anchor.closest('form').length) continue
    const isDownloadAction = /^(?:download|free download|descargar|descarga|télécharger|telecharger|click here to download)\b/i.test(label.trim())
    if (!isDownloadAction && !/\/dl\//i.test(href)) continue
    try {
      const url = new URL(href, baseUrl)
      if (allowedHost(url.hostname) && url.href !== baseUrl) return url.href
    } catch (_) {}
  }
  return null
}

function isHtmlResponse(response) {
  return /text\/html|application\/xhtml\+xml/i.test(getHeader(response.headers, 'content-type'))
}

async function requestStream(url, session, referer, method = 'GET', fields = null) {
  const headers = { Accept: '*/*', Referer: referer || 'https://1fichier.com/' }
  if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded'
  let requestUrl = url
  if (method === 'GET' && fields?.size) {
    const target = new URL(url)
    for (const [key, value] of fields) target.searchParams.append(key, value)
    requestUrl = target.href
  }
  const upstream = await session.fetch(requestUrl, {
    method,
    body: method === 'POST' ? fields : undefined,
    headers,
    timeout: method === 'GET' ? 30_000 : DOWNLOAD_TIMEOUT_MS,
    redirect: 'follow',
  })
  const finalUrl = upstream.url || requestUrl
  if (!allowedHost(new URL(finalUrl).hostname)) {
    await upstream.body?.cancel().catch(() => {})
    throw new Error('1fichier redirigió a un dominio no permitido.')
  }
  if (!upstream.body) throw new Error('1fichier devolvió una respuesta vacía.')
  const response = {
    status: upstream.status,
    headers: upstream.headers,
    data: Readable.fromWeb(upstream.body),
  }
  return { response, finalUrl }
}

async function getDownloadStream(inputUrl, session) {
  let currentUrl = inputUrl
  let referer = 'https://1fichier.com/'
  for (let step = 0; step < 5; step++) {
    const { response, finalUrl } = await requestStream(currentUrl, session, referer)
    if (!isHtmlResponse(response)) {
      if (response.status < 200 || response.status >= 400) {
        response.data.destroy()
        throw new Error(`1fichier respondió con HTTP ${response.status}.`)
      }
      return { response, finalUrl }
    }

    const html = await readLimitedHtml(response.data)
    const $ = cheerio.load(html)
    const text = $.text()
    if (detectCaptcha(html)) {
      throw new Error('1fichier solicita CAPTCHA o verificación humana. El plugin no la resuelve; completa la verificación manualmente en el navegador.')
    }
    if (/unusual usage detected|download limit|too many downloads|ip.{0,20}blocked|trafic.{0,20}limite|limite.{0,20}telechargement/i.test(text)) {
      throw new Error('1fichier bloque o limitó esta descarga para la conexión actual. Espera o revisa tu cuenta/estado en 1fichier.')
    }
    if (/password.{0,20}(required|incorrect)|mot de passe.{0,20}(requis|incorrect)|contraseña.{0,20}(requerida|incorrecta)/i.test(text)) {
      throw new Error('El enlace de 1fichier requiere una contraseña que este plugin no puede solicitar todavía.')
    }

    const waitSeconds = findWaitSeconds(html)
    if (waitSeconds > 0) {
    if (waitSeconds > 180) throw new Error(`1fichier solicita esperar ${waitSeconds} segundos; supera el máximo automático de 180 segundos.`)
      await waitWithProgress(waitSeconds)
    }

    const form = getDownloadForm(html, finalUrl)
    if (form) {
      if (form.fields.toString().toLowerCase().includes('captcha')) {
        throw new Error('El formulario de 1fichier requiere CAPTCHA. Complétalo manualmente en el navegador; el plugin no lo evade.')
      }
      console.log(`[1FICHIER] Enviando el formulario de descarga permitido (${form.method})…`)
      const next = await requestStream(form.url, session, finalUrl, form.method, form.fields)
      if (!isHtmlResponse(next.response)) return next
      const returnedHtml = await readLimitedHtml(next.response.data)
      if (detectCaptcha(returnedHtml)) throw new Error('1fichier pidió CAPTCHA al procesar el formulario. Completa la verificación manualmente.')
      const returnedLink = findDirectDownloadLink(returnedHtml, next.finalUrl)
      if (returnedLink) {
        referer = next.finalUrl
        currentUrl = returnedLink
        continue
      }
      throw new Error('1fichier devolvió otra página HTML en lugar del archivo; puede requerir verificación manual.')
    }

    const direct = findDirectDownloadLink(html, finalUrl)
    if (direct) {
      console.log(`[1FICHIER] Enlace de descarga encontrado en ${new URL(direct).hostname}.`)
      referer = finalUrl
      currentUrl = direct
      continue
    }
    const title = $('title').text().replace(/\s+/g, ' ').trim()
    const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 220)
    throw new Error(`La respuesta de 1fichier no contiene un formulario de descarga reconocible (${title || excerpt || 'página sin texto visible'}).`)
  }
  throw new Error('Se alcanzó el límite de pasos al resolver la descarga de 1fichier.')
}

function contentDispositionFilename(header) {
  const value = String(header || '')
  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1]
  if (encoded) { try { return decodeURIComponent(encoded.replace(/^"|"$/g, '')) } catch (_) {} }
  return value.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1] || ''
}

async function saveFile(response, outputPath) {
  const expected = Number(getHeader(response.headers, 'content-length') || 0)
  if (expected > MAX_DOWNLOAD_BYTES) {
    response.data.destroy()
    throw new Error(`El archivo supera el límite configurado de ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB.`)
  }
  const startedAt = Date.now()
  let bytes = 0
  let lastRenderAt = 0
  let lastLoggedAt = startedAt
  let nextLogAt = 16 * 1024 * 1024
  const render = (force = false) => {
    const now = Date.now()
    const elapsed = Math.max((now - startedAt) / 1000, 0.001)
    const speed = bytes / elapsed
    const pct = expected ? Math.min(100, bytes / expected * 100) : null
    if (process.stdout.isTTY) {
      if (!force && now - lastRenderAt < 1000) return
      lastRenderAt = now
      const width = 22
      const done = pct == null ? 0 : Math.round(width * pct / 100)
      const bar = `${'█'.repeat(done)}${'░'.repeat(width - done)}`
      const percent = pct == null ? '  --.-%' : `${pct.toFixed(1).padStart(5)}%`
      process.stdout.write(`\r[1FICHIER] [${bar}] ${percent} | ${formatBytes(bytes)}${expected ? ` / ${formatBytes(expected)}` : ''} | ${formatBytes(speed)}/s | ${formatDuration(elapsed)}   `)
    } else if (force || now - lastLoggedAt >= 10_000 || bytes >= nextLogAt) {
      console.log(`[1FICHIER] ${pct == null ? 'porcentaje n/d' : `${pct.toFixed(1)}%`} · ${formatBytes(bytes)}${expected ? ` / ${formatBytes(expected)}` : ''} · ${formatBytes(speed)}/s · ${formatDuration(elapsed)}`)
      lastLoggedAt = now
      while (bytes >= nextLogAt) nextLogAt += 16 * 1024 * 1024
    }
  }
  console.log(`[1FICHIER] Descargando · tamaño esperado: ${expected ? formatBytes(expected) : 'desconocido'}`)
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > MAX_DOWNLOAD_BYTES) callback(new Error(`El archivo supera el límite configurado de ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB.`))
      else { render(); callback(null, chunk) }
    },
  })
  try {
    await pipeline(response.data, limiter, fs.createWriteStream(outputPath, { flags: 'wx' }))
  } catch (error) {
    if (process.stdout.isTTY) process.stdout.write('\n')
    await fs.promises.rm(outputPath, { force: true })
    throw error
  }
  render(true)
  if (process.stdout.isTTY) process.stdout.write('\n')
  const stat = await fs.promises.stat(outputPath)
  if (stat.size < MIN_VALID_BYTES) {
    await fs.promises.rm(outputPath, { force: true })
    throw new Error('El archivo descargado es demasiado pequeño o está incompleto.')
  }
  console.log(`[1FICHIER] Descarga completa · ${formatBytes(stat.size)} · ${formatDuration((Date.now() - startedAt) / 1000)}`)
  return stat
}

function getInput(m, text, args) {
  const quoted = m.quoted?.text || m.quoted?.caption || ''
  const value = String(text || args?.[0] || quoted || '').match(/https?:\/\/[^\s<>]+/i)?.[0] || ''
  return value.replace(/[),.!?;:'"\]}>]+$/g, '')
}

const handler = async (m, { conn, text, args, usedPrefix, command }) => {
  const input = getInput(m, text, args)
  if (!input) return m.reply(`Envía o responde a un enlace de 1fichier.\nEjemplo: *${usedPrefix || '.'}${command || '1fichier'} https://1fichier.com/?ID*`)
  let url
  try { url = parseOneFichierUrl(input) } catch (error) { return m.reply(`❌ ${error.message}`) }

  if (!global.oneFichierActiveDownloads) global.oneFichierActiveDownloads = new Set()
  const lock = `${m.chat}:${m.sender}`
  if (global.oneFichierActiveDownloads.has(lock)) return m.reply('⏳ Ya tienes una descarga de 1fichier activa en este chat.')
  global.oneFichierActiveDownloads.add(lock)

  const tempDir = path.join(TEMP_ROOT, randomUUID())
  let outputPath = ''
  let statusKey = null
  let session = null
  const update = async text => {
    if (statusKey) { try { await conn.sendMessage(m.chat, { text, edit: statusKey }) } catch (_) {} }
  }
  try {
    await fs.promises.mkdir(tempDir, { recursive: true })
    const sent = await conn.sendMessage(m.chat, { text: '🔎 Resolviendo enlace de 1fichier…' }, { quoted: m })
    statusKey = sent?.key || null
    console.log(`[1FICHIER] Inicio · host=${new URL(url).hostname}`)
    session = await createSession({ browser: 'chrome_149', os: 'windows', timeout: 30_000 })
    const { response, finalUrl } = await getDownloadStream(url, session)
    const contentType = getHeader(response.headers, 'content-type').toLowerCase()
    if (/text\/html|application\/json|javascript/i.test(contentType)) {
      response.data.destroy()
      throw new Error('1fichier no devolvió un archivo descargable.')
    }
    const filename = cleanFilename(contentDispositionFilename(getHeader(response.headers, 'content-disposition')), `1fichier-${Date.now()}.bin`)
    outputPath = path.join(tempDir, filename)
    await update('⬇️ Descargando desde 1fichier…')
    const stat = await saveFile(response, outputPath)
    const size = formatBytes(stat.size)
    await conn.sendMessage(m.chat, {
      document: { url: outputPath },
      fileName: filename,
      mimetype: contentType || 'application/octet-stream',
      caption: `✅ Descarga de 1fichier completada\n📦 Tamaño: ${size}`,
    }, { quoted: m })
    console.log(`[1FICHIER] Enviado · ${filename} · ${size} · host=${new URL(finalUrl).hostname}`)
    await update(`✅ Enviado: ${filename} · ${size}`)
  } catch (error) {
    console.error(`[1FICHIER] Error · ${error?.message || error}`)
    const message = `❌ ${String(error?.message || 'Falló la descarga de 1fichier.').slice(0, 500)}`
    if (statusKey) await update(message)
    else await m.reply(message)
  } finally {
    if (session) await session.close().catch(() => {})
    global.oneFichierActiveDownloads.delete(lock)
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

handler.help = ['1fichier <enlace>']
handler.tags = ['downloader']
handler.command = /^(1fichier|fichier|onefichier)$/i
handler.limit = false

export default handler
