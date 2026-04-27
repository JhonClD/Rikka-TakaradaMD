const handler = async (m, { args, usedPrefix, command }) => {
  const msg = `📖 Uso: _${usedPrefix + command} (idioma) (texto)_\n*Ejemplo:* _${usedPrefix + command} en Hola mundo_\n\n*Idiomas:* https://cloud.google.com/translate/docs/languages`;

  let lang = 'es';
  let text = '';

  if (args && args[0]) {
    if (/^[a-z]{2,3}$/i.test(args[0])) {
      lang = args[0].toLowerCase();
      text = args.slice(1).join(' ');
    } else {
      text = args.join(' ');
    }
  }

  if (!text && m.quoted?.text) text = m.quoted.text;
  if (!text) return m.reply(msg);

  let translated = null;

  // Proveedor 1: Google Translate API pública (sin key, muy confiable)
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    const json = await res.json();
    translated = json?.[0]?.map(i => i?.[0]).filter(Boolean).join('');
  } catch (e) {
    console.log('[Translate P1 Error]', e.message);
  }

  // Proveedor 2: MyMemory
  if (!translated) {
    try {
      const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|${lang}`);
      const json = await res.json();
      if (json?.responseStatus === 200) translated = json.responseData?.translatedText;
    } catch (e) {
      console.log('[Translate P2 Error]', e.message);
    }
  }

  // Proveedor 3: lolhuman
  if (!translated) {
    try {
      const res = await fetch(`https://api.lolhuman.xyz/api/translate/auto/${lang}?apikey=${lolkeysapi}&text=${encodeURIComponent(text)}`);
      const json = await res.json();
      if (json?.result?.translated) translated = json.result.translated;
    } catch (e) {
      console.log('[Translate P3 Error]', e.message);
    }
  }

  if (!translated) return m.reply('❌ No se pudo traducir el texto. Inténtalo de nuevo.');

  await m.reply(`🌐 *Traducción (${lang}):*\n${translated}`);
};

handler.help = ['translate <idioma> <texto>'];
handler.tags = ['herramientas'];
handler.command = /^(translate|traducir|trad)$/i;
export default handler;
