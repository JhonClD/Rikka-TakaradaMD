import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AniDLError,
  buildCommand,
  changedVideos,
  classifyAniDLError,
  extractCrunchyrollTarget,
  extractCrunchyrollUrl,
  extractEpisodeId,
  listOutputVideos,
  normalizeDubLanguage,
  normalizeSubLanguage,
  parseAniDLInput,
  parseAniDLProgress,
  parseOptions,
  resolveAniDLSetup,
  runAniDLDownload,
  sanitizeAniDLLine,
  snapshotVideos,
  tokenizeOptions,
} from '../src/libraries/anidl.js'
import anidlPlugin from '../plugins/anidl.js'

function makeTempDir(prefix = 'anidl-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('extractEpisodeId y extractCrunchyrollTarget validan enlaces HTTPS de Crunchyroll', () => {
  assert.equal(
    extractEpisodeId('https://www.crunchyroll.com/es-es/watch/G123ABC45/solo-leveling-ep-1'),
    'G123ABC45',
  )
  assert.equal(
    extractEpisodeId('https://crunchyroll.com/watch/LEGACY_EXT_ID_99999'),
    'LEGACY_EXT_ID_99999',
  )

  const seriesTarget = extractCrunchyrollTarget('https://www.crunchyroll.com/es/series/GDKHZEJ0K/solo-leveling')
  assert.equal(seriesTarget.kind, 'series')
  assert.equal(seriesTarget.id, 'GDKHZEJ0K')

  // extractEpisodeId sigue exigiendo /watch/ID
  assert.throws(
    () => extractEpisodeId('https://www.crunchyroll.com/es/series/GDKHZEJ0K/solo-leveling'),
    AniDLError,
  )

  // Rechazo de http, dominios falsos, puertos y credenciales en la autoridad
  for (const bad of [
    'http://www.crunchyroll.com/watch/G123ABC45',
    'https://evil-crunchyroll.com/watch/G123ABC45',
    'https://crunchyroll.com.evil.tld/watch/G123ABC45',
    'https://user:pass@www.crunchyroll.com/watch/G123ABC45',
    'https://www.crunchyroll.com:8443/watch/G123ABC45',
    'https://www.crunchyroll.com/watch/ab',
    'https://www.crunchyroll.com/browse',
  ]) {
    assert.throws(() => extractCrunchyrollTarget(bad), AniDLError, `debería rechazar: ${bad}`)
  }
})

test('extractCrunchyrollUrl extrae enlaces limpios desde mensajes citados', () => {
  const text = '🎬 Nuevo episodio disponible: (https://www.crunchyroll.com/es/watch/GWDU8KN73/episodio-12).'
  assert.equal(
    extractCrunchyrollUrl(text),
    'https://www.crunchyroll.com/es/watch/GWDU8KN73/episodio-12',
  )
  assert.equal(extractCrunchyrollUrl('sin enlaces aquí'), null)
})

test('normalizeDubLanguage y normalizeSubLanguage convierten códigos entre ISO-639-2, locales y alias', () => {
  assert.equal(normalizeDubLanguage('lat'), 'spa-419')
  assert.equal(normalizeDubLanguage('es-419'), 'spa-419')
  assert.equal(normalizeDubLanguage('es-ES'), 'spa-ES')
  assert.equal(normalizeDubLanguage('ja'), 'jpn')
  assert.equal(normalizeDubLanguage('en'), 'eng')
  assert.equal(normalizeDubLanguage('pt-BR'), 'por')

  assert.equal(normalizeSubLanguage('spa-419'), 'es-419')
  assert.equal(normalizeSubLanguage('lat'), 'es-419')
  assert.equal(normalizeSubLanguage('spa-ES'), 'es-ES')
  assert.equal(normalizeSubLanguage('jpn'), 'ja')
  assert.equal(normalizeSubLanguage('all', { allowAll: true }), 'all')
  assert.equal(normalizeSubLanguage('none', { allowNone: true }), 'none')
})

