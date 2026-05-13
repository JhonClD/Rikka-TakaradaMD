import {
  resolveToPhoneJidAsync,
  getLidForJidAsync,
  isLidJid,
  isPhoneJid,
} from '../src/funcion/lid-resolver.js';

const handler = async (m, { conn }) => {
  const rawSender = m.sender;
  const isLid     = isLidJid(rawSender);

  let realJid = rawSender;
  let lid     = null;

  if (isLid) {
    lid    = rawSender;
    realJid = await resolveToPhoneJidAsync(rawSender, conn);
  } else {
    lid = await getLidForJidAsync(rawSender, conn);
  }

  const rawNumber = realJid.split('@')[0].replace(/[^0-9]/g, '');
  const formatted = rawNumber.length <= 11
    ? '+' + rawNumber.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4')
    : '+' + rawNumber;
  const jid = rawNumber + '@s.whatsapp.net';

  let pp = 'https://files.catbox.moe/leegee.jpg';
  try { pp = await conn.profilePictureUrl(jid, 'image'); } catch {
    try { pp = await conn.profilePictureUrl(jid, 'preview'); } catch {}
  }

  const notResolved = isLid && isLidJid(realJid);
  const warnLine    = notResolved
    ? `\n\n⚠️ _LID sin resolver: aún no hay mapping guardado para este usuario._`
    : '';

  const caption =
`╔═════✰⋆⋅☆⋅⋆✰═════╗
     ೃ⁀➷  *Info Del Usuario*
╚═════✰⋆⋅☆⋅⋆✰═════╝

✧ *Número de WhatsApp:*
\`${formatted}\`

✧ *JID (ID de WhatsApp):*
\`${jid}\`

✧ *LID (ID Vinculado):*
\`${lid || '_(no disponible)_'}\`${warnLine}

☆✦・*・✦・*・✦・*・✦・*・✦☆`;

  await conn.sendMessage(
    m.chat,
    { image: { url: pp }, caption, mentions: [jid] },
    { quoted: m },
  );
};

handler.help    = ['jid', 'lid', 'myjid'];
handler.tags    = ['info'];
handler.command = /^(jid|lid|myjid|miid|infojid)$/i;

export default handler;
