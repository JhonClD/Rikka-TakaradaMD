import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fromRoot } from '../funcion/paths.js'

export class AniDLError extends Error {
  constructor(message, code = 'INVALID_INPUT') {
    super(message)
    this.name = 'AniDLError'
    this.code = code
  }
}

export const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.avi',
  '.mov',
  '.m4v',
])

const EPISODE_ID_RE = /^[A-Za-z0-9_-]{3,80}$/
const EPISODE_SELECTION_RE = /^(?:S?\d{1,4}(?:-S?\d{1,4})?)(?:,S?\d{1,4}(?:-S?\d{1,4})?)*$/i
const CRUNCHYROLL_URL_FINDER_RE = /https?:\/\/(?:[\w-]+\.)*crunchyroll\.com\/[^\s<>"'`]+/i

// Tabla canónica alineada con modules/module.langsData.ts de multi-downloader-nx (aniDL).
const LANGUAGE_ENTRIES = [
  { dub: 'jpn', sub: 'ja', label: 'Japonés 🇯🇵', aliases: ['jpn', 'ja', 'ja-jp', 'jp', 'jap', 'japones', 'japonés'] },
  { dub: 'spa-419', sub: 'es-419', label: 'Español Latino 🇲🇽', aliases: ['spa-419', 'es-419', 'es-la', 'es-mx', 'lat', 'latino', 'latam'] },
  { dub: 'spa', sub: 'es-419', label: 'Español 🌎', aliases: ['spa', 'es'] },
  { dub: 'spa-ES', sub: 'es-ES', label: 'Español Castellano 🇪🇸', aliases: ['spa-es', 'es-es', 'cast', 'castellano'] },
  { dub: 'eng', sub: 'en', label: 'Inglés 🇺🇸', aliases: ['eng', 'en', 'en-us', 'ingles', 'inglés'] },
  { dub: 'eng', sub: 'en-IN', label: 'Inglés (India) 🇮🇳', aliases: ['en-in'] },
  { dub: 'por', sub: 'pt-BR', label: 'Portugués (Brasil) 🇧🇷', aliases: ['por', 'pt', 'pt-br', 'br'] },
  { dub: 'por', sub: 'pt-PT', label: 'Portugués (Portugal) 🇵🇹', aliases: ['pt-pt'] },
  { dub: 'fra', sub: 'fr', label: 'Francés 🇫🇷', aliases: ['fra', 'fr', 'fr-fr'] },
  { dub: 'deu', sub: 'de', label: 'Alemán 🇩🇪', aliases: ['deu', 'de', 'de-de'] },
  { dub: 'ita', sub: 'it', label: 'Italiano 🇮🇹', aliases: ['ita', 'it', 'it-it'] },
  { dub: 'rus', sub: 'ru', label: 'Ruso 🇷🇺', aliases: ['rus', 'ru', 'ru-ru'] },
  { dub: 'ara-ME', sub: 'ar', label: 'Árabe (ME) 🇸🇦', aliases: ['ara-me', 'ar-me'] },
  { dub: 'ara', sub: 'ar', label: 'Árabe 🇸🇦', aliases: ['ara', 'ar', 'ar-sa'] },
  { dub: 'tur', sub: 'tr', label: 'Turco 🇹🇷', aliases: ['tur', 'tr', 'tr-tr'] },
  { dub: 'hin', sub: 'hi', label: 'Hindi 🇮🇳', aliases: ['hin', 'hi', 'hi-in'] },
  { dub: 'cmn', sub: 'zh', label: 'Chino Mandarín 🇨🇳', aliases: ['cmn', 'zh'] },
  { dub: 'zho', sub: 'zh-CN', label: 'Chino Simplificado 🇨🇳', aliases: ['zho', 'zh-cn'] },
  { dub: 'chi', sub: 'zh-TW', label: 'Chino Tradicional 🇹🇼', aliases: ['chi', 'zh-tw'] },
  { dub: 'zh-HK', sub: 'zh-HK', label: 'Chino (Hong Kong) 🇭🇰', aliases: ['zh-hk'] },
  { dub: 'kor', sub: 'ko', label: 'Coreano 🇰🇷', aliases: ['kor', 'ko', 'ko-kr'] },
  { dub: 'cat', sub: 'ca-ES', label: 'Catalán', aliases: ['cat', 'ca', 'ca-es'] },
  { dub: 'pol', sub: 'pl-PL', label: 'Polaco 🇵🇱', aliases: ['pol', 'pl', 'pl-pl'] },
  { dub: 'tha', sub: 'th-TH', label: 'Tailandés 🇹🇭', aliases: ['tha', 'th', 'th-th'] },
  { dub: 'tam', sub: 'ta-IN', label: 'Tamil 🇮🇳', aliases: ['tam', 'ta', 'ta-in'] },
  { dub: 'may', sub: 'ms-MY', label: 'Malayo 🇲🇾', aliases: ['may', 'ms', 'ms-my'] },
  { dub: 'vie', sub: 'vi-VN', label: 'Vietnamita 🇻🇳', aliases: ['vie', 'vi', 'vi-vn'] },
  { dub: 'ind', sub: 'id-ID', label: 'Indonesio 🇮🇩', aliases: ['ind', 'id', 'id-id'] },
  { dub: 'tel', sub: 'te-IN', label: 'Telugu 🇮🇳', aliases: ['tel', 'te', 'te-in'] },
  { dub: 'und', sub: 'un', label: 'Indeterminado', aliases: ['und', 'un'] },
]

const ALIAS_MAP = new Map()
for (const entry of LANGUAGE_ENTRIES) {
  for (const alias of entry.aliases) {
    if (!ALIAS_MAP.has(alias)) ALIAS_MAP.set(alias, entry)
  }
}

export const DUB_LANGUAGES = new Set(LANGUAGE_ENTRIES.map((e) => e.dub))
export const SUB_LANGUAGES = new Set(LANGUAGE_ENTRIES.map((e) => e.sub))

const QUALITY_ALIASES = new Map([
  ['0', 0],
  ['max', 0],
  ['best', 0],
  ['fhd', 0],
  ['1080', 0],
  ['1080p', 0],
  ['1', 1],
  ['240', 1],
  ['240p', 1],
  ['2', 2],
  ['360', 2],
  ['360p', 2],
  ['3', 3],
  ['480', 3],
  ['480p', 3],
  ['4', 4],
  ['720', 4],
  ['720p', 4],
  ['5', 5],
])

export function normalizeDubLanguage(code) {
  const key = String(code || '').trim().toLowerCase()
  const entry = ALIAS_MAP.get(key)
  if (!entry) {
    throw new AniDLError(`El código de idioma de audio "${String(code).slice(0, 24)}" no está admitido por AniDL.`)
  }
  return entry.dub
}

export function normalizeSubLanguage(code, { allowAll = false, allowNone = false } = {}) {
  const key = String(code || '').trim().toLowerCase()
  if (allowAll && (key === 'all' || key === 'todos')) return 'all'
  if (allowNone && (key === 'none' || key === 'ninguno' || key === 'off' || key === 'no')) return 'none'
  const entry = ALIAS_MAP.get(key)
  if (!entry) {
    throw new AniDLError(`El código de subtítulos "${String(code).slice(0, 24)}" no está admitido por AniDL.`)
  }
  return entry.sub
}

export function describeLanguage(code) {
  const key = String(code || '').trim().toLowerCase()
  if (key === 'all') return 'Todos'
  if (key === 'none') return 'Ninguno'
  const entry = ALIAS_MAP.get(key)
  return entry ? `${entry.label} (${code})` : String(code)
}

export function describeQuality(quality) {
  switch (Number(quality)) {
    case 0: return 'Máxima (1080p)'
    case 1: return 'Nivel 1 (~240p)'
    case 2: return 'Nivel 2 (~360p)'
    case 3: return 'Nivel 3 (~480p)'
    case 4: return 'Nivel 4 (~720p)'
    case 5: return 'Nivel 5 (~1080p)'
    default: return `Nivel ${quality}`
  }
}

/**
 * Extrae el primer enlace de Crunchyroll presente en un texto libre o mensaje citado.
 */
export function extractCrunchyrollUrl(text) {
  const raw = String(text || '')
  const match = raw.match(CRUNCHYROLL_URL_FINDER_RE)
  if (!match) return null
  return match[0].replace(/[),.;!?\]}>]+$/, '')
}