test('parseOptions soporta banderas de aniDL, listas de idiomas, calidades 0..5 y atajos rápidos', () => {
  const defaults = parseOptions('')
  assert.equal(defaults.dubLanguage, 'jpn')
  assert.equal(defaults.downloadSubtitles, 'all')
  assert.equal(defaults.hardSubtitleLanguage, null)
  assert.equal(defaults.quality, 4)
  assert.equal(defaults.container, 'mp4')

  const custom = parseOptions('--dubLang es-419 --dlsubs spa-419 es-ES --hslang=lat -q 0 --mkv --dlFonts --tsd --partsize 24')
  assert.deepEqual(custom.dubLanguages, ['spa-419'])
  assert.deepEqual(custom.downloadSubtitlesList, ['es-419', 'es-ES'])
  assert.equal(custom.hardSubtitleLanguage, 'es-419')
  assert.equal(custom.quality, 0)
  assert.equal(custom.container, 'mkv')
  assert.equal(custom.dlFonts, true)
  assert.equal(custom.tsd, true)
  assert.equal(custom.partsize, 24)

  const shorthand = parseOptions('lat 1080p mkv fonts tsd')
  assert.equal(shorthand.dubLanguage, 'spa-419')
  assert.equal(shorthand.quality, 0)
  assert.equal(shorthand.container, 'mkv')
  assert.equal(shorthand.dlFonts, true)
  assert.equal(shorthand.tsd, true)

  // `sub` no debe chocar con `--dlsubs all` explícito
  const subOverride = parseOptions('sub --dlsubs all')
  assert.equal(subOverride.dubLanguage, 'jpn')
  assert.equal(subOverride.downloadSubtitles, 'all')

  assert.throws(() => parseOptions('--mp4 --mkv'), AniDLError)
  assert.throws(() => parseOptions('-q 9'), AniDLError)
  assert.throws(() => parseOptions('--unknown value'), AniDLError)
  assert.throws(() => tokenizeOptions('--dubLang "unclosed'), AniDLError)
})

test('buildCommand omite --mkv inválido, usa --mp4 solo en MP4 y elige -e, --extid o --srz correctamente', () => {
  const mp4Opts = parseOptions('')
  const mp4Cmd = buildCommand('/opt/anidl/aniDL', 'G123ABC45', mp4Opts)
  assert.deepEqual(mp4Cmd, [
    '/opt/anidl/aniDL',
    '--service', 'crunchy',
    '-e', 'G123ABC45',
    '--dubLang', 'jpn',
    '--dlsubs', 'all',
    '-q', '4',
    '--mp4',
    '--force', 'y',
    '--skipUpdate',
  ])

  const mkvOpts = parseOptions('--mkv --dlFonts -q max --hslang es-419 --tsd')
  const mkvCmd = buildCommand('/opt/anidl/aniDL', 'LEGACY_EPISODE_12345', mkvOpts)
  assert.ok(!mkvCmd.includes('--mkv'), 'multi-downloader-nx no admite --mkv; MKV es el predeterminado sin --mp4')
  assert.ok(!mkvCmd.includes('--mp4'))
  assert.ok(mkvCmd.includes('--extid'))
  assert.ok(mkvCmd.includes('--dlFonts'))
  assert.ok(mkvCmd.includes('--tsd'))
  assert.deepEqual(mkvCmd.slice(mkvCmd.indexOf('-q'), mkvCmd.indexOf('-q') + 2), ['-q', '0'])

  const seriesInput = parseAniDLInput(
    'https://www.crunchyroll.com/es/series/GDKHZEJ0K/solo-leveling -e 1-2 dual mkv',
  )
  const seriesCmd = buildCommand('/opt/anidl/aniDL', seriesInput.target, seriesInput.options)
  assert.ok(seriesCmd.includes('--srz'))
  assert.ok(seriesCmd.includes('--dlVideoOnce'))
  assert.deepEqual(
    seriesCmd.slice(seriesCmd.indexOf('--dubLang'), seriesCmd.indexOf('--dubLang') + 3),
    ['--dubLang', 'jpn', 'spa-419'],
  )
})

