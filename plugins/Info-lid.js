import {
  resolveToPhoneJidAsync,
  getLidForJidAsync,
  isLidJid,
  resolveFromParticipants,
} from '../src/funcion/lid-resolver.js';

const handler = async (m, { conn, args }) => {
  let rawSender;

  if (args[0]) {
    const num = args[0].replace(/[^0-9]/g, '');
    rawSender = num + '@s.whatsapp.net';
  } else if (m.quoted) {
    rawSender = m.quoted.sender;
  } else {
    rawSender = m.sender;
  }

  const isLid = isLidJid(rawSender);
  let realJid = rawSender;
  let lid     = null;

  if (isLid) {
    lid     = rawSender;
    realJid = await resolveToPhoneJidAsync(rawSender, conn)
      || await resolveFromParticipants(rawSender, conn, m.chat)
      || rawSender;
  } else {
    lid = await getLidForJidAsync(rawSender, conn);
  }

  const rawNumber = realJid.split('@')[0].replace(/[^0-9]/g, '');
  const jid = rawNumber + '@s.whatsapp.net';

  let pp = null;
  const targets = [jid];
  if (lid) targets.unshift(lid);

  for (const t of targets) {
    try {
      const url = await conn.profilePictureUrl(t, 'image');
      if (url) { pp = url; break; }
    } catch {}
    try {
      const url = await conn.profilePictureUrl(t, 'preview');
      if (url) { pp = url; break; }
    } catch {}
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
\`+${rawNumber}\`

✧ *JID (ID de WhatsApp):*
\`${jid}\`

✧ *LID (ID Vinculado):*
\`${lid || '_(no disponible)_'}\`${warnLine}

☆✦・*・✦・*・✦・*・✦・*・✦☆`;

  if (pp) {
    await conn.sendMessage(m.chat, { image: { url: pp }, caption, mentions: [jid] }, { quoted: m });
  } else {
    await conn.sendMessage(m.chat, { text: caption, mentions: [jid] }, { quoted: m });
  }
};

handler.help    = ['jid', 'lid', 'myjid'];
handler.tags    = ['info'];
handler.command = /^(jid|lid|myjid|miid|infojid)$/i;

export default handler;