/**
 * Valida y analiza un enlace HTTPS oficial de Crunchyroll (/watch/ID o /series/ID).
 */
export function extractCrunchyrollTarget(rawUrl) {
  const trimmed = String(rawUrl || '').trim()
  if (!trimmed) throw new AniDLError('Debes indicar un enlace de Crunchyroll.')

  // Rechazar credenciales o puertos explícitos antes de que URL normalice puertos por defecto (:443).
  const authorityMatch = trimmed.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/)
  if (authorityMatch && (/[@:]/.test(authorityMatch[1]))) {
    throw new AniDLError('El enlace contiene una autoridad no admitida.')
  }

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new AniDLError('El enlace no es válido.')
  }

  const host = (parsed.hostname || '').toLowerCase().replace(/\.$/, '')
  const isCrunchyHost = host === 'crunchyroll.com' || host.endsWith('.crunchyroll.com')
  if (parsed.protocol !== 'https:' || !isCrunchyHost) {
    throw new AniDLError('Se requiere un enlace HTTPS de crunchyroll.com.')
  }
  if (parsed.username || parsed.password || parsed.port) {
    throw new AniDLError('El enlace contiene una autoridad no admitida.')
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  const watchIdx = segments.indexOf('watch')
  if (watchIdx !== -1) {
    const episodeId = segments[watchIdx + 1]
    if (!episodeId) {
      throw new AniDLError('El enlace debe apuntar a /watch/ID_DEL_EPISODIO.')
    }
    if (!EPISODE_ID_RE.test(episodeId)) {
      throw new AniDLError('El identificador del episodio no tiene un formato admitido.')
    }
    return {
      kind: 'episode',
      id: episodeId,
      slug: segments[watchIdx + 2] || '',
      url: parsed.toString(),
    }
  }

  const seriesIdx = segments.indexOf('series')
  if (seriesIdx !== -1) {
    const seriesId = segments[seriesIdx + 1]
    if (!seriesId) {
      throw new AniDLError('El enlace de serie debe apuntar a /series/ID_DE_LA_SERIE.')
    }
    if (!EPISODE_ID_RE.test(seriesId)) {
      throw new AniDLError('El identificador de la serie no tiene un formato admitido.')
    }
    return {
      kind: 'series',
      id: seriesId,
      slug: segments[seriesIdx + 2] || '',
      url: parsed.toString(),
    }
  }

  throw new AniDLError('El enlace debe apuntar a /watch/ID_DEL_EPISODIO (o /series/ID con -e EPISODIO).')
}

/**
 * Extrae el ID de episodio desde un enlace /watch/ID de Crunchyroll (compatible con anidl.py).
 */
export function extractEpisodeId(url) {
  const target = extractCrunchyrollTarget(url)
  if (target.kind !== 'episode') {
    throw new AniDLError('El enlace debe apuntar a /watch/ID_DEL_EPISODIO.')
  }
  return target.id
}