test('resolveAniDLSetup soporta ANIDL_*, fallback ZERO_TWO_ANIDL_* y dir-path.yml personalizado', (t) => {
  const root = makeTempDir('anidl-setup-')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const binPath = path.join(root, 'aniDL')
  fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(binPath, 0o755)
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  fs.writeFileSync(path.join(root, 'config', 'dir-path.yml'), 'content: ./custom_out/\n')

  const setup = resolveAniDLSetup({
    ZERO_TWO_ANIDL_DIR: root,
    ZERO_TWO_ANIDL_TIMEOUT: '3600',
    ZERO_TWO_ANIDL_MAX_MB: '1500',
    PATH: process.env.PATH,
  })

  assert.equal(setup.ready, true)
  assert.equal(setup.executable, fs.realpathSync(binPath))
  assert.equal(setup.outputDir, path.join(fs.realpathSync(root), 'custom_out'))
  assert.equal(setup.timeoutSeconds, 3600)
  assert.equal(setup.maxMb, 1500)
})

test('snapshotVideos y changedVideos detectan subcarpetas e ignoran symlinks externos y temporales', (t) => {
  const root = makeTempDir('anidl-videos-')
  const outside = makeTempDir('anidl-outside-')
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  const existing = path.join(root, 'old.mp4')
  fs.writeFileSync(existing, 'old-video')
  const secretOutside = path.join(outside, 'secret.mp4')
  fs.writeFileSync(secretOutside, 'secret-data')

  const before = snapshotVideos(root)

  // Nuevo archivo en subcarpeta (ej. plantilla con carpetas por serie/temporada)
  const nestedDir = path.join(root, 'Solo Leveling', 'Season 01')
  fs.mkdirSync(nestedDir, { recursive: true })
  const created = path.join(nestedDir, 'S01E01.mkv')
  fs.writeFileSync(created, 'muxed-mkv-content')

  // Archivos que NO deben reportarse: vacíos, temporales .resume, ni symlinks hacia fuera
  fs.writeFileSync(path.join(root, 'empty.mp4'), '')
  fs.writeFileSync(path.join(root, 'stream.mp4.resume'), 'temp')
  fs.symlinkSync(secretOutside, path.join(root, 'linked.mp4'))

  const diff = changedVideos(root, before)
  assert.deepEqual(diff, [fs.realpathSync(created)])

  const listed = listOutputVideos(root, 10)
  assert.equal(listed.length, 2)
})

test('sanitizeAniDLLine, parseAniDLProgress y classifyAniDLError protegen datos sensibles y extraen telemetría', () => {
  assert.equal(sanitizeAniDLLine('USER: MyNick (owner@secret-mail.com)'), '[USER REDACTED]')
  const redacted = sanitizeAniDLLine('Auth header Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig email test@foo.org')
  assert.ok(!redacted.includes('eyJhbGci'))
  assert.ok(!redacted.includes('test@foo.org'))

  const parts = parseAniDLProgress('120 of 350 parts downloaded [34.29%] (00:18 | 12.45 MB/s / 99.60 MBit/s)')
  assert.deepEqual(parts, {
    type: 'parts',
    completedParts: 120,
    totalParts: 350,
    percent: 34.29,
    elapsedText: '00:18',
    speedText: '12.45 MB/s',
  })

  const reqStage = parseAniDLProgress('Requesting: [G123ABC45] Solo Leveling - 01')
  assert.equal(reqStage?.stage, 'requesting')
  assert.equal(reqStage?.episodeTitle, 'Solo Leveling - 01')

  const errMsg = classifyAniDLError(['[ERROR] Crunchyroll returned TOO_MANY_ACTIVE_STREAMS'], 1)
  assert.match(errMsg, /--tsd/)
})

