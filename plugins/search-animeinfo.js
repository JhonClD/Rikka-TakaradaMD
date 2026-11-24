import axios from 'axios';
import https from 'https';
import pkg from '@vitalets/google-translate-api';
const { translate } = pkg;
import fs from 'fs';
import { chatCompletion, stripThinkingTags } from '../src/libraries/freellm.js';

const httpsAgent = new https.Agent({ keepAlive: false, family: 4 });

const ANILIST_URL = 'https://graphql.anilist.co';
const TRANSLATE_CACHE_MAX = 300;
const TRANSLATE_MIN_GAP_MS = 250;
const TRANSLATE_COOLDOWN_MS = 15 * 60 * 1000;
const translateCache = new Map();
let translateQueue = Promise.resolve();
let lastTranslateRequestAt = 0;
const translateCooldowns = { ai: 0, google: 0, mymemory: 0 };

function scheduleTranslateRequest(request) {
  const operation = translateQueue.then(async () => {
    const wait = TRANSLATE_MIN_GAP_MS - (Date.now() - lastTranslateRequestAt);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastTranslateRequestAt = Date.now();
    return request();
  });
  translateQueue = operation.catch(() => {});
  return operation;
}

function isTranslationRateLimit(error) {
  const responseError = error?.response?.data?.error;
  return Boolean(error?.isRateLimit) || error?.response?.status === 429 || error?.status === 429 ||
    responseError?.status === 'RESOURCE_EXHAUSTED' ||
    /too many requests|rate.?limit|quota|resource.?exhausted|l[ií]mite diario/i.test(
      `${error?.message || ''} ${responseError?.message || ''}`
    );
}

function cacheTranslation(key, value) {
  if (translateCache.size >= TRANSLATE_CACHE_MAX) {
    translateCache.delete(translateCache.keys().next().value);
  }
  translateCache.set(key, value);
}

function truncateToLength(text, maxLength) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (maxLength <= 0) return '';
  if (normalized.length <= maxLength) return normalized;
  if (maxLength === 1) return '…';

  let clipped = normalized.slice(0, maxLength - 1);
  const wordBoundary = clipped.lastIndexOf(' ');
  if (wordBoundary >= Math.floor(maxLength * 0.6)) clipped = clipped.slice(0, wordBoundary);
  return `${clipped.trimEnd()}…`;
}