/**
 * Tokenizador estilo POSIX (equivalente seguro a shlex.split) sin invocar shell.
 */
export function tokenizeOptions(text) {
  const input = String(text || '').trim()
  if (!input) return []

  const tokens = []
  let current = ''
  let quote = null
  let tokenStarted = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      continue
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (ch === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) {
        current += input[++i]
      } else {
        current += ch
      }
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      tokenStarted = true
      continue
    }

    if (ch === '\\') {
      if (i + 1 >= input.length) {
        throw new AniDLError('No pude interpretar las opciones: barra invertida final sin carácter.')
      }
      current += input[++i]
      tokenStarted = true
      continue
    }

    if (/\s/.test(ch)) {
      if (tokenStarted) {
        tokens.push(current)
        current = ''
        tokenStarted = false
      }
      continue
    }

    current += ch
    tokenStarted = true
  }

  if (quote !== null) {
    throw new AniDLError('No pude interpretar las opciones del comando (comillas sin cerrar).')
  }
  if (tokenStarted) tokens.push(current)
  return tokens
}

function parseQualityValue(rawValue) {
  const key = String(rawValue ?? '').trim().toLowerCase()
  if (QUALITY_ALIASES.has(key)) return QUALITY_ALIASES.get(key)
  throw new AniDLError('La calidad debe ser 0 (máxima), un número del 1 al 5, o 240p/360p/480p/720p/1080p.')
}

const VALUE_OPTIONS = new Map([
  ['--dublang', '--dubLang'],
  ['--dub', '--dubLang'],
  ['--audio', '--dubLang'],
  ['--dlsubs', '--dlsubs'],
  ['--subs', '--dlsubs'],
  ['--hslang', '--hslang'],
  ['--hardsub', '--hslang'],
  ['--hs', '--hslang'],
  ['-q', '-q'],
  ['--quality', '-q'],
  ['-e', '-e'],
  ['--episode', '-e'],
  ['--partsize', '--partsize'],
  ['--defaultaudio', '--defaultAudio'],
  ['--defaultsub', '--defaultSub'],
])

const BOOLEAN_FLAGS = new Map([
  ['--mp4', 'mp4'],
  ['--mkv', 'mkv'],
  ['--dlfonts', 'dlFonts'],
  ['--fonts', 'dlFonts'],
  ['--tsd', 'tsd'],
  ['--doc', 'doc'],
  ['--document', 'doc'],
  ['--clean', 'cleanup'],
  ['--cleanup', 'cleanup'],
])

/**
 * Interpreta tanto las banderas clásicas de aniDL como atajos rápidos de chat.
 */
