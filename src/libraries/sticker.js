import { dirname }            from 'path'
import { fileURLToPath }      from 'url'
import { Buffer }             from 'buffer'
import * as fs                from 'fs'
import * as path              from 'path'
import * as crypto            from 'crypto'
import { ffmpeg }             from './converter.js'
import fluent_ffmpeg           from 'fluent-ffmpeg'
import { spawn }              from 'child_process'
import uploadFile             from './uploadFile.js'
import { fileTypeFromBuffer } from 'file-type'
import webp                   from 'node-webpmux'
import fetch                  from 'node-fetch'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpDir    = path.join(__dirname, '../tmp')

async function ensureTmpDir() {
  await fs.promises.mkdir(tmpDir, { recursive: true })
}

async function cleanUp(...files) {
  for (const f of files) {
    if (!f) continue
    await fs.promises.unlink(f).catch(() => {})
  }
}

function toBuffer(input) {
  if (Buffer.isBuffer(input))                           return input
  if (input instanceof Uint8Array || ArrayBuffer.isView(input))
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (input instanceof ArrayBuffer)                     return Buffer.from(input)
  if (typeof input === 'string') {
    if (fs.existsSync(input))                           return fs.readFileSync(input)
    return Buffer.from(input)
  }
  if (input && typeof input === 'object' && input.data) return toBuffer(input.data)
  throw new TypeError(`No se puede convertir a Buffer: ${typeof input}`)
}

function sticker2(img, url) {
  return new Promise(async (resolve, reject) => {
    let inp
    try {
      if (url) {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
        img = await res.buffer()
      }
      await ensureTmpDir()
      inp = path.join(tmpDir, `${Date.now()}.jpeg`)
      await fs.promises.writeFile(inp, img)

      const ff = spawn('ffmpeg', [
        '-y', '-i', inp,
        '-vf', 'scale=512:512:flags=lanczos:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1',
        '-f', 'png', '-'
      ])
      ff.on('error', async (e) => { await cleanUp(inp); reject(e) })
      ff.on('close',  async () => { await cleanUp(inp) })

      const conversor = support.gm ? 'gm' : support.magick ? 'magick' : null
      const imArgs    = conversor
        ? [conversor, 'convert', 'png:-', 'webp:-']
        : ['convert', 'png:-', 'webp:-']
      const [_bin, ..._args] = imArgs

      const im   = spawn(_bin, _args)
      const bufs = []
      im.on('error',  async (e) => { await cleanUp(inp); reject(e) })
      im.stdout.on('data', chunk => bufs.push(chunk))
      ff.stdout.pipe(im.stdin)
      im.on('exit', () => resolve(Buffer.concat(bufs)))
    } catch (e) {
      await cleanUp(inp)
      reject(e)
    }
  })
}

async function sticker3(img, url, packname, author) {
  const uploadUrl = url || (await uploadFile(img))
  const res = await fetch(
    'https://api.xteam.xyz/sticker/wm?' +
    new URLSearchParams({ url: uploadUrl, packname, author })
  )
  if (!res.ok) throw new Error(`API xteam HTTP ${res.status}`)
  const buf = await res.buffer()
  if (buf.includes('html')) throw new Error('API xteam devolvió HTML')
  return buf
}

async function sticker4(img, url) {
  if (url) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    img = await res.buffer()
  }
  if (!img) throw new Error('sticker4: img está vacío')
  const raw = await ffmpeg(img, [
    '-vf', 'scale=512:512:flags=lanczos:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000,setsar=1'
  ], 'jpeg', 'webp')
  return toBuffer(raw)
}

async function sticker5(img, url, packname, author, categories = [''], extra = {}) {
  const { Sticker } = await import('wa-sticker-formatter')
  const metadata = { type: 'default', pack: packname, author, categories, ...extra }
  const buf = await (new Sticker(img ?? url, metadata)).toBuffer()
  return toBuffer(buf)
}

