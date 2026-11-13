import axios from 'axios';
import https from 'https';
import pkg from '@vitalets/google-translate-api';
const { translate } = pkg;
import fs from 'fs';

const httpsAgent = new https.Agent({ keepAlive: false, family: 4 });

const ANILIST_URL = 'https://graphql.anilist.co';

// Pedimos varios resultados y campos extra para poder puntuar mejor
const ANILIST_QUERY = `
  query ($search: String!) {
    Page(page: 1, perPage: 15) {
      media(
        search: $search,
        type: ANIME,
        sort: [SEARCH_MATCH, POPULARITY_DESC]
      ) {
        id
        title {
          romaji
          english
          native
          userPreferred
        }
        description
        episodes
        duration
        status
        season
        seasonYear
        averageScore
        popularity
        favourites
        genres
        format
        studios {
          edges {
            node {
              name
              isAnimationStudio
            }
          }
        }
        coverImage {
          extraLarge
          large
          medium
        }
      }
    }
  }
`;

const handler = async (m, { conn, text, usedPrefix, command, silentNotFound = false }) => {
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

  if (!text) return silentNotFound ? null : m.reply(`*${tradutor.texto1}*`);

  try {
    const result = await fetchFromAniList(text);

    if (!result) return silentNotFound ? null : m.reply(`*${tradutor.texto3}*`);

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

    // Limpieza robusta de la sinopsis (HTML + entidades)
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

    const generosEsp = result.genres?.length
      ? result.genres.map(g => TRADUCCIONES.generos[g] || g).join(', ')
      : 'N/A';

    const puntuacion = result.averageScore
      ? `\n⭐ *Puntuación:* ${(result.averageScore / 10).toFixed(1)}/10`
      : '';

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
🔅 *Temporada:* ${TRADUCCIONES.temporadas[result.season] || 'N/A'}
⏳ *Estado:* ${TRADUCCIONES.estados[result.status] || result.status || 'N/A'}

📜 *Sinopsis:*
${sinopsisFormateada}`;

    const imageUrl = result.images?.jpg?.large_image_url || result.images?.jpg?.image_url;

    if (!imageUrl) {
      return conn.sendMessage(m.chat, { text: AnimeInfo }, { quoted: m });
    }

    let imageBuffer;
    try {
      const { data } = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        httpsAgent
      });
      imageBuffer = Buffer.from(data);
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

// ================= BÚSQUEDA =================

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
  try {
    const response = await axios.post(
      ANILIST_URL,
      { query: ANILIST_QUERY, variables: { search: query } },
      {
        timeout: 25000,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        httpsAgent
      }
    );

    const mediaList = response.data?.data?.Page?.media || [];
    if (!mediaList.length) return null;

    const best = pickBestMatch(mediaList, query);
    return best ? formatAniListResult(best) : null;
  } catch (error) {
    console.warn(`[animeinfo] AniList falló para "${query}":`, error.message);
    return null;
  }
}

// Puntúa cada resultado según qué tan bien coincide con la query
function scoreMatch(media, query) {
  const q = query.toLowerCase().trim();
  const titles = [
    media.title?.romaji,
    media.title?.english,
    media.title?.native,
    media.title?.userPreferred
  ].filter(Boolean).map(t => t.toLowerCase());

  let score = 0;

  // Coincidencia exacta = prioridad máxima
  if (titles.some(t => t === q)) score += 100000;

  // Empieza con la query
  if (titles.some(t => t.startsWith(q))) score += 5000;

  // Contiene la query
  if (titles.some(t => t.includes(q))) score += 1000;

  // La query contiene el título (ej. "naruto shippuden" cuando hay entrada "naruto")
  if (titles.some(t => t.length > 3 && q.includes(t))) score += 500;

  // Popularidad / favoritos como desempate
  score += Math.min(media.popularity || 0, 2000000) / 100;
  score += (media.favourites || 0) / 50;

  // Preferir formatos "normales"
  if (media.format === 'TV') score += 600;
  else if (media.format === 'TV_SHORT') score += 150;
  else if (media.format === 'MOVIE') score += 100;
  else if (media.format === 'ONA' || media.format === 'OVA') score += 50;

  // Preferir ya emitidos / en emisión
  if (media.status === 'FINISHED' || media.status === 'RELEASING') score += 300;
  else if (media.status === 'NOT_YET_RELEASED') score -= 100;

  // Ligero bonus si tiene sinopsis
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

// Convierte el resultado crudo de AniList a la estructura que espera el handler
function formatAniListResult(media) {
  const studios = (media.studios?.edges || [])
    .map(e => e.node)
    .filter(s => s && s.isAnimationStudio !== false);

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
    season: media.season,
    seasonYear: media.seasonYear,
    averageScore: media.averageScore,
    genres: media.genres || [],
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

// ================= TRADUCCIÓN =================

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