export function parseOptions(text = '', defaults = {}) {
  const tokens = Array.isArray(text) ? [...text] : tokenizeOptions(text)
  const values = new Map()
  let fallbackSubs = null
  let container = null
  let dlFonts = Boolean(defaults.dlFonts)
  let tsd = Boolean(defaults.tsd)
  let forceDocument = Boolean(defaults.forceDocument)
  let cleanup = defaults.cleanup ?? null

  const setOnce = (canonical, value, display) => {
    if (values.has(canonical)) {
      throw new AniDLError(`La opción ${display || canonical} no se puede repetir.`)
    }
    values.set(canonical, value)
  }

  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    const lower = token.toLowerCase()

    // Banderas booleanas (--mp4, --mkv, --dlFonts, --tsd, --doc, --cleanup)
    if (BOOLEAN_FLAGS.has(lower)) {
      const kind = BOOLEAN_FLAGS.get(lower)
      if (kind === 'mp4' || kind === 'mkv') {
        if (container !== null) {
          throw new AniDLError('Elige solo un formato contenedor: --mp4 o --mkv.')
        }
        container = kind
      } else if (kind === 'dlFonts') {
        dlFonts = true
      } else if (kind === 'tsd') {
        tsd = true
      } else if (kind === 'doc') {
        forceDocument = true
      } else if (kind === 'cleanup') {
        cleanup = true
      }
      i += 1
      continue
    }

    // Atajos rápidos sin guiones (ej.: "lat", "cast", "dual", "sub", "hardsub", "1080p", "720p", "mkv", "mp4")
    if (!token.startsWith('-')) {
      if (lower === 'mp4' || lower === 'mkv') {
        if (container !== null) throw new AniDLError('Elige solo un formato contenedor: --mp4 o --mkv.')
        container = lower
        i += 1
        continue
      }
      if (QUALITY_ALIASES.has(lower) && /[pP]$|^(?:max|best|fhd)$/.test(lower)) {
        setOnce('-q', lower, token)
        i += 1
        continue
      }
      if (lower === 'lat' || lower === 'latino') {
        setOnce('--dubLang', 'spa-419', token)
        i += 1
        continue
      }
      if (lower === 'cast' || lower === 'castellano') {
        setOnce('--dubLang', 'spa-ES', token)
        i += 1
        continue
      }
      if (lower === 'eng' || lower === 'en' || lower === 'dub') {
        setOnce('--dubLang', lower === 'dub' ? 'spa-419' : 'eng', token)
        i += 1
        continue
      }
      if (lower === 'dual') {
        setOnce('--dubLang', 'jpn,spa-419', token)
        i += 1
        continue
      }
      if (lower === 'sub') {
        setOnce('--dubLang', 'jpn', 'sub (audio)')
        fallbackSubs = 'es-419'
        i += 1
        continue
      }
      if (lower === 'hardsub' || lower === 'hs') {
        setOnce('--hslang', 'es-419', token)
        i += 1
        continue
      }
      if (lower === 'tsd') {
        tsd = true
        i += 1
        continue
      }
      if (lower === 'fonts') {
        dlFonts = true
        i += 1
        continue
      }
      throw new AniDLError(`Opción no admitida: ${token.slice(0, 32)}.`)
    }

    const eqIdx = token.indexOf('=')
    const rawOpt = eqIdx === -1 ? token : token.slice(0, eqIdx)
    const canonical = VALUE_OPTIONS.get(rawOpt.toLowerCase())
    if (!canonical) {
      throw new AniDLError(`Opción no admitida: ${rawOpt.slice(0, 32)}.`)
    }
    if (values.has(canonical)) {
      throw new AniDLError(`La opción ${canonical} no se puede repetir.`)
    }

    let value
    if (eqIdx !== -1) {
      value = token.slice(eqIdx + 1)
      if (!value || value.startsWith('-')) {
        throw new AniDLError(`Valor no válido para ${rawOpt}.`)
      }
      i += 1
    } else {
      i += 1
      if (i >= tokens.length) {
        throw new AniDLError(`Falta el valor de ${rawOpt}.`)
      }
      value = tokens[i]
      if (!value || value.startsWith('-')) {
        throw new AniDLError(`Valor no válido para ${rawOpt}.`)
      }
      i += 1

      // Permitir listas separadas por espacios para --dubLang y --dlsubs (igual que el CLI nativo de aniDL)
      if (canonical === '--dubLang' || canonical === '--dlsubs') {
        const collected = [value]
        while (i < tokens.length && !tokens[i].startsWith('-')) {
          const candidate = tokens[i].toLowerCase()
          const isLang = ALIAS_MAP.has(candidate)
            || (canonical === '--dlsubs' && ['all', 'todos', 'none', 'ninguno'].includes(candidate))
          if (!isLang) break
          collected.push(tokens[i])
          i += 1
        }
        value = collected.join(',')
      }
    }

    values.set(canonical, value)
  }

  const rawDub = values.get('--dubLang') ?? defaults.dubLanguage ?? 'jpn'
  const dubParts = String(rawDub).split(',').map((s) => s.trim()).filter(Boolean)
  if (!dubParts.length || dubParts.length > 6) {
    throw new AniDLError('Debes especificar entre 1 y 6 códigos de audio válidos.')
  }
  const dubLanguages = [...new Set(dubParts.map(normalizeDubLanguage))]

  const rawSubs = values.get('--dlsubs') ?? fallbackSubs ?? defaults.downloadSubtitles ?? 'all'
  const subParts = String(rawSubs).split(',').map((s) => s.trim()).filter(Boolean)
  if (!subParts.length || subParts.length > 10) {
    throw new AniDLError('Cantidad de idiomas de subtítulos no válida.')
  }
  const normalizedSubs = [...new Set(subParts.map((item) => normalizeSubLanguage(item, { allowAll: true, allowNone: true })))]
  if (normalizedSubs.length > 1 && (normalizedSubs.includes('all') || normalizedSubs.includes('none'))) {
    throw new AniDLError('No combines "all" o "none" con otros idiomas en --dlsubs.')
  }
  const downloadSubtitles = normalizedSubs.join(',')

  let hardSubtitleLanguage = null
  if (values.has('--hslang') || defaults.hardSubtitleLanguage) {
    const hs = normalizeSubLanguage(values.get('--hslang') ?? defaults.hardSubtitleLanguage, { allowNone: true })
    hardSubtitleLanguage = hs === 'none' ? null : hs
  }

  const defaultQuality = Number.isInteger(defaults.quality) ? defaults.quality : 4
  const quality = values.has('-q') ? parseQualityValue(values.get('-q')) : defaultQuality
  if (!Number.isInteger(quality) || quality < 0 || quality > 5) {
    throw new AniDLError('La calidad debe ser un número del 0 al 5.')
  }

  let partsize = null
  if (values.has('--partsize')) {
    const parsedParts = Number(values.get('--partsize'))
    if (!Number.isInteger(parsedParts) || parsedParts < 1 || parsedParts > 64) {
      throw new AniDLError('El valor de --partsize debe ser un entero entre 1 y 64.')
    }
    partsize = parsedParts
  }

  const defaultAudio = values.has('--defaultAudio') ? normalizeDubLanguage(values.get('--defaultAudio')) : null
  const defaultSub = values.has('--defaultSub') ? normalizeSubLanguage(values.get('--defaultSub')) : null

  let episodeSelection = null
  if (values.has('-e')) {
    const rawEp = String(values.get('-e')).trim()
    if (!EPISODE_SELECTION_RE.test(rawEp)) {
      throw new AniDLError('Selección de episodio inválida en -e (ejemplos válidos: 1, 1-3, 1,2, S1).')
    }
    episodeSelection = rawEp
  }

  const resolvedContainer = container || defaults.container || 'mp4'
  if (resolvedContainer !== 'mp4' && resolvedContainer !== 'mkv') {
    throw new AniDLError('El contenedor debe ser mp4 o mkv.')
  }

  return Object.freeze({
    dubLanguage: dubLanguages[0],
    dubLanguages: Object.freeze(dubLanguages),
    downloadSubtitles,
    downloadSubtitlesList: Object.freeze(normalizedSubs),
    hardSubtitleLanguage,
    quality,
    container: resolvedContainer,
    dlFonts,
    tsd,
    partsize,
    defaultAudio,
    defaultSub,
    episodeSelection,
    forceDocument,
    cleanup,
  })
}

/**
 * Extrae el destino de Crunchyroll y las opciones a partir del texto del comando y/o mensaje citado.
 */