async function resumirSinopsisAI(texto, maxCaracteres) {
  const sinopsis = String(texto || '').replace(/^>\s?/gm, '').trim();
  if (!sinopsis || maxCaracteres < 40 || Date.now() < translateCooldowns.ai) return null;

  try {
    const raw = await chatCompletion(
      [
        {
          role: 'system',
          content: `Resume la sinopsis en español en un solo párrafo de máximo ${maxCaracteres} caracteres, contando espacios. Conserva el argumento principal y los datos importantes. No inventes información ni agregues introducciones, explicaciones o comillas; devuelve únicamente el resumen.`,
        },
        { role: 'user', content: sinopsis },
      ],
      { maxTokens: 600, temperature: 0.2, timeoutMs: 30_000, maxRetries: 2 },
    );
    const resumen = stripThinkingTags(raw)
      .replace(/^\s*["'“”]+|["'“”]+\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return resumen || null;
  } catch (error) {
    if (isTranslationRateLimit(error)) {
      translateCooldowns.ai = Date.now() + TRANSLATE_COOLDOWN_MS;
      console.info('[animeinfo] APIsFreeLLM limitó el resumen; se usará un recorte local.');
    } else {
      console.warn('[animeinfo] No se pudo resumir la sinopsis con APIsFreeLLM:', error.message);
    }
    return null;
  }
}

// ====================== HANDLER ======================
const handler = async (m, { conn, text, usedPrefix, command, silentNotFound = false, forceSynopsisSummary = false, aniDMetadata = null }) => {
  const datas = global;
  const idioma = datas.db?.data?.users?.[m.sender]?.language || global.defaultLenguaje || 'es';

  let tradutor;
  try {
    const _translate = JSON.parse(fs.readFileSync(`./src/languages/${idioma}.json`));
    tradutor = _translate.plugins.buscador_animeinfo;
  } catch {
    tradutor = {
      texto1: 'Por favor, ingresa el nombre de un anime.',
      texto3: 'No Se Encontro Información Del Anime',
      texto_procesando: '⏳ Buscando Información...'
    };
  }

  if (!text) {
    if (!silentNotFound) await m.reply(`*${tradutor.texto1}*`);
    return false;
  }

  try {
    const result = await fetchFromAniList(text, { strictMatch: Boolean(aniDMetadata || silentNotFound) });

    if (!result) {
      if (!silentNotFound) await m.reply(`*${tradutor.texto3}*`);
      return false;
    }

    const TRADUCCIONES = {
      estados: {
        'FINISHED': 'Finalizado',
        'RELEASING': 'En emisión',
        'NOT_YET_RELEASED': 'Próximamente',
        'CANCELLED': 'Cancelado',
        'HIATUS': 'En pausa'
      },
      temporadas: {
        'WINTER': 'Invierno',
        'SPRING': 'Primavera',
        'SUMMER': 'Verano',
        'FALL': 'Otoño'
      },
      formatos: {
        'TV': 'Serie de TV',
        'TV_SHORT': 'Serie de TV (corta)',
        'MOVIE': 'Película',
        'SPECIAL': 'Especial',
        'OVA': 'OVA',
        'ONA': 'ONA',
        'MUSIC': 'Musical',
        'MANGA': 'Manga',
        'NOVEL': 'Novela',
        'ONE_SHOT': 'One-shot'
      },
      generos: {
        'Action': 'Acción',
        'Adventure': 'Aventura',
        'Comedy': 'Comedia',
        'Drama': 'Drama',
        'Ecchi': 'Ecchi',
        'Fantasy': 'Fantasía',
        'Horror': 'Terror',
        'Mahou Shoujo': 'Chicas Mágicas',
        'Mecha': 'Mecha',
        'Music': 'Música',
        'Mystery': 'Misterio',
        'Psychological': 'Psicológico',
        'Romance': 'Romance',
        'Sci-Fi': 'Ciencia Ficción',
        'Slice of Life': 'Recuentos de la Vida',
        'Sports': 'Deportes',
        'Supernatural': 'Sobrenatural',
        'Thriller': 'Suspenso',
        'Hentai': 'Hentai',
        'Harem': 'Harem',
        'Isekai': 'Isekai',
        'Josei': 'Josei',
        'Seinen': 'Seinen',
        'Shoujo': 'Shoujo',
        'Shounen': 'Shounen',
        'School': 'Escolar',
        'Military': 'Militar',
        'Historical': 'Histórico',
        'Parody': 'Parodia',
        'Samurai': 'Samurái',
        'Martial Arts': 'Artes Marciales',
        'Super Power': 'Super Poderes',
        'Vampire': 'Vampiros',
        'Demons': 'Demonios',
        'Space': 'Espacial',
        'Game': 'Juegos',
        'Cars': 'Autos',
        'Kids': 'Infantil',
        'Magic': 'Magia',
        'Police': 'Policía'
      }
    };

    // ---- Limpieza robusta de sinopsis ----
    let cleanDesc = result.description
      ? result.description
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n')
          .replace(/<[^>]*>/g, '')
          .replace(/\[Written by MAL Rewrite\]/gi, '')
          .replace(/&quot;/g, '"')
          .replace(/&#0?39;/g, "'")
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&nbsp;/g, ' ')
          .trim()
      : '';

    let sinopsisFormateada = '> No disponible';

    if (cleanDesc) {
      let resumenAniD = null;
      if (forceSynopsisSummary && cleanDesc.length > 420) {
        console.info('[animeinfo] /aniD: intentando resumir la sinopsis larga con APIsFreeLLM.');
        resumenAniD = await resumirSinopsisAI(cleanDesc, 420);
        if (resumenAniD) {
          console.info(`[animeinfo] /aniD: sinopsis resumida a ${resumenAniD.length} caracteres.`);
        } else {
          console.info('[animeinfo] /aniD: APIsFreeLLM no resumió; se usará la traducción de respaldo.');
        }
      }

      if (resumenAniD) {
        sinopsisFormateada = `> ${resumenAniD}`;
      } else {
        const parrafos = cleanDesc.split(/\n+/).map(p => p.trim()).filter(Boolean);
        const traducidos = [];
        for (const p of parrafos) {
          traducidos.push(await traducirTexto(p));
        }
        sinopsisFormateada = traducidos
          .join('\n\n')
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
          .map(l => `> ${l}`)
          .join('\n');
      }
    }

    const titulo = result.title?.romaji || result.title?.english || result.title?.native || 'Desconocido';
    const tituloIngles = result.title?.english && result.title.english !== titulo
      ? `\n🔤 *Título en inglés:* ${result.title.english}`
      : '';
    const tituloNativo = result.title?.native && result.title.native !== titulo
      ? ` (${result.title.native})`
      : '';

    const estudios = result.studios?.length
      ? result.studios.map(s => s.name).join(', ')
      : 'Desconocido';

    const generosEsp = Array.isArray(result.genres) && result.genres.length
      ? result.genres.map(g => TRADUCCIONES.generos[g] || g).join(', ')
      : 'N/A';

    const puntuacion = result.averageScore
      ? `\n⭐ *Puntuación:* ${(result.averageScore / 10).toFixed(1)}/10`
      : '';

    const temporadaEsp = formatTemporada(result, TRADUCCIONES.temporadas);

    const aniDSeasonNumbers = [...new Set((aniDMetadata?.seasonNumbers || [])
      .map(Number)
      .filter(number => Number.isInteger(number) && number > 0))]
      .sort((a, b) => a - b);
    const aniDSeasonText = aniDSeasonNumbers.length
      ? aniDSeasonNumbers.join(', ')
      : result.seasonNumber || 'No detectada';
    const aniDChapters = Number(aniDMetadata?.chapters);
    const aniDChapterText = Number.isFinite(aniDChapters) && aniDChapters > 0
      ? String(aniDChapters)
      : result.episodes || 'No disponible';
    const aniDAudioText = Array.isArray(aniDMetadata?.audio) && aniDMetadata.audio.length
      ? aniDMetadata.audio.join(', ')
      : 'No detectado';
    const aniDSubtitleLine = aniDMetadata?.subtitles
      ? `\n➢ 𝑺υвτiτυℓσs: ${aniDMetadata.subtitles}`
      : '';

    const animeInfoGeneral = `✨*INFORMACIÓN DEL ANIME*✨

🈺 *Título:* ${titulo}${tituloIngles}${tituloNativo}
🏦 *Estudio:* ${estudios}
📆 *Año:* ${result.seasonYear || 'N/A'}
🗂 *Episodios:* ${result.episodes || 'En emisión'}
🎧 *Audio:* Japonés
💬 *Subtítulos:* Español
🏷 *Géneros:* ${generosEsp}
⏱ *Duración:* ${result.duration ? `${result.duration} min` : 'N/A'}${puntuacion}
💽 *Formato:* ${TRADUCCIONES.formatos[result.format] || result.format || 'N/A'}
🔅 *Temporada:* ${temporadaEsp}
⏳ *Estado:* ${TRADUCCIONES.estados[result.status] || result.status || 'N/A'}

📜 *Sinopsis:*
${sinopsisFormateada}`;

    const AnimeInfo = aniDMetadata
      ? [
          `┌─────── “ *🅃ɪᴛᴜʟᴏ ❄️* „ ️━━━━━━━┓`,
          `└➤ ✎~ ${titulo}`,
          `╰───────────────────────`,
          '',
          `➢ 𝑪αρiτυℓσs: ${aniDChapterText}`,
          `➢ 𝑻ємρσrα∂α: ${aniDSeasonText}`,
          `➢ 𝑮єทєrσ: ${generosEsp}`,
          `➢ 𝑨υ∂iσ: ${aniDAudioText}${aniDSubtitleLine}`,
          `➢ 𝑹єsσℓυciσท: ${aniDMetadata.resolution || 'No detectada'}`,
          '',
          '❐✼❑✼❑✼❑✼❒✼❐✼❑✼❒✼❑❐✼❑✼❑✼❑✼',
          '',
          '🔮 𝙎𝘪𝙣𝙤𝙥𝙨𝙞𝙨:',
          '',
          sinopsisFormateada,
          '',
          '*╔═══ ≪ •❈• ≫ ═══╗*',
          '                 𝗖𝗜𝗗',
          '*╚═══ ≪ •❈• ≫ ═══╝*',
        ].join('\n')
      : animeInfoGeneral;

    const imageUrl = result.images?.jpg?.large_image_url || result.images?.jpg?.image_url;

    if (!imageUrl) {
      await conn.sendMessage(m.chat, { text: AnimeInfo }, { quoted: m });
      return true;
    }

    let imageBuffer;
    try {
      imageBuffer = await downloadImage(imageUrl);
    } catch (imgErr) {
      console.warn('[animeinfo] Descarga de imagen falló:', imgErr.message);
      await conn.sendMessage(
        m.chat,
        { text: AnimeInfo + '\n\n⚠️ _No se pudo cargar la imagen._' },
        { quoted: m }
      );
      return true;
    }

    const MAX_CAPTION = 950;
    let captionText = AnimeInfo;
    if (captionText.length > MAX_CAPTION) {
      const synopsisPrefixLength = AnimeInfo.length - sinopsisFormateada.length;
      const synopsisBudget = MAX_CAPTION - synopsisPrefixLength - 2;
      let synopsis = await resumirSinopsisAI(sinopsisFormateada, synopsisBudget);
      if (!synopsis) synopsis = sinopsisFormateada.replace(/^>\s?/gm, '').replace(/\s+/g, ' ').trim();
      synopsis = truncateToLength(synopsis, synopsisBudget);
      captionText = `${AnimeInfo.slice(0, synopsisPrefixLength)}${synopsis ? `> ${synopsis}` : ''}`;
    }

    const caption = captionText.length > MAX_CAPTION
      ? captionText.slice(0, MAX_CAPTION - 3) + '...'
      : captionText;

    await conn.sendMessage(
      m.chat,
      { image: imageBuffer, caption },
      { quoted: m }
    );
    return true;

  } catch (e) {
    if (silentNotFound) {
      console.warn(`[animeinfo] Búsqueda silenciosa falló para "${text}":`, e?.message || e);
      return false;
    }

    let errorMsg = `*${tradutor.texto3}*`;

    if (e.message?.includes('timeout')) {
      errorMsg += '\n\n⏱️ _La búsqueda tardó demasiado. Intenta nuevamente._';
    } else if (e.message?.includes('Network') || e.message?.includes('TLS') || e.message?.includes('socket')) {
      errorMsg += '\n\n🌐 _Error de conexión con el servidor. Intenta nuevamente en unos segundos._';
    } else {
      errorMsg += `\n\n📝 _Detalles: ${e.message || 'Error desconocido'}_`;
    }

    await m.reply(errorMsg);
    return false;
  }
};

// ====================== BÚSQUEDA ======================

const ANILIST_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0'
};

async function searchAniListCandidates(query) {
  try {
    const searchResponse = await axios.post(
      ANILIST_URL,
      {
        query: `
          query ($search: String!) {
            Page(page: 1, perPage: 20) {
              media(search: $search, type: ANIME) {
                id
                title { romaji english native userPreferred }
                synonyms
                format
                status
                popularity
                favourites
                seasonYear
              }
            }
          }
        `,
        variables: { search: query }
      },
      { timeout: 25000, headers: ANILIST_HEADERS, httpsAgent }
    );

    return searchResponse.data?.data?.Page?.media || [];
  } catch (error) {
    console.warn(`[animeinfo] AniList falló para "${query}":`, error.message);
    if (error.response?.data) {
      console.warn('[animeinfo] AniList error:', JSON.stringify(error.response.data));
    }
    return [];
  }
}

async function fetchAniListDetail(best) {
  try {
    const detailResponse = await axios.post(
      ANILIST_URL,
      {
        query: `
          query ($id: Int!) {
            Media(id: $id, type: ANIME) {
              id
              title { romaji english native }
              description
              episodes
              duration
              status
              season
              seasonYear
              startDate { year month day }
              averageScore
              genres
              format
              studios {
                edges {
                  isMain
                  node { name isAnimationStudio }
                }
              }
              relations {
                edges {
                  relationType
                  node {
                    id
                    type
                    format
                    title { romaji english native }
                    startDate { year month day }
                  }
                }
              }
              coverImage { extraLarge large medium }
            }
          }
        `,
        variables: { id: best.id }
      },
      { timeout: 25000, headers: ANILIST_HEADERS, httpsAgent }
    );

    const media = detailResponse.data?.data?.Media;
    return formatAniListResult(media || best);
  } catch (error) {
    console.warn(`[animeinfo] AniList detalle falló para ID ${best.id}:`, error.message);
    return formatAniListResult(best);
  }
}

async function fetchFromJikan(queryText, { strictMatch = false } = {}) {
  const queries = normalizeSearchQueries(queryText).slice(0, 2);
  const byId = new Map();
  let bestPick = null;

  for (const q of queries) {
    try {
      const { data } = await axios.get('https://api.jikan.moe/v4/anime', {
        params: { q, limit: 10 },
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        httpsAgent,
      });
      const items = Array.isArray(data?.data) ? data.data : [];
      for (const item of items) {
        if (!item?.mal_id || byId.has(item.mal_id)) continue;
        byId.set(item.mal_id, {
          id: item.mal_id,
          title: {
            romaji: item.title,
            english: item.title_english,
            native: item.title_japanese,
            userPreferred: item.title,
          },
          synonyms: [
            ...(Array.isArray(item.title_synonyms) ? item.title_synonyms : []),
            ...(Array.isArray(item.titles) ? item.titles.map(t => t?.title).filter(Boolean) : []),
          ],
          format: String(item.type || '').toUpperCase() || null,
          status: item.airing ? 'RELEASING' : (item.status === 'Not yet aired' ? 'NOT_YET_RELEASED' : 'FINISHED'),
          popularity: Number(item.members) || 0,
          favourites: Number(item.favorites) || 0,
          season: item.season ? String(item.season).toUpperCase() : null,
          seasonYear: item.year || item.aired?.prop?.from?.year || null,
          episodes: item.episodes || null,
          duration: parseInt(String(item.duration || ''), 10) || null,
          averageScore: item.score ? Math.round(item.score * 10) : null,
          description: item.synopsis || null,
          genres: Array.isArray(item.genres) ? item.genres.map(g => g?.name).filter(Boolean) : [],
          studios: Array.isArray(item.studios) ? item.studios.map(s => ({ name: s?.name })).filter(s => s.name) : [],
          images: {
            jpg: {
              large_image_url: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url,
              image_url: item.images?.jpg?.image_url,
            },
          },
        });
      }
      bestPick = pickBestAnimeMatch([...byId.values()], queryText);
      if (bestPick?.isStrongMatch) break;
    } catch (error) {
      console.warn(`[animeinfo] Jikan falló para "${q}":`, error.message);
    }
  }

  if (!bestPick?.media || !bestPick.hasTitleMatch) return null;
  if (strictMatch && !bestPick.hasTitleMatch) return null;

  const m = bestPick.media;
  return {
    title: { romaji: m.title.romaji, english: m.title.english, native: m.title.native },
    description: m.description,
    episodes: m.episodes,
    duration: m.duration,
    status: m.status,
    season: m.season,
    seasonYear: m.seasonYear,
    seasonNumber: resolveSeasonNumber({ title: m.title, format: m.format, relations: { edges: [] } }),
    averageScore: m.averageScore,
    genres: m.genres,
    studios: m.studios,
    format: m.format,
    images: m.images,
  };
}

async function fetchFromAniList(queryText, { strictMatch = false } = {}) {
  const queries = normalizeSearchQueries(queryText);
  const byId = new Map();
  let firstAniListResult = null;
  let bestPick = null;

  for (const q of queries) {
    const mediaList = await searchAniListCandidates(q);
    if (!mediaList.length) continue;

    if (!firstAniListResult) firstAniListResult = mediaList[0];
    for (const item of mediaList) {
      if (item?.id && !byId.has(item.id)) byId.set(item.id, item);
    }

    bestPick = pickBestAnimeMatch([...byId.values()], queryText);
    if (bestPick?.isStrongMatch) break;
  }

  // Si AniList no devolvió una coincidencia real de título, consultar Jikan/MAL
  // antes de rendirse o aceptar un resultado flojo.
  if (!bestPick?.hasTitleMatch) {
    const jikanResult = await fetchFromJikan(queryText, { strictMatch });
    if (jikanResult) return jikanResult;
  }

  if (!bestPick?.media?.id) return null;

  if (strictMatch && !bestPick.hasTitleMatch) {
    return null;
  }

  const chosen = bestPick.titleScore > 0
    ? bestPick.media
    : (firstAniListResult || bestPick.media);

  return fetchAniListDetail(chosen);
}

const DECORATIVE_SYMBOL_RE = /[★☆♥♡♪♫✦✧❖◆◇•・×✕✖✚✪✩✯✰⭐✨～]/u;
const ROMAN_SEASONS = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

function normalizeTitleForMatch(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractExplicitSeasonNumber(value) {
  const text = String(value ?? '');
  let match;
  if ((match = text.match(/\b(\d{1,2})(?:st|nd|rd|th|[ªº])?\s+season\b/i))) return Number(match[1]);
  if ((match = text.match(/\b(?:season|temporada|temp\.?)\s*0*(\d{1,2})\b/i))) return Number(match[1]);
  if ((match = text.match(/\bS0*(\d{1,2})(?:\b|E\d)/i))) return Number(match[1]);
  if ((match = text.match(/\b(II|III|IV|V|VI|VII|VIII|IX|X)\b/))) {
    return ROMAN_SEASONS[match[1].toLowerCase()] || null;
  }
  return null;
}

export function normalizeSearchQueries(raw) {
  const base = String(raw ?? '').trim();
  if (!base) return [];

  const withoutSymbols = base
    .replace(/[★☆♥♡♪♫✦✧❖◆◇•・×✕✖✚✪✩✯✰⭐✨～]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const swappedStar = base.includes('★')
    ? base.replace(/★/g, '☆')
    : (base.includes('☆') ? base.replace(/☆/g, '★') : '');

  const list = [];
  const push = (val) => {
    const clean = String(val || '').replace(/\s+/g, ' ').trim();
    if (clean && !list.includes(clean)) list.push(clean);
  };

  if (DECORATIVE_SYMBOL_RE.test(base) && withoutSymbols && withoutSymbols !== base) {
    push(withoutSymbols);
    if (swappedStar) push(swappedStar);
    push(base);
  } else {
    push(base);
    if (withoutSymbols && withoutSymbols !== base) push(withoutSymbols);
  }

  const sinTipo = (withoutSymbols || base)
    .replace(/\b(anime|manga|serie|series|pelicula|película|movie)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  push(sinTipo);

  const sinAnio = sinTipo
    .replace(/[([\s]*\b(19|20)\d{2}\b[\])\s]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  push(sinAnio);

  push(normalizeTitleForMatch(sinAnio));

  const beforeColon = (withoutSymbols || base).split(/\s*[:—–]\s*/)[0]?.trim();
  if (beforeColon && beforeColon.length >= 4 && beforeColon !== base) {
    push(beforeColon);
  }

  return list.slice(0, 5);
}

function scoreSingleTitle(candidateTitle, queryInfo, { isSynonym = false } = {}) {
  const tNorm = normalizeTitleForMatch(candidateTitle);
  if (!tNorm) return 0;
  const tCompact = tNorm.replace(/\s+/g, '');
  const tTokens = tNorm.split(' ').filter(Boolean);

  const { qNorm, qCompact, qTokens } = queryInfo;
  if (!qNorm) return 0;

  const penalty = isSynonym ? 0.92 : 1;

  if (tNorm === qNorm || (qCompact.length >= 3 && tCompact === qCompact)) {
    return Math.round(100_000 * penalty);
  }
  if (tNorm.startsWith(`${qNorm} `)) {
    const lengthBonus = Math.round((qNorm.length / tNorm.length) * 5_000);
    return Math.round((60_000 + lengthBonus) * penalty);
  }
  if (qCompact.length >= 5 && tCompact.startsWith(qCompact)) {
    return Math.round(52_000 * penalty);
  }
  if (qNorm.length >= 4 && (` ${tNorm} `).includes(` ${qNorm} `)) {
    return Math.round(40_000 * penalty);
  }
  if (qCompact.length >= 6 && tCompact.includes(qCompact)) {
    return Math.round(32_000 * penalty);
  }
  if (tNorm.length >= 4 && (` ${qNorm} `).includes(` ${tNorm} `)) {
    const coverage = tTokens.length / Math.max(1, qTokens.length);
    return Math.round((24_000 + coverage * 12_000) * penalty);
  }

  const tSet = new Set(tTokens);
  let exactMatches = 0;
  let prefixMatches = 0;
  for (const qt of qTokens) {
    if (tSet.has(qt)) {
      exactMatches += 1;
    } else if (qt.length >= 5 && tTokens.some(tt => tt.length >= 5 && (tt.startsWith(qt) || qt.startsWith(tt)))) {
      prefixMatches += 0.7;
    }
  }
  const effectiveMatches = exactMatches + prefixMatches;
  if (effectiveMatches <= 0) return 0;

  const coverage = effectiveMatches / qTokens.length;
  const precision = effectiveMatches / Math.max(1, tTokens.length);

  if (exactMatches === qTokens.length) {
    return Math.round((35_000 + precision * 10_000) * penalty);
  }
  if (coverage >= 0.75) {
    return Math.round((22_000 * coverage + precision * 4_000) * penalty);
  }
  if (qTokens.length >= 2 && exactMatches === 1 && coverage <= 0.5) {
    return Math.round((3_000 + precision * 1_500) * penalty);
  }
  return Math.round((12_000 * coverage + precision * 2_000) * penalty);
}

export function scoreAnimeMatch(media, query) {
  const qNorm = normalizeTitleForMatch(query);
  const qCompact = qNorm.replace(/\s+/g, '');
  const qTokens = qNorm ? qNorm.split(' ').filter(Boolean) : [];
  const queryInfo = { qNorm, qCompact, qTokens };

  const primaryTitles = [
    media?.title?.romaji,
    media?.title?.english,
    media?.title?.native,
    media?.title?.userPreferred,
  ].filter(Boolean);
  const synonyms = Array.isArray(media?.synonyms) ? media.synonyms.filter(Boolean) : [];

  let titleScore = 0;
  for (const t of primaryTitles) {
    const s = scoreSingleTitle(t, queryInfo, { isSynonym: false });
    if (s > titleScore) titleScore = s;
  }
  for (const t of synonyms) {
    const s = scoreSingleTitle(t, queryInfo, { isSynonym: true });
    if (s > titleScore) titleScore = s;
  }

  const querySeason = extractExplicitSeasonNumber(query);
  const mediaSeasons = [...primaryTitles, ...synonyms]
    .map(extractExplicitSeasonNumber)
    .filter(n => Number.isInteger(n) && n > 0);
  const mediaSeason = mediaSeasons[0] || null;

  let seasonAdjust = 0;
  if (titleScore > 0) {
    if (querySeason && querySeason >= 2) {
      if (mediaSeason === querySeason) seasonAdjust += 10_000;
      else if (mediaSeason !== querySeason) seasonAdjust -= 5_000;
    } else if (!querySeason && mediaSeason && mediaSeason >= 2) {
      seasonAdjust -= 2_000;
    }
  }

  const popularityTieBreak = Math.round(Math.log10(Math.max(1, Number(media?.popularity) || 1)) * 120);
  const favouritesTieBreak = Math.round(Math.log10(Math.max(1, Number(media?.favourites) || 1)) * 30);

  let formatTieBreak = 0;
  if (media?.format === 'TV') formatTieBreak = 120;
  else if (media?.format === 'MOVIE') formatTieBreak = 90;
  else if (media?.format === 'ONA' || media?.format === 'OVA') formatTieBreak = 60;
  else if (media?.format === 'TV_SHORT') formatTieBreak = 50;

  let statusTieBreak = 0;
  if (media?.status === 'FINISHED' || media?.status === 'RELEASING') statusTieBreak = 80;
  else if (media?.status === 'NOT_YET_RELEASED') statusTieBreak = 20;

  const score = titleScore + seasonAdjust + popularityTieBreak + favouritesTieBreak + formatTieBreak + statusTieBreak;

  return {
    score,
    titleScore,
    isStrongMatch: titleScore >= 30_000,
    hasTitleMatch: titleScore >= 10_000,
  };
}

export function pickBestAnimeMatch(mediaList, query) {
  if (!Array.isArray(mediaList) || !mediaList.length) return null;
  let bestMedia = null;
  let bestMetrics = null;
  for (const media of mediaList) {
    const metrics = scoreAnimeMatch(media, query);
    if (!bestMetrics || metrics.score > bestMetrics.score) {
      bestMetrics = metrics;
      bestMedia = media;
    }
  }
  return bestMedia ? { media: bestMedia, ...bestMetrics } : null;
}

function formatAniListResult(media) {
  const edges = media.studios?.edges || [];

  // ---- Estudios (3 niveles de fallback) ----
  let studios = edges
    .filter(e => e.isMain === true)
    .map(e => e.node)
    .filter(s => s && s.name);

  if (!studios.length) {
    studios = edges
      .map(e => e.node)
      .filter(s => s && s.name && s.isAnimationStudio !== false);
  }

  if (!studios.length) {
    studios = edges.map(e => e.node).filter(s => s && s.name);
  }

  const season = resolveSeason(media);
  const seasonYear = media.seasonYear || media.startDate?.year || null;
  const seasonNumber = resolveSeasonNumber(media);

  return {
    title: {
      romaji: media.title?.romaji,
      english: media.title?.english,
      native: media.title?.native
    },
    description: media.description,
    episodes: media.episodes,
    duration: media.duration,
    status: media.status,
    season,
    seasonYear,
    seasonNumber,
    averageScore: media.averageScore,
    genres: Array.isArray(media.genres) ? media.genres : [],
    studios,
    format: media.format,
    images: {
      jpg: {
        large_image_url: media.coverImage?.extraLarge || media.coverImage?.large,
        image_url: media.coverImage?.medium
      }
    }
  };
}

// Deriva la temporada desde season o startDate.month
function resolveSeason(media) {
  if (media.season) return String(media.season).toUpperCase();
  const month = media.startDate?.month;
  if (month && month >= 1 && month <= 12) {
    if (month <= 3)  return 'WINTER';
    if (month <= 6)  return 'SPRING';
    if (month <= 9)  return 'SUMMER';
    return 'FALL';
  }
  return null;
}

// Detecta el número de temporada (T1, T2, T3...)
function resolveSeasonNumber(media) {
  const titles = [
    media.title?.romaji,
    media.title?.english,
    media.title?.native
  ].filter(Boolean);

  const romanMap = { II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

  // 1) Detección directa por título
  for (const t of titles) {
    let m;

    if ((m = t.match(/(\d+)(?:st|nd|rd|th)\s+season/i))) return parseInt(m[1]);
    if ((m = t.match(/season\s+(\d+)/i)))               return parseInt(m[1]);
    if ((m = t.match(/temporada\s+(\d+)/i)))            return parseInt(m[1]);
    if ((m = t.match(/part\s+(\d+)/i)) && media.format === 'TV') return parseInt(m[1]) + 1;
    if ((m = t.match(/\b(II|III|IV|V|VI|VII|VIII|IX|X)\b/))) return romanMap[m[1]];
  }

  // 2) Conteo de precuelas TV directas
  const edges = media.relations?.edges || [];
  const tvPrequels = edges.filter(e =>
    (e.relationType === 'PREQUEL' || e.relationType === 'PARENT') &&
    e.node?.type === 'ANIME' &&
    (e.node?.format === 'TV' || e.node?.format === 'TV_SHORT')
  );

  if (tvPrequels.length > 0) return tvPrequels.length + 1;

  // 3) Si es TV sin precuelas, es T1
  if (media.format === 'TV' || media.format === 'TV_SHORT') return 1;

  return null;
}

// Formatea la temporada: "Temporada 2 (Verano)" / "Verano" / "Temporada 2"
function formatTemporada(result, traducciones) {
  const estacion = result.season
    ? (traducciones[result.season] ||
       traducciones[String(result.season).toUpperCase()] ||
       result.season)
    : null;

  const num = result.seasonNumber;

  if (num && estacion) return `Temporada ${num} (${estacion})`;
  if (num)             return `Temporada ${num}`;
  if (estacion)        return estacion;
  return 'N/A';
}

// ====================== IMAGEN ======================

async function downloadImage(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const { data } = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        httpsAgent,
        maxRedirects: 5
      });
      return Buffer.from(data);
    } catch (err) {
      lastErr = err;
      const wait = /TLS|socket|ECONNRESET|ETIMEDOUT/.test(err.message || '')
        ? 1500 * Math.pow(2, i)
        : 500;
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ====================== TRADUCCIÓN ======================

async function traducirTexto(texto) {
  if (!texto || texto === 'No disponible') return texto || 'No disponible';

  const MAX_LENGTH = 800;

  const oraciones = texto.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [texto];
  const fragmentos = [];
  let actual = '';

  for (const oracion of oraciones) {
    const candidato = (actual + ' ' + oracion).trim();
    if (candidato.length > MAX_LENGTH) {
      if (actual.trim()) fragmentos.push(actual.trim());
      actual = oracion;
      while (actual.length > MAX_LENGTH) {
        fragmentos.push(actual.slice(0, MAX_LENGTH));
        actual = actual.slice(MAX_LENGTH);
      }
    } else {
      actual = candidato;
    }
  }
  if (actual.trim()) fragmentos.push(actual.trim());

  const traducidos = [];
  for (const fragmento of fragmentos) {
    const cacheKey = fragmento.trim();
    if (translateCache.has(cacheKey)) {
      traducidos.push(translateCache.get(cacheKey));
      continue;
    }

    let resultado = null;

    if (Date.now() >= translateCooldowns.ai) {
      try {
        const raw = await chatCompletion(
          [
            {
              role: 'system',
              content: 'Traduce al español el texto recibido. Detecta automáticamente el idioma de origen. Devuelve únicamente la traducción, sin explicaciones, comillas ni texto adicional.',
            },
            { role: 'user', content: fragmento },
          ],
          { maxTokens: 1200, temperature: 0.1, timeoutMs: 30_000, maxRetries: 2 },
        );
        resultado = stripThinkingTags(raw)
          .replace(/^\s*["'“”]+|["'“”]+\s*$/g, '')
          .trim() || null;
        if (!resultado) throw new Error('APIsFreeLLM devolvió una respuesta vacía');
      } catch (err) {
        if (isTranslationRateLimit(err)) {
          translateCooldowns.ai = Date.now() + TRANSLATE_COOLDOWN_MS;
          console.info('[animeinfo] APIsFreeLLM limitó las consultas; se pausará temporalmente.');
        } else {
          console.warn('[animeinfo] APIsFreeLLM falló:', err.message);
        }
      }
    }

    if (!resultado && Date.now() >= translateCooldowns.google) {
      try {
        const res = await scheduleTranslateRequest(() => {
          if (Date.now() < translateCooldowns.google) return null;
          return translate(fragmento, { to: 'es', from: 'auto' });
        });
        resultado = res?.text || null;
      } catch (err1) {
        if (isTranslationRateLimit(err1)) {
          translateCooldowns.google = Date.now() + TRANSLATE_COOLDOWN_MS;
          console.info('[animeinfo] Google Translate limitó las consultas; se pausará temporalmente.');
        } else {
          console.warn('[animeinfo] Google Translate falló:', err1.message);
        }
      }
    }

    if (!resultado && Date.now() >= translateCooldowns.mymemory) {
      try {
        const res = await scheduleTranslateRequest(() => {
          if (Date.now() < translateCooldowns.mymemory) return null;
          return axios.get('https://api.mymemory.translated.net/get', {
            params: { q: fragmento, langpair: 'en|es' },
            timeout: 8000,
            httpsAgent
          });
        });
        if (!res) {
          traducidos.push(fragmento);
          continue;
        }
        if (res.data?.responseStatus === 200 && res.data?.responseData?.translatedText) {
          resultado = res.data.responseData.translatedText;
        } else if (Number(res.data?.responseStatus) === 429) {
          const error = new Error('MyMemory respondió HTTP 429');
          error.status = 429;
          throw error;
        } else {
          throw new Error('MyMemory no disponible');
        }
      } catch (err2) {
        if (isTranslationRateLimit(err2)) {
          translateCooldowns.mymemory = Date.now() + TRANSLATE_COOLDOWN_MS;
          console.info('[animeinfo] MyMemory limitó las consultas; se pausará temporalmente.');
        } else {
          console.warn('[animeinfo] MyMemory falló:', err2.message);
        }
      }
    }

    if (resultado) {
      cacheTranslation(cacheKey, resultado);
      traducidos.push(resultado);
    } else {
      // La ficha debe seguir disponible aunque los traductores externos estén limitados.
      traducidos.push(fragmento);
    }
  }

  return traducidos.join(' ').replace(/\s+/g, ' ').trim();
}

handler.help = ['anime <nombre>', 'animeinfo <nombre>'];
handler.tags = ['buscadores'];
handler.command = /^(anime|animeinfo)$/i;

export default handler;
