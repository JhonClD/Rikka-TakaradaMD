import axios from 'axios';
import pkg from '@vitalets/google-translate-api';
const { translate } = pkg;
import fs from 'fs';

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
    const query = `query ($search: String) { 
      Media (search: $search, type: ANIME) { 
        id 
        title { romaji english native } 
        studios(isMain: true) { nodes { name } } 
        seasonYear 
        episodes 
        genres 
        duration 
        format 
        season 
        status 
        description 
        bannerImage 
        coverImage { extraLarge large medium } 
      } 
    }`;

    const response = await axios({
      url: 'https://graphql.anilist.co',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      data: { query, variables: { search: text } },
      timeout: 20000
    });

    const result = response.data?.data?.Media;
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
        'MOVIE': 'Película',
        'SPECIAL': 'Especial',
        'OVA': 'OVA',
        'ONA': 'ONA',
        'MUSIC': 'Musical',
        'TV_SHORT': 'Serie Corta',
        'MANGA': 'Manga',
        'NOVEL': 'Novela',
        'ONE_SHOT': 'One-Shot'
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

    let cleanDesc = result.description
      ? result.description
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/?[^>]+(>|$)/g, '')
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
    const tituloIngles = result.title?.english && result.title.english !== result.title.romaji
      ? `\n🔤 *Título en inglés:* ${result.title.english}`
      : '';
    const tituloNativo = result.title?.native && result.title.native !== result.title.romaji
      ? ` (${result.title.native})`
      : '';

    const estudios = result.studios?.nodes?.map(s => s.name).join(', ') || 'Desconocido';
    const generosEsp = result.genres?.length
      ? result.genres.map(g => TRADUCCIONES.generos[g] || g).join(', ')
      : 'N/A';

    const AnimeInfo = `✨*INFORMACIÓN DEL ANIME*✨

🈺 *Título:* ${titulo}${tituloIngles}${tituloNativo}
🏦 *Estudio:* ${estudios}
📆 *Año:* ${result.seasonYear || 'N/A'}
🗂 *Episodios:* ${result.episodes || 'En emisión'}
🎧 *Audio:* Japonés
💬 *Subtítulos:* Español
🏷 *Géneros:* ${generosEsp}
⏱ *Duración:* ${result.duration ? result.duration + ' min' : 'N/A'}
💽 *Formato:* ${TRADUCCIONES.formatos[result.format] || result.format || 'N/A'}
🔅 *Temporada:* ${TRADUCCIONES.temporadas[result.season] || 'N/A'}
⏳ *Estado:* ${TRADUCCIONES.estados[result.status] || result.status || 'N/A'}

📜 *Sinopsis:*
${sinopsisFormateada}`;

    const imageUrl =
      result.coverImage?.extraLarge ||
      result.coverImage?.large ||
      result.bannerImage ||
      result.coverImage?.medium;

    if (!imageUrl) {
      return conn.sendMessage(m.chat, { text: AnimeInfo }, { quoted: m });
    }

    let imageBuffer;
    try {
      const { data } = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
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

    const MAX_CAPTION = 1000;
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
    } else if (e.message?.includes('Network')) {
      errorMsg += '\n\n🌐 _Error de conexión. Verifica tu internet._';
    } else {
      errorMsg += `\n\n📝 _Detalles: ${e.message || 'Error desconocido'}_`;
    }

    m.reply(errorMsg);
  }
};

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
          timeout: 8000
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