export function parseAniDLInput(rawText = '', quotedText = '', defaults = {}) {
  const tokens = tokenizeOptions(rawText)
  const urlTokenIndex = tokens.findIndex((token) => /^https?:\/\//i.test(token))

  let url = null
  if (urlTokenIndex !== -1) {
    url = tokens[urlTokenIndex]
    tokens.splice(urlTokenIndex, 1)
  } else {
    url = extractCrunchyrollUrl(quotedText)
  }

  if (!url) {
    throw new AniDLError('Debes enviar un enlace HTTPS de Crunchyroll o responder a un mensaje que lo contenga.')
  }

  const target = extractCrunchyrollTarget(url)
  const options = parseOptions(tokens, defaults)

  if (target.kind === 'series' && !options.episodeSelection) {
    throw new AniDLError('Para enlaces /series/ID debes indicar qué episodio descargar con -e (ej.: -e 1 o -e 1-3).')
  }

  return { target, options }
}

/**
 * Construye argv seguro sin usar shell ni interpolar entradas sin validar.
 * Corrige el bug de `--mkv`: multi-downloader-nx usa MKV por omisión y solo expone `--mp4`.
 */
export function buildCommand(executable, targetOrEpisodeId, options) {
  if (!executable || typeof executable !== 'string') {
    throw new AniDLError('Ejecutable de AniDL no válido.')
  }

  const target = typeof targetOrEpisodeId === 'string'
    ? { kind: 'episode', id: targetOrEpisodeId }
    : targetOrEpisodeId

  if (!target?.id || !EPISODE_ID_RE.test(target.id)) {
    throw new AniDLError('El identificador del episodio o serie no es válido.')
  }

  const opts = options || parseOptions('')
  const dubList = Array.isArray(opts.dubLanguages) && opts.dubLanguages.length
    ? opts.dubLanguages
    : [opts.dubLanguage || 'jpn']
  const subList = Array.isArray(opts.downloadSubtitlesList) && opts.downloadSubtitlesList.length
    ? opts.downloadSubtitlesList
    : String(opts.downloadSubtitles || 'all').split(',').filter(Boolean)

  const command = [
    executable,
    '--service', 'crunchy',
  ]

  if (target.kind === 'series') {
    if (!opts.episodeSelection || !EPISODE_SELECTION_RE.test(opts.episodeSelection)) {
      throw new AniDLError('Falta una selección -e válida para descargar desde una serie.')
    }
    command.push('--srz', target.id, '-e', opts.episodeSelection)
    if (dubList.length > 1) command.push('--dlVideoOnce')
  } else {
    // Usar siempre -e: --extid no seleccionaba los episodios.
    const idFlag = '-e'
    command.push(idFlag, target.id)
  }

  command.push('--dubLang', ...dubList)
  command.push('--dlsubs', ...subList)

  if (opts.hardSubtitleLanguage) {
    command.push('--hslang', opts.hardSubtitleLanguage)
  }

  command.push('-q', String(opts.quality))

  if (opts.container === 'mp4') {
    command.push('--mp4')
  } else if (opts.dlFonts) {
    command.push('--dlFonts')
  }

  if (opts.tsd) {
    command.push('--tsd')
  }
  if (opts.partsize) {
    command.push('--partsize', String(opts.partsize))
  }
  if (opts.defaultAudio) {
    command.push('--defaultAudio', opts.defaultAudio)
  }
  if (opts.defaultSub) {
    command.push('--defaultSub', opts.defaultSub)
  }

  command.push('--force', 'y', '--skipUpdate')
  return command
}

function expandHome(inputPath, homeDir = os.homedir()) {
  const raw = String(inputPath || '').trim()
  if (!raw) return ''
  if (raw === '~') return homeDir
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(homeDir, raw.slice(2))
  }
  return raw
}

function positiveEnvInt(env, names, fallback) {
  const keys = Array.isArray(names) ? names : [names]
  for (const name of keys) {
    const raw = env?.[name]
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    const parsed = Number.parseInt(String(raw).trim(), 10)
    if (Number.isFinite(parsed) && parsed >= 1) return parsed
  }
  return fallback
}

