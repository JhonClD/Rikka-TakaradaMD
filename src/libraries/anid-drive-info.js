const VIDEO_EXTENSION = /\.(?:mp4|mkv|avi|mov|webm|m4v|ts|m2ts)$/i

function normalizeLabel(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isVideoFile(file) {
  return VIDEO_EXTENSION.test(String(file?.fileName || '')) ||
    /^video\//i.test(String(file?.mimetype || ''))
}

function extractSeasonNumbers(values) {
  const patterns = [
    /\b(?:season|temporada|temp)\s*0*(\d{1,2})\b/gi,
    /\b0*(\d{1,2})(?:st|nd|rd|th|[ªº])?\s+season\b/gi,
    /\bS0*(\d{1,2})(?=E\d{1,3}\b|\b)/gi,
    /\bT0*(\d{1,2})(?=E\d{1,3}\b|\b)/gi,
  ]
  const seasons = new Set()

  for (const value of values) {
    const text = normalizeLabel(value)
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        const number = Number(match[1])
        if (Number.isInteger(number) && number > 0 && number <= 99) seasons.add(number)
      }
    }
  }

  return [...seasons].sort((a, b) => a - b)
}

function detectResolution(files) {
  const counts = new Map()
  const pixels = { '4320p': 4320, '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '576p': 576, '480p': 480, '360p': 360, '240p': 240 }

  for (const file of files) {
    const name = normalizeLabel(file?.fileName)
    const match = name.match(/\b(4320|2160|1440|1080|720|576|480|360|240)\s*p\b|\b(8k|4k|uhd|fhd)\b/i)
    if (!match) continue
    const raw = String(match[1] || match[2]).toLowerCase()
    const resolution = ({ '8k': '4320p', '4k': '2160p', uhd: '2160p', fhd: '1080p' })[raw] || `${raw}p`
    counts.set(resolution, (counts.get(resolution) || 0) + 1)
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (pixels[b[0]] || 0) - (pixels[a[0]] || 0))[0]?.[0] || 'No detectada'
}

export function buildAniDDriveMetadata(files = [], folderTitle = '') {
  const list = Array.isArray(files) ? files : []
  const videoFiles = list.filter(isVideoFile)
  const inspectedFiles = videoFiles.length ? videoFiles : list
  const labels = normalizeLabel([folderTitle, ...inspectedFiles.map(file => file?.fileName)].filter(Boolean).join(' '))

  const hasSpanishSubtitles = /\b(?:sub(?:titulos?|titulado|titles?|titled)?\s*(?:espanol|spanish|esp)|(?:espanol|spanish)\s*(?:subtitulos?|subtitulado|subtitled)|vost(?:es)?|vose)\b/.test(labels) ||
    (/\bsub\b/.test(labels) && /\b(?:espanol|spanish|esp)\b/.test(labels))
  const hasLatinoAudio = /\b(?:espanol\s+(?:latino|latam)|audio\s+latino|latino(?:\s+(?:audio|dub))?|latam\s+dub)\b/.test(labels)
  const hasCastellanoAudio = /\b(?:castellano|espanol\s+(?:castellano|de\s+espana)|castilian)\b/.test(labels)

  const audio = []
  if (hasSpanishSubtitles) audio.push('🇯🇵 Japonés')
  if (hasLatinoAudio) audio.push('🇲🇽 Español Latino')
  if (hasCastellanoAudio) audio.push('🇪🇸 Español Castellano')
  if (!audio.length) audio.push('No detectado')

  return {
    chapters: videoFiles.length || list.length,
    seasonNumbers: extractSeasonNumbers([folderTitle, ...inspectedFiles.map(file => file?.fileName)]),
    audio,
    subtitles: hasSpanishSubtitles && !hasLatinoAudio && !hasCastellanoAudio ? 'Español' : null,
    resolution: detectResolution(inspectedFiles),
  }
}
