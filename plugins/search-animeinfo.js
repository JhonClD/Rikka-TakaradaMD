import axios from 'axios';
import https from 'https';
import pkg from '@vitalets/google-translate-api';
const { translate } = pkg;
import fs from 'fs';

const httpsAgent = new https.Agent({ keepAlive: false, family: 4 });

const ANILIST_URL = 'https://graphql.anilist.co';

// ====================== HANDLER ======================
const handler = async (m, { conn, text, usedPrefix, command }) => {
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

  if (!text) return m.reply(`*${tradutor.texto1}*`);

  try {
    const result = await fetchFromAniList(text);

    if (!result) return m.reply(`*${tradutor.texto3}*`);

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

    const AnimeInfo = `✨*INFORMACIÓN DEL ANIME*✨

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

    const imageUrl = result.images?.jpg?.large_image_url || result.images?.jpg?.image_url;

    if (!imageUrl) {
      return conn.sendMessage(m.chat, { text: AnimeInfo }, { quoted: m });
    }

    let imageBuffer;
    try {
      imageBuffer = await downloadImage(imageUrl);
    } catch (imgErr) {
      console.warn('[animeinfo] Descarga de imagen falló:', imgErr.message);
      return conn.sendMessage(
        m.chat,
        { text: AnimeInfo + '\n\n⚠️ _No se pudo cargar la imagen._' },
        { quoted: m }
      );
    }

    const MAX_CAPTION = 950;
    const caption = AnimeInfo.length > MAX_CAPTION
      ? AnimeInfo.slice(0, MAX_CAPTION - 3) + '...'
      : AnimeInfo;

    const fueTruncado = AnimeInfo.length > MAX_CAPTION;

    await conn.sendMessage(
      m.chat,
      { image: imageBuffer, caption },
      { quoted: m }
    );

    if (fueTruncado) {
      const restante = AnimeInfo.slice(MAX_CAPTION - 3);
      for (let i = 0; i < restante.length; i += 4000) {
        await conn.sendMessage(
          m.chat,
          { text: restante.slice(i, i + 4000) },
          { quoted: m }
        );
      }
    }

  } catch (e) {
    let errorMsg = `*${tradutor.texto3}*`;

    if (e.message?.includes('timeout')) {
      errorMsg += '\n\n⏱️ _La búsqueda tardó demasiado. Intenta nuevamente._';
    } else if (e.message?.includes('Network') || e.message?.includes('TLS') || e.message?.includes('socket')) {
      errorMsg += '\n\n🌐 _Error de conexión con el servidor. Intenta nuevamente en unos segundos._';
    } else {
      errorMsg += `\n\n📝 _Detalles: ${e.message || 'Error desconocido'}_`;
    }

    m.reply(errorMsg);
  }
};

// ====================== BÚSQUEDA ======================

// Genera variantes de la query por si la original no encuentra nada
function normalizeQueries(raw) {
  const base = raw.trim();
  const list = [base];

  const sinTipo = base
    .replace(/\b(anime|manga|serie|series|pelicula|película|movie)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (sinTipo && sinTipo !== base) list.push(sinTipo);

  const sinAnio = sinTipo.replace(/[\(\[]?\b(19|20)\d{2}\b[\)\]]?/g, '').replace(/\s+/g, ' ').trim();
  if (sinAnio && !list.includes(sinAnio)) list.push(sinAnio);

  const limpia = sinAnio.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (limpia && !list.includes(limpia)) list.push(limpia);

  return [...new Set(list)].filter(Boolean);
}

async function fetchFromAniList(queryText) {
  const queries = normalizeQueries(queryText);

  for (const q of queries) {
    const result = await trySearchAniList(q);
    if (result) return result;
  }
  return null;
}

async function trySearchAniList(query) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0'
  };

  try {
    // ---------- FASE 1: búsqueda ligera ----------
    const searchResponse = await axios.post(
      ANILIST_URL,
      {
        query: `
          query ($search: String!) {
            Page(page: 1, perPage: 20) {
              media(search: $search, type: ANIME) {
                id
                title { romaji english native userPreferred }
                format
                status
                popularity
                seasonYear
              }
            }
          }
        `,
        variables: { search: query }
      },
      { timeout: 25000, headers, httpsAgent }
    );

    const mediaList = searchResponse.data?.data?.Page?.media || [];
    if (!mediaList.length) return null;

    const best = pickBestMatch(mediaList, query);
    if (!best?.id) return null;

    // ---------- FASE 2: detalle completo por ID ----------
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
      { timeout: 25000, headers, httpsAgent }
    );

    const media = detailResponse.data?.data?.Media;
    if (!media) {
      // Fallback: al menos devolvemos lo de la fase 1
      return formatAniListResult(best);
    }

    return formatAniListResult(media);
  } catch (error) {
    console.warn(`[animeinfo] AniList falló para "${query}":`, error.message);
    if (error.response?.data) {
      console.warn('[animeinfo] AniList error:', JSON.stringify(error.response.data));
    }
    return null;
  }
}

function scoreMatch(media, query) {
  const q = query.toLowerCase().trim();
  const titles = [
    media.title?.romaji,
    media.title?.english,
    media.title?.native,
    media.title?.userPreferred
  ].filter(Boolean).map(t => t.toLowerCase());

  let score = 0;

  if (titles.some(t => t === q)) score += 100000;
  if (titles.some(t => t.startsWith(q))) score += 5000;
  if (titles.some(t => t.includes(q))) score += 1000;
  if (titles.some(t => t.length > 3 && q.includes(t))) score += 500;

  score += Math.min(media.popularity || 0, 2000000) / 100;
  score += (media.favourites || 0) / 50;

  if (media.format === 'TV') score += 600;
  else if (media.format === 'TV_SHORT') score += 150;
  else if (media.format === 'MOVIE') score += 100;
  else if (media.format === 'ONA' || media.format === 'OVA') score += 50;

  if (media.status === 'FINISHED' || media.status === 'RELEASING') score += 300;
  else if (media.status === 'NOT_YET_RELEASED') score -= 100;

  if (media.description) score += 20;

  return score;
}

function pickBestMatch(mediaList, query) {
  let best = mediaList[0];
  let bestScore = -Infinity;
  for (const media of mediaList) {
    const s = scoreMatch(media, query);
    if (s > bestScore) {
      bestScore = s;
      best = media;
    }
  }
  return best;
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
    try {
      const res = await translate(fragmento, { to: 'es', from: 'auto' });
      traducidos.push(res.text);
    } catch (err1) {
      console.warn('[translate] Google falló, probando MyMemory:', err1.message);
      try {
        const res = await axios.get('https://api.mymemory.translated.net/get', {
          params: { q: fragmento, langpair: 'en|es' },
          timeout: 8000,
          httpsAgent
        });
        if (res.data?.responseStatus === 200 && res.data?.responseData?.translatedText) {
          traducidos.push(res.data.responseData.translatedText);
        } else {
          throw new Error('MyMemory no disponible');
        }
      } catch (err2) {
        console.warn('[translate] MyMemory falló:', err2.message);
        traducidos.push(fragmento);
      }
    }
  }

  return traducidos.join(' ').replace(/\s+/g, ' ').trim();
}

handler.help = ['anime <nombre>', 'animeinfo <nombre>'];
handler.tags = ['buscadores'];
handler.command = /^(anime|animeinfo)$/i;

export default handler;