function envBool(env, names, fallback = false) {
  const keys = Array.isArray(names) ? names : [names]
  for (const name of keys) {
    const raw = env?.[name]
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    const normalized = String(raw).trim().toLowerCase()
    if (['1', 'true', 'yes', 'si', 'sí', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

function isExecutableFile(filePath) {
  if (!filePath) return false
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return false
    if (process.platform !== 'win32') {
      fs.accessSync(filePath, fs.constants.X_OK)
    }
    return true
  } catch {
    return false
  }
}

function findInPath(binaryName, envPath = process.env.PATH || '') {
  if (!binaryName) return null
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const dir of String(envPath).split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const full = path.join(dir, binaryName.endsWith(ext) ? binaryName : `${binaryName}${ext}`)
      if (isExecutableFile(full)) return full
    }
  }
  return null
}

function resolveConfiguredContentDir(workDir) {
  const candidates = [
    path.join(workDir, 'config', 'dir-path.user.yml'),
    path.join(workDir, 'config', 'dir-path.yml'),
  ]
  for (const cfgFile of candidates) {
    try {
      if (!fs.existsSync(cfgFile)) continue
      const content = fs.readFileSync(cfgFile, 'utf8')
      const match = content.match(/^\s*content\s*:\s*(['"]?)([^'"#\r\n]+)\1/m)
      if (!match) continue
      const rawDir = expandHome(match[2].trim())
      if (!rawDir) continue
      return path.isAbsolute(rawDir) ? path.normalize(rawDir) : path.resolve(workDir, rawDir)
    } catch {}
  }
  return path.join(workDir, 'videos')
}

/**
 * Resuelve la instalación local de AniDL con soporte para ANIDL_* y fallback a ZERO_TWO_ANIDL_*.
 */
export function resolveAniDLSetup(env = process.env) {
  const homeDir = os.homedir()
  const timeoutSeconds = positiveEnvInt(env, ['ANIDL_TIMEOUT', 'ZERO_TWO_ANIDL_TIMEOUT'], 10800)
  const maxMb = positiveEnvInt(env, ['ANIDL_MAX_MB', 'ZERO_TWO_ANIDL_MAX_MB'], 1950)
  const defaultQualityRaw = env?.ANIDL_DEFAULT_QUALITY
  const defaultQuality = defaultQualityRaw !== undefined && String(defaultQualityRaw).trim() !== ''
    ? Math.min(5, Math.max(0, Number.parseInt(String(defaultQualityRaw), 10) || 4))
    : 4
  const cleanupDefault = envBool(env, ['ANIDL_CLEANUP'], false)

  const configuredDirRaw = (env?.ANIDL_DIR || env?.ZERO_TWO_ANIDL_DIR || '').trim()
  const candidateDirs = configuredDirRaw
    ? [expandHome(configuredDirRaw, homeDir)]
    : [path.join(homeDir, 'anidl'), fromRoot('anidl')]

  let workDir = null
  for (const candidate of candidateDirs) {
    try {
      const resolved = fs.realpathSync(candidate)
      if (fs.statSync(resolved).isDirectory()) {
        workDir = resolved
        break
      }
    } catch {}
  }

  const muxers = {
    ffmpeg: Boolean(findInPath('ffmpeg', env?.PATH)),
    mkvmerge: Boolean(findInPath('mkvmerge', env?.PATH)),
  }

  if (!workDir) {
    return {
      ready: false,
      reason: 'WORK_DIR_NOT_FOUND',
      expectedDir: candidateDirs[0],
      workDir: null,
      outputDir: null,
      executable: null,
      timeoutSeconds,
      maxMb,
      defaultQuality,
      cleanupDefault,
      muxers,
    }
  }

  const configuredBin = (env?.ANIDL_BIN || env?.ZERO_TWO_ANIDL_BIN || '').trim()
  let executable = null

  if (configuredBin) {
    const expanded = expandHome(configuredBin, homeDir)
    const hasPathSep = expanded.includes('/') || expanded.includes('\\')
    const localCandidate = path.isAbsolute(expanded)
      ? expanded
      : (hasPathSep ? path.resolve(workDir, expanded) : path.join(workDir, expanded))

    if (isExecutableFile(localCandidate)) {
      executable = fs.realpathSync(localCandidate)
    } else if (!hasPathSep) {
      executable = findInPath(expanded, env?.PATH)
    }
  } else {
    const binaryNames = process.platform === 'win32'
      ? ['aniDL.exe', 'multi-downloader-nx.exe', 'aniDL']
      : ['aniDL', 'multi-downloader-nx']
    for (const name of binaryNames) {
      const localBin = path.join(workDir, name)
      if (isExecutableFile(localBin)) {
        executable = fs.realpathSync(localBin)
        break
      }
    }
    if (!executable) {
      executable = findInPath('aniDL', env?.PATH) || findInPath('multi-downloader-nx', env?.PATH)
    }
  }

  if (!executable) {
    return {
      ready: false,
      reason: 'EXECUTABLE_NOT_FOUND',
      expectedDir: workDir,
      workDir,
      outputDir: null,
      executable: null,
      timeoutSeconds,
      maxMb,
      defaultQuality,
      cleanupDefault,
      muxers,
    }
  }

  const customOutputRaw = (env?.ANIDL_OUTPUT_DIR || '').trim()
  const outputDir = customOutputRaw
    ? path.resolve(workDir, expandHome(customOutputRaw, homeDir))
    : resolveConfiguredContentDir(workDir)

  return {
    ready: true,
    reason: null,
    expectedDir: workDir,
    workDir,
    outputDir,
    executable,
    timeoutSeconds,
    maxMb,
    defaultQuality,
    cleanupDefault,
    muxers,
  }
}

function isWithinDirectory(rootRealPath, targetRealPath) {
  const relative = path.relative(rootRealPath, targetRealPath)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function walkSafeVideos(outputDir, maxDepth = 4) {
  const found = []
  let rootReal
  try {
    if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) return found
    rootReal = fs.realpathSync(outputDir)
  } catch {
    return found
  }

  const visit = (currentDir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(currentDir, entry.name)
      try {
        const lstat = fs.lstatSync(fullPath)
        if (lstat.isSymbolicLink()) continue
        const resolved = fs.realpathSync(fullPath)
        if (!isWithinDirectory(rootReal, resolved)) continue

        if (lstat.isDirectory()) {
          visit(resolved, depth + 1)
          continue
        }
        if (!lstat.isFile()) continue
        const ext = path.extname(entry.name).toLowerCase()
        if (!VIDEO_EXTENSIONS.has(ext)) continue
        // Ignorar archivos temporales intermedios sin muxear de aniDL (p. ej. *.uncut.mp4.resume o fragmentos)
        if (/\.(?:part|temp|tmp|resume)$/i.test(entry.name)) continue

        found.push({
          filePath: resolved,
          mtimeMs: Math.trunc(lstat.mtimeMs),
          size: lstat.size,
        })
      } catch {}
    }
  }

  visit(rootReal, 0)
  return found
}

/**
 * Registra tamaños y fechas previas de videos dentro de outputDir (incluyendo subcarpetas) sin seguir symlinks.
 */
export function snapshotVideos(outputDir) {
  const snapshot = new Map()
  for (const item of walkSafeVideos(outputDir)) {
    snapshot.set(item.filePath, `${item.mtimeMs}:${item.size}`)
  }
  return snapshot
}

/**
 * Lista medios nuevos o modificados tras ejecutar AniDL, ordenados cronológicamente.
 */
export function changedVideos(outputDir, beforeSnapshot) {
  const before = beforeSnapshot instanceof Map ? beforeSnapshot : new Map()
  const changed = []
  for (const item of walkSafeVideos(outputDir)) {
    const state = `${item.mtimeMs}:${item.size}`
    if (item.size > 0 && before.get(item.filePath) !== state) {
      changed.push(item)
    }
  }
  changed.sort((a, b) => a.mtimeMs - b.mtimeMs || a.filePath.localeCompare(b.filePath))
  return changed.map((item) => item.filePath)
}

/**
 * Devuelve los videos existentes más recientes en outputDir (para diagnóstico/listado).
 */
export function listOutputVideos(outputDir, limit = 15) {
  const items = walkSafeVideos(outputDir).filter((item) => item.size > 0)
  items.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath))
  return items.slice(0, Math.max(1, limit))
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

/**
 * Limpia secuencias ANSI y redacta credenciales, correos o tokens antes de guardar trazas en memoria/consola.
 */
export function sanitizeAniDLLine(rawLine) {
  let line = String(rawLine || '').replace(ANSI_RE, '').replace(/\r/g, '').trim()
  if (!line) return ''
  if (/^\s*USER\s*:/i.test(line)) return '[USER REDACTED]'
  line = line
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '[auth-redacted]')
    .replace(/(?:etp[_-]rt|refresh[_-]?token|access[_-]?token|session[_-]?id)\s*[=:]\s*\S+/gi, '[token-redacted]')
  return line.slice(0, 300)
}

/**
 * Extrae indicadores seguros de progreso de una línea de salida de multi-downloader-nx (aniDL).
 */
export function parseAniDLProgress(rawLine) {
  const line = sanitizeAniDLLine(rawLine)
  if (!line) return null

  // Ejemplo real de hls-download.ts:
  // "120 of 350 parts downloaded [34.29%] (00:18 | 12.45 MB/s / 99.60 MBit/s)"
  const partsMatch = line.match(
    /(\d+)\s+of\s+(\d+)\s+parts\s+downloaded\s+\[([\d.]+)%\]\s*(?:\(([^|)]+)\|\s*(.+?)(?:\s+\/\s+[^)]+)?\))?/i,
  )
  if (partsMatch) {
    return {
      type: 'parts',
      completedParts: Number(partsMatch[1]),
      totalParts: Number(partsMatch[2]),
      percent: Math.min(100, Math.max(0, Number(partsMatch[3]))),
      elapsedText: partsMatch[4]?.trim() || null,
      speedText: partsMatch[5]?.trim() || null,
    }
  }

  // Ejemplo real de crunchy.ts: "Requesting: [G123ABC45] Solo Leveling - 01"
  const reqMatch = line.match(/^Requesting:\s*\[[^\]]+\]\s*(.+)$/i)
  if (reqMatch) {
    return {
      type: 'stage',
      stage: 'requesting',
      label: 'Solicitando streams del episodio',
      episodeTitle: reqMatch[1].trim().slice(0, 120),
    }
  }

  if (/Downloading\s+video/i.test(line)) {
    return { type: 'stage', stage: 'video', label: 'Descargando pista de video' }
  }
  if (/Downloading\s+audio/i.test(line)) {
    return { type: 'stage', stage: 'audio', label: 'Descargando pista de audio' }
  }
  if (/Downloading\s+fonts/i.test(line)) {
    return { type: 'stage', stage: 'fonts', label: 'Descargando fuentes de subtítulos' }
  }
  if (/^Subtitles:/i.test(line)) {
    return { type: 'stage', stage: 'subtitles', label: 'Procesando subtítulos' }
  }
  if (/\[(FFMPEG|MKVMERGE)\]\s*Started merging/i.test(line)) {
    return { type: 'stage', stage: 'muxing', label: 'Muxeando video, audio y subtítulos' }
  }
  if (/\[(FFMPEG|MKVMERGE)\s+Done\]/i.test(line)) {
    return { type: 'stage', stage: 'done', label: 'Muxeo finalizado' }
  }

  return null
}

