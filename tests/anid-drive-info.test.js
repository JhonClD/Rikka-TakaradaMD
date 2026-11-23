import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAniDDriveMetadata,
  cleanRawAnimeLabel,
  deriveAnimeTitle,
  isGenericAnimeLabel,
  isPlausibleAiTitle,
  parseAiAnimeTitleResponse,
  resolveAniDAnimeTitles,
} from '../src/libraries/anid-drive-info.js'
import { stripThinkingTags } from '../src/libraries/freellm.js'

test('cleanRawAnimeLabel y deriveAnimeTitle limpian carpetas y archivos individuales de anime', () => {
  assert.equal(
    cleanRawAnimeLabel('[SubsPlease] Sousou no Frieren - 01 (1080p) [ABC12345].mkv'),
    'Sousou no Frieren',
  )
  assert.equal(
    cleanRawAnimeLabel('[AnimeLat.com] Kimetsu no Yaiba Cap 01 1080p Audio Latino.mp4'),
    'Kimetsu no Yaiba',
  )
  assert.equal(
    cleanRawAnimeLabel('Sousou.no.Frieren.S01E01.1080p.WEB-DL.mkv'),
    'Sousou no Frieren',
  )
  assert.equal(
    cleanRawAnimeLabel('[BD 1080p] Kimetsu no Yaiba - Mugen Ressha-hen [Dual Audio].mkv'),
    'Kimetsu no Yaiba - Mugen Ressha-hen',
  )

  // Etiquetas genéricas se descartan
  for (const generic of ['01.mp4', 'Capitulo 01 (1080p).mkv', 'Temporada 2', 'Especiales', 'Anime', 'Carpeta']) {
    assert.equal(cleanRawAnimeLabel(generic), '', `${generic} debe quedar vacío`)
    assert.equal(isGenericAnimeLabel(generic.replace(/\.(mp4|mkv)$/i, '')), true)
  }

  // Carpeta con archivos numéricos usa el nombre de la carpeta
  assert.equal(
    deriveAnimeTitle(
      [{ fileName: '01.mp4' }, { fileName: '02.mp4' }, { fileName: '03.mp4' }],
      '[1080p Latino] Jujutsu Kaisen Temporada 2',
    ),
    'Jujutsu Kaisen Temporada 2',
  )

  // Carpeta con subtítulos distintos por episodio extrae el prefijo común
  assert.equal(
    deriveAnimeTitle([
      { fileName: 'Sousou no Frieren Parte Alfa.mkv' },
      { fileName: 'Sousou no Frieren Parte Beta.mkv' },
    ]),
    'Sousou no Frieren Parte',
  )
})

test('stripThinkingTags y parseAiAnimeTitleResponse toleran <think>, bloques markdown y texto plano', () => {
  assert.equal(stripThinkingTags('<think>razonando...</think>  Hola  '), 'Hola')
  assert.equal(stripThinkingTags('<think>truncado sin cierre'), '')

  assert.deepEqual(
    parseAiAnimeTitleResponse('<think>analizando archivos</think>\n```json\n{"title":"Jujutsu Kaisen 2nd Season","alt":"Jujutsu Kaisen"}\n```'),
    { title: 'Jujutsu Kaisen 2nd Season', alt: 'Jujutsu Kaisen' },
  )

  assert.deepEqual(
    parseAiAnimeTitleResponse('Título: "Sousou no Frieren"'),
    { title: 'Sousou no Frieren', alt: '' },
  )

  assert.deepEqual(parseAiAnimeTitleResponse('<think>cortado por límite'), { title: '', alt: '' })
})

test('isPlausibleAiTitle acepta expansiones oficiales, palabras pegadas y siglas; rechaza alucinaciones', () => {
  // Palabras pegadas
  assert.equal(
    isPlausibleAiTitle('Chainsaw Man', { files: [{ fileName: 'ChainsawMan_01_1080p.mp4' }] }),
    true,
  )
  assert.equal(
    isPlausibleAiTitle('Boku no Hero Academia', { files: [{ fileName: 'BokuNoHero_01.mp4' }] }),
    true,
  )
  assert.equal(
    isPlausibleAiTitle('Re:Zero kara Hajimeru Isekai Seikatsu', { files: [{ fileName: 'ReZero_01.mp4' }] }),
    true,
  )
  assert.equal(
    isPlausibleAiTitle('Kono Subarashii Sekai ni Shukufuku wo!', { files: [{ fileName: 'Konosuba_S3_01.mkv' }] }),
    true,
  )

  // Título oficial en romaji a partir de nombre corto
  assert.equal(
    isPlausibleAiTitle('Sousou no Frieren', { files: [{ fileName: 'Frieren - 01 [1080p].mkv' }] }),
    true,
  )

  // Siglas clásicas de anime
  assert.equal(
    isPlausibleAiTitle('Shingeki no Kyojin', { files: [{ fileName: 'SNK_T4_01.mp4' }] }),
    true,
  )
  assert.equal(
    isPlausibleAiTitle('Jujutsu Kaisen 2nd Season', { files: [{ fileName: 'JJK_01.mp4' }], folderTitle: 'Temporada 2' }),
    true,
  )
  assert.equal(
    isPlausibleAiTitle('One Punch Man', { files: [{ fileName: 'OPM_S2_01.mkv' }] }),
    true,
  )

  // Negativas de la IA y alucinaciones ajenas se rechazan
  assert.equal(
    isPlausibleAiTitle('Lo siento, no puedo identificar el anime.', { files: [{ fileName: 'Frieren_01.mkv' }] }),
    false,
  )
  assert.equal(
    isPlausibleAiTitle('One Piece', { files: [{ fileName: 'Solo Leveling - 01 [1080p].mkv' }] }),
    false,
  )
})

