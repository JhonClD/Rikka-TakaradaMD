import axios from 'axios';
import https from 'https';
import pkg from '@vitalets/google-translate-api';
const { translate } = pkg;
import fs from 'fs';

const httpsAgent = new https.Agent({ keepAlive: false, family: 4 });

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
    let result = null;

    try {
      const response = await fetchJikanWithRetry(text);
      result = response.data?.data?.[0];
    } catch (jikanErr) {
      console.warn('[animeinfo] Jikan falló, intentando Kitsu:', jikanErr.message);
    }

    if (!result) {
      try {
        result = await fetchFromKitsu(text);
      } catch (kitsuErr) {
        console.warn('[animeinfo] Kitsu también falló:', kitsuErr.message);
      }
    }

    if (!result) return m.reply(`*${tradutor.texto3}*`);

    const TRADUCCIONES = {
      estados: {
        'Finished Airing': 'Finalizado',
        'Currently Airing': 'En emisión',
        'Not yet aired': 'Próximamente',
        'finished': 'Finalizado',
        'current': 'En emisión',
        'tba': 'Próximamente',
        'unreleased': 'Próximamente',
        'upcoming': 'Próximamente'
      },
      temporadas: {
        'winter': 'Invierno',
        'spring': 'Primavera',
        'summer': 'Verano',
        'fall': 'Otoño'
      },
      formatos: {
        'TV': 'Serie de TV',
        'Movie': 'Película',
        'OVA': 'OVA',
        'ONA': 'ONA',
        'Special': 'Especial',
        'Music': 'Musical',
        'TV Special': 'Especial de TV',
        'CM': 'Comercial',
        'PV': 'Video Promocional'
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

    let cleanDesc = result.synopsis
      ? result.synopsis.replace(/\[Written by MAL Rewrite\]/gi, '').trim()
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

    const titulo = result.title || result.title_english || result.title_japanese || 'Desconocido';
    const tituloIngles = result.title_english && result.title_english !== result.title
      ? `\n🔤 *Título en inglés:* ${result.title_english}`
      : '';
    const tituloNativo = result.title_japanese && result.title_japanese !== result.title
      ? ` (${result.title_japanese})`
      : '';

    const estudios = result.studios?.length
      ? result.studios.map(s => s.name).join(', ')
      : 'Desconocido';

    const generosEsp = result.genres?.length
      ? result.genres.map(g => TRADUCCIONES.generos[g.name] || g.name).join(', ')
      : 'N/A';

    const puntuacion = result.score ? `\n⭐ *Puntuación:* ${result.score}/10` : '';

    const AnimeInfo = `✨*INFORMACIÓN DEL ANIME*✨

🈺 *Título:* ${titulo}${tituloIngles}${tituloNativo}
🏦 *Estudio:* ${estudios}
📆 *Año:* ${result.year || 'N/A'}
🗂 *Episodios:* ${result.episodes || 'En emisión'}
🎧 *Audio:* Japonés
💬 *Subtítulos:* Español
🏷 *Géneros:* ${generosEsp}
⏱ *Duración:* ${result.duration || 'N/A'}${puntuacion}
💽 *Formato:* ${TRADUCCIONES.formatos[result.type] || result.type || 'N/A'}
🔅 *Temporada:* ${TRADUCCIONES.temporadas[result.season?.toLowerCase()] || 'N/A'}
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

async function fetchJikanWithRetry(queryText, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.get('https://api.jikan.moe/v4/anime', {
        params: { q: queryText, limit: 1 },
        timeout: 25000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        httpsAgent
      });
      return response;
    } catch (err) {
      lastError = err;
      console.warn(`[animeinfo] Jikan intento ${i + 1} falló: ${err.message}`);
      if (i < maxRetries - 1) {
        await new Promise(res => setTimeout(res, 1000 * Math.pow(2, i)));
      }
    }
  }
  throw lastError;
}

async function fetchFromKitsu(queryText) {
  const res = await axios.get('https://kitsu.io/api/edge/anime', {
    params: { 'filter[text]': queryText, 'page[limit]': 1 },
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/vnd.api+json' },
    httpsAgent
  });

  const item = res.data?.data?.[0];
  if (!item) return null;

  const attrs = item.attributes;

  return {
    title: attrs.canonicalTitle || attrs.titles?.en || attrs.titles?.en_jp || 'Desconocido',
    title_english: attrs.titles?.en || null,
    title_japanese: attrs.titles?.ja_jp || null,
    synopsis: attrs.synopsis || null,
    year: attrs.startDate ? new Date(attrs.startDate).getFullYear() : null,
    episodes: attrs.episodeCount || null,
    duration: attrs.episodeLength ? `${attrs.episodeLength} min` : null,
    type: attrs.subtype === 'TV' ? 'TV' : (attrs.subtype === 'movie' ? 'Movie' : attrs.subtype),
    status: attrs.status === 'finished' ? 'Finished Airing'
          : attrs.status === 'current' ? 'Currently Airing'
          : attrs.status === 'tba' ? 'Not yet aired'
          : attrs.status,
    season: attrs.season || null,
    score: attrs.averageRating ? (parseFloat(attrs.averageRating) / 10).toFixed(1) : null,
    studios: [],
    genres: [],
    images: {
      jpg: {
        large_image_url: attrs.posterImage?.large || attrs.posterImage?.original || attrs.posterImage?.medium,
        image_url: attrs.posterImage?.medium
      }
    }
  };
}

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