/**
 * Clasifica errores frecuentes de AniDL sin exponer detalles sensibles en el chat.
 */
export function classifyAniDLError(sanitizedLines = [], exitCode = null) {
  const joined = sanitizedLines.join('\n')

  if (/TOO_MANY_ACTIVE_STREAMS/i.test(joined)) {
    return 'Crunchyroll rechazó la reproducción por exceso de streams activos (TOO_MANY_ACTIVE_STREAMS). Reintenta añadiendo `--tsd` al comando.'
  }
  if (/Authentication.*failed|invalid_grant|unauthorized|login.*failed|Token.*expired/i.test(joined)) {
    return 'La sesión local de Crunchyroll en AniDL expiró o no es válida. Renueva el inicio de sesión (`aniDL --service crunchy --auth`) en el servidor.'
  }
  if (/premium|subscription|not available for free/i.test(joined) && /unable to download|video not available|failed/i.test(joined)) {
    return 'El episodio requiere una cuenta Crunchyroll Premium activa en la instalación local de AniDL.'
  }
  if (/not available in your country|geo[- ]?restricted|403 Forbidden/i.test(joined)) {
    return 'El episodio no está disponible en la región del servidor o fue bloqueado por Crunchyroll (georrestricción).'
  }
  if (/(?:FFmpeg|MKVMerge)\s+not found,\s*skip muxing|Merging failed/i.test(joined)) {
    return 'AniDL descargó las pistas pero falló el muxeo. Verifica que `ffmpeg` y/o `mkvmerge` estén instalados en el servidor.'
  }
  if (/Unable to download selected episode|Video not available|Nothing Found/i.test(joined)) {
    return 'AniDL no encontró streams disponibles para ese episodio/idioma (verifica el enlace o prueba con otro `--dubLang`).'
  }

  return `AniDL no pudo completar la descarga${exitCode != null ? ` (código ${exitCode})` : ''}. Revisa la disponibilidad del episodio y la sesión local en el servidor.`
}