function sticker6(img, url) {
  return new Promise(async (resolve, reject) => {
    let tmpFile, outFile
    try {
      if (url) {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        img = await res.buffer()
      }
      if (!img) throw new Error('sticker6: img está vacío')

      const type = await fileTypeFromBuffer(img) || { mime: 'application/octet-stream', ext: 'bin' }
      if (type.ext === 'bin') throw new Error('sticker6: tipo de archivo no reconocido')

      await ensureTmpDir()
      tmpFile = path.join(tmpDir, `${Date.now()}.${type.ext}`)
      outFile = `${tmpFile}.webp`
      await fs.promises.writeFile(tmpFile, img)

      const proc = /video/i.test(type.mime)
        ? fluent_ffmpeg(tmpFile).inputFormat(type.ext)
        : fluent_ffmpeg(tmpFile).input(tmpFile)

      proc
        .on('error', async (err) => {
          await cleanUp(tmpFile, outFile)
          reject(err)
        })
        .on('end', async () => {
          try {
            const result = await fs.promises.readFile(outFile)
            resolve(result)
          } catch (e) {
            reject(e)
          } finally {
            await cleanUp(tmpFile, outFile)
          }
        })
        .addOutputOptions([
          '-vcodec', 'libwebp',
          '-vf', [
            "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease",
            'fps=15',
            'pad=320:320:-1:-1:color=white@0.0',
            'split [a][b]',
            '[a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]',
            '[b][p] paletteuse'
          ].join(', ')
        ])
        .toFormat('webp')
        .save(outFile)
    } catch (e) {
      await cleanUp(tmpFile, outFile)
      reject(e)
    }
  })
}

async function addExif(webpSticker, packname, author, categories = [''], metadata = {}) {
  if (!webpSticker || !Buffer.isBuffer(webpSticker)) {
    throw new TypeError('addExif: webpSticker debe ser un Buffer')
  }

  const img           = new webp.Image()
  const stickerPackId = `MYSTIC${crypto.randomBytes(12).toString('hex').toUpperCase()}`

  const jsonData = Object.fromEntries(
    Object.entries({
      'sticker-pack-id':            metadata.packId              ?? stickerPackId,
      'sticker-pack-name':          packname                     || undefined,
      'sticker-pack-publisher':     author                       || undefined,
      'android-app-store-link':     metadata.androidAppStoreLink ?? undefined,
      'ios-app-store-link':         metadata.iosAppStoreLink     ?? undefined,
      'is-ai-sticker':              metadata.isAiSticker         ? 1 : undefined,
      'is-first-party-sticker':     metadata.isFirstPartySticker ? 1 : undefined,
      'accessibility-text':         metadata.accessibilityText   ?? undefined,
      'avatar-sticker-template-id': metadata.templateId          ?? undefined,
      'is-avatar-sticker':          metadata.isAvatarSticker     ? 1 : undefined,
      'sticker-maker-source-type':  metadata.stickerMakerSourceType ?? undefined,
      'emojis':                     categories?.length           ? categories : undefined,
    }).filter(([, v]) => v !== undefined)
  )

  const exifAttr   = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ])
  const jsonBuffer  = Buffer.from(JSON.stringify(jsonData), 'utf8')
  const exif        = Buffer.concat([exifAttr, jsonBuffer])
  exif.writeUIntLE(jsonBuffer.length, 14, 4)

  await img.load(webpSticker)
  img.exif = exif
  return await img.save(null)
}

async function sticker(img, url, packname = '', author = '', categories = [''], extra = {}) {
  const args    = [packname, author, categories, extra]
  const methods = [
    support.ffmpeg && sticker6,
    sticker5,
    support.ffmpeg && support.ffmpegWebp && sticker4,
    support.ffmpeg && (support.convert || support.magick || support.gm) && sticker2,
    sticker3,
  ].filter(Boolean)

  let lastError
  for (const fn of methods) {
    try {
      let result = await fn(img, url, ...args)
      result = toBuffer(result)

      if (!result.slice(0, 4).equals(Buffer.from('RIFF')) &&
          !result.slice(8, 12).equals(Buffer.from('WEBP'))) {
        throw new Error(`${fn.name} no devolvió un WebP válido`)
      }

      try {
        return await addExif(result, packname, author, categories, extra)
      } catch {
        return result
      }
    } catch (err) {
      lastError = err
    }
  }

  throw lastError ?? new Error('Todos los métodos de conversión fallaron')
}

const support = {
  ffmpeg:     true,
  ffprobe:    true,
  ffmpegWebp: true,
  convert:    true,
  magick:     false,
  gm:         false,
  find:       false,
}

global.support = support

export {
  sticker,
  sticker2,
  sticker3,
  sticker4,
  sticker5,
  sticker6,
  addExif,
  support,
  toBuffer,
        }
    