test('runAniDLDownload y plugins/anidl.js descargan, reportan progreso, suben por mensaje citado y cancelan', async (t) => {
  const workDir = makeTempDir('anidl-e2e-')
  const outDir = path.join(workDir, 'videos')
  fs.mkdirSync(outDir, { recursive: true })

  const mockBin = path.join(workDir, 'aniDL')
  fs.writeFileSync(
    mockBin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('SLOW_CANCEL_ID')) {
  console.log('Requesting: [SLOW_CANCEL_ID] Episodio Lento');
  setTimeout(() => process.exit(0), 30000);
} else {
  console.log('USER: DemoUser (private@example.com)');
  console.log('Requesting: [GWDU8KN73] Frieren - 01');
  console.log('50 of 100 parts downloaded [50.00%] (00:02 | 10.00 MB/s / 80.00 MBit/s)');
  console.log('[MKVMERGE] Started merging');
  const targetExt = args.includes('--mp4') ? '.mp4' : '.mkv';
  fs.writeFileSync(path.join(process.cwd(), 'videos', 'Frieren_S01E01' + targetExt), Buffer.alloc(2048, 0x42));
  console.log('[MKVMERGE Done]');
  process.exit(0);
}
`,
  )
  fs.chmodSync(mockBin, 0o755)

  const prevDir = process.env.ANIDL_DIR
  const prevBin = process.env.ANIDL_BIN
  process.env.ANIDL_DIR = workDir
  process.env.ANIDL_BIN = mockBin

  t.after(() => {
    if (prevDir === undefined) delete process.env.ANIDL_DIR
    else process.env.ANIDL_DIR = prevDir
    if (prevBin === undefined) delete process.env.ANIDL_BIN
    else process.env.ANIDL_BIN = prevBin
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  // 1) Bloqueo para no-owners
  const repliesNonOwner = []
  await anidlPlugin(
    {
      chat: '123@g.us',
      sender: '999@s.whatsapp.net',
      reply: async (txt) => repliesNonOwner.push(txt),
    },
    { conn: {}, text: 'https://www.crunchyroll.com/watch/GWDU8KN73', args: ['https://www.crunchyroll.com/watch/GWDU8KN73'], usedPrefix: '.', isOwner: false },
  )
  assert.equal(repliesNonOwner.length, 1)
  assert.match(repliesNonOwner[0], /Solo el propietario/)

  // 2) Flujo completo respondiendo a un mensaje citado con enlace de Crunchyroll + atajo `lat`
  const sentMessages = []
  const mockConn = {
    sendMessage: async (chat, payload) => {
      sentMessages.push({ chat, payload })
      return { key: { id: `msg-${sentMessages.length}`, remoteJid: chat } }
    },
  }

  await anidlPlugin(
    {
      chat: '123@g.us',
      sender: '51925092348@s.whatsapp.net',
      quoted: {
        text: 'Estreno Crunchyroll: https://www.crunchyroll.com/es/watch/GWDU8KN73/frieren-ep-1',
      },
      reply: async (txt) => sentMessages.push({ chat: '123@g.us', payload: { text: txt } }),
    },
    {
      conn: mockConn,
      text: 'lat',
      args: ['lat'],
      usedPrefix: '.',
      isOwner: true,
    },
  )

  const uploadedVideo = sentMessages.find((item) => item.payload?.video || item.payload?.document)
  assert.ok(uploadedVideo, 'debe haber subido el archivo descargado a WhatsApp')
  assert.match(uploadedVideo.payload.caption, /Español Latino/)
  const finalStatus = sentMessages[sentMessages.length - 1]
  assert.match(finalStatus.payload.text, /AniDL completado/)
  // Asegura que jamás se filtró el correo del proceso en ningún mensaje de WhatsApp
  for (const entry of sentMessages) {
    assert.ok(!JSON.stringify(entry.payload).includes('private@example.com'))
  }

  // 3) Cancelación con AbortController en runAniDLDownload
  const abortController = new AbortController()
  const slowPromise = runAniDLDownload({
    executable: mockBin,
    argv: [mockBin, '--service', 'crunchy', '--extid', 'SLOW_CANCEL_ID'],
    workDir,
    outputDir: outDir,
    timeoutMs: 15_000,
    signal: abortController.signal,
    onProgress: () => abortController.abort(),
  })

  await assert.rejects(slowPromise, (err) => err?.name === 'AbortError')
})