function terminateProcessTree(child, signalName) {
  if (!child || child.exitCode !== null) return
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signalName)
      return
    } catch {}
  }
  try {
    child.kill(signalName)
  } catch {}
}

/**
 * Ejecuta aniDL de forma asíncrona, segura, cancelable por AbortSignal y con límite de tiempo.
 */
export async function runAniDLDownload({
  executable,
  argv,
  workDir,
  outputDir,
  timeoutMs = 10_800_000,
  signal,
  onProgress,
  spawnImpl = spawn,
}) {
  if (signal?.aborted) {
    const abortErr = new Error('Descarga cancelada.')
    abortErr.name = 'AbortError'
    throw abortErr
  }

  fs.mkdirSync(outputDir, { recursive: true })
  const before = snapshotVideos(outputDir)
  const startedAt = Date.now()
  const recentLines = []
  const MAX_RECENT_LINES = 80

  const state = {
    percent: null,
    completedParts: 0,
    totalParts: 0,
    speedText: null,
    elapsedText: null,
    stage: 'starting',
    stageLabel: 'Iniciando AniDL',
    episodeTitle: null,
  }

  return new Promise((resolve, reject) => {
    let timedOut = false
    let cancelled = false
    let killEscalationTimer = null
    let settled = false

    const argsOnly = argv[0] === executable ? argv.slice(1) : argv
    let child
    try {
      child = spawnImpl(executable, argsOnly, {
        cwd: workDir,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
        },
      })
    } catch (err) {
      reject(err)
      return
    }

    const stopGracefully = () => {
      terminateProcessTree(child, 'SIGTERM')
      clearTimeout(killEscalationTimer)
      killEscalationTimer = setTimeout(() => {
        terminateProcessTree(child, 'SIGKILL')
      }, 5_000)
      killEscalationTimer.unref?.()
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      stopGracefully()
    }, timeoutMs)
    timeoutTimer.unref?.()

    const onAbort = () => {
      cancelled = true
      stopGracefully()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const handleStreamBuffer = (bufferState, chunk) => {
      bufferState.rest += chunk.toString('utf8')
      const parts = bufferState.rest.split(/[\r\n]+/)
      bufferState.rest = parts.pop() ?? ''
      for (const raw of parts) {
        const clean = sanitizeAniDLLine(raw)
        if (!clean) continue
        recentLines.push(clean)
        if (recentLines.length > MAX_RECENT_LINES) recentLines.shift()

        const progress = parseAniDLProgress(clean)
        if (!progress) continue
        if (progress.type === 'parts') {
          state.percent = progress.percent
          state.completedParts = progress.completedParts
          state.totalParts = progress.totalParts
          state.speedText = progress.speedText
          state.elapsedText = progress.elapsedText
          if (state.stage === 'starting' || state.stage === 'requesting') {
            state.stage = 'downloading'
            state.stageLabel = 'Descargando segmentos HLS/DASH'
          }
        } else if (progress.type === 'stage') {
          state.stage = progress.stage
          state.stageLabel = progress.label
          if (progress.episodeTitle) state.episodeTitle = progress.episodeTitle
          if (progress.stage === 'muxing') state.percent = 100
        }

        try {
          onProgress?.({
            ...state,
            elapsedMs: Date.now() - startedAt,
          })
        } catch {}
      }
    }

    const outBuf = { rest: '' }
    const errBuf = { rest: '' }
    child.stdout?.on('data', (chunk) => handleStreamBuffer(outBuf, chunk))
    child.stderr?.on('data', (chunk) => handleStreamBuffer(errBuf, chunk))

    const cleanupTimers = () => {
      clearTimeout(timeoutTimer)
      clearTimeout(killEscalationTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    child.once('error', (err) => {
      if (settled) return
      settled = true
      cleanupTimers()
      reject(err)
    })

    child.once('close', (code) => {
      if (settled) return
      settled = true
      cleanupTimers()

      if (outBuf.rest) handleStreamBuffer(outBuf, '\n')
      if (errBuf.rest) handleStreamBuffer(errBuf, '\n')

      if (cancelled || signal?.aborted) {
        const abortErr = new Error('Descarga cancelada.')
        abortErr.name = 'AbortError'
        reject(abortErr)
        return
      }

      if (timedOut) {
        reject(new AniDLError(
          `AniDL excedió el tiempo límite de ${Math.round(timeoutMs / 1000)} segundos. Los archivos previos se conservaron.`,
          'TIMEOUT',
        ))
        return
      }

      if (code !== 0) {
        reject(new AniDLError(classifyAniDLError(recentLines, code), 'PROCESS_FAILED'))
        return
      }

      const videos = changedVideos(outputDir, before)
      resolve({
        videos,
        episodeTitle: state.episodeTitle,
        elapsedMs: Date.now() - startedAt,
      })
    })
  })
}