test('resolveAniDAnimeTitles funciona para carpetas y archivos individuales con APIsFreeLLM y respaldo', async () => {
  // 1) Carpeta con nombre genérico de temporada + archivos con sigla
  let capturedPayload = null
  const folderRes = await resolveAniDAnimeTitles({
    files: [{ fileName: 'JJK_01_1080p_Lat.mp4' }, { fileName: 'JJK_02_1080p_Lat.mp4' }],
    rawFolderTitle: 'Temporada 2',
    folderTitle: '',
    isFolder: true,
    aiClient: async (messages) => {
      capturedPayload = JSON.parse(messages[1].content)
      return '<think>JJK + Temporada 2</think>{"title":"Jujutsu Kaisen 2nd Season","alt":"Jujutsu Kaisen"}'
    },
    log: () => {},
    warn: () => {},
  })
  assert.equal(capturedPayload.tipo, 'carpeta')
  assert.equal(capturedPayload.nombreCarpeta, 'Temporada 2')
  assert.equal(folderRes.usedAi, true)
  assert.deepEqual(folderRes.candidates.slice(0, 2), ['Jujutsu Kaisen 2nd Season', 'Jujutsu Kaisen'])

  // 2) Archivo individual (película o capítulo suelto)
  let filePayload = null
  const fileRes = await resolveAniDAnimeTitles({
    files: [{ fileName: '[AnimeLat] KimetsuNoYaiba_MugenTrain_1080p_Lat.mkv' }],
    isFolder: false,
    aiClient: async (messages) => {
      filePayload = JSON.parse(messages[1].content)
      return '{"title":"Kimetsu no Yaiba: Mugen Ressha-hen","alt":"Kimetsu no Yaiba"}'
    },
    log: () => {},
    warn: () => {},
  })
  assert.equal(filePayload.tipo, 'archivo')
  assert.equal(fileRes.usedAi, true)
  assert.equal(fileRes.primary, 'Kimetsu no Yaiba: Mugen Ressha-hen')
  assert.ok(fileRes.candidates.includes('Kimetsu no Yaiba'))

  // 3) Sin pistas reales (solo "Anime" + "01.mp4"): no llama a la IA ni inventa títulos
  let called = false
  const emptyRes = await resolveAniDAnimeTitles({
    files: [{ fileName: '01.mp4' }, { fileName: '02.mp4' }],
    rawFolderTitle: 'Anime',
    folderTitle: '',
    isFolder: true,
    aiClient: async () => {
      called = true
      return '{"title":"Naruto"}'
    },
    log: () => {},
    warn: () => {},
  })
  assert.equal(called, false)
  assert.deepEqual(emptyRes.candidates, [])

  // 4) Error 429 activa onRateLimit y usa el título local limpio
  let rateLimited = false
  const fallbackRes = await resolveAniDAnimeTitles({
    files: [{ fileName: '[SubsPlease] Sousou no Frieren - 01 (1080p).mkv' }],
    isFolder: false,
    aiClient: async () => {
      const err = new Error('rate limit')
      err.status = 429
      err.isRateLimit = true
      throw err
    },
    onRateLimit: () => { rateLimited = true },
    log: () => {},
    warn: () => {},
  })
  assert.equal(rateLimited, true)
  assert.equal(fallbackRes.usedAi, false)
  assert.equal(fallbackRes.primary, 'Sousou no Frieren')
})

test('buildAniDDriveMetadata extrae capítulos, temporada, audio y resolución también en archivo único', () => {
  const single = buildAniDDriveMetadata([
    { fileName: '[AnimeLat] Jujutsu Kaisen S02E01 1080p Audio Latino.mkv', mimetype: 'video/x-matroska' },
  ])
  assert.equal(single.chapters, 1)
  assert.deepEqual(single.seasonNumbers, [2])
  assert.deepEqual(single.audio, ['🇲🇽 Español Latino'])
  assert.equal(single.resolution, '1080p')
})
