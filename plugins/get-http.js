import { format } from 'util';

const handler = async (m, { conn, text }) => {
  if (!/^https?:\/\//.test(text)) throw '❌ La URL debe comenzar con http:// o https://';

  const _url = new URL(text);
  const url = global.API(_url.origin, _url.pathname, Object.fromEntries(_url.searchParams.entries()), 'APIKEY');
  const res = await fetch(url);

  if (res.headers.get('content-length') > 100 * 1024 * 1024 * 1024) {
    throw `Content-Length: ${res.headers.get('content-length')}`;
  }

  if (!/text|json/.test(res.headers.get('content-type'))) {
    return conn.sendFile(m.chat, url, 'file', text, m);
  }

  const buf = await res.arrayBuffer();
  let txt = Buffer.from(buf).toString();
  try {
    txt = format(JSON.parse(txt));
  } catch {
    // no es JSON, dejar como texto
  } finally {
    m.reply(txt.slice(0, 65536));
  }
};

handler.help = ['fetch', 'get'].map((v) => v + ' <url>');
handler.tags = ['internet'];
handler.command = /^(fetch|get)$/i;
handler.rowner = true;
export default handler;
