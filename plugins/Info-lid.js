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

  console.log('[INFO-LID] rawSender:', rawSender);

  const isLid = isLidJid(rawSender);
  let realJid = rawSender;
  let lid     = null;

  if (isLid) {
    lid = rawSender;
    try {
      realJid = await resolveToPhoneJidAsync(rawSender, conn);
      console.log('[INFO-LID] resolveToPhoneJidAsync:', realJid);
    } catch (e) {
      console.log('[INFO-LID] resolveToPhoneJidAsync error:', e?.message);
    }
    if (!realJid || isLidJid(realJid)) {
      try {
        realJid = await resolveFromParticipants(rawSender, conn, m.chat);
        console.log('[INFO-LID] resolveFromParticipants:', realJid);
      } catch (e) {
        console.log('[INFO-LID] resolveFromParticipants error:', e?.message);
      }
    }
    realJid = realJid || rawSender;
  } else {
    try {
      const fromMeta = await resolveFromParticipants(rawSender, conn, m.chat);
      if (fromMeta) {
        realJid = fromMeta;
        console.log('[INFO-LID] resolveFromParticipants (phone):', realJid);
      }
    } catch (e) {
      console.log('[INFO-LID] resolveFromParticipants error:', e?.message);
    }
    try {
      lid = await getLidForJidAsync(rawSender, conn);
      console.log('[INFO-LID] getLidForJidAsync:', lid);
    } catch (e) {
      console.log('[INFO-LID] getLidForJidAsync error:', e?.message);
    }
  }

  const rawNumber = realJid.split('@')[0].replace(/[^0-9]/g, '');
  const jid = rawNumber + '@s.whatsapp.net';
  console.log('[INFO-LID] jid final:', jid, '| lid:', lid);

  const storageJid = lid || jid;
  try {
    const tcData = await conn.authState?.keys?.get?.('tctoken', [storageJid]);
    console.log('[TCTOKEN] storageJid:', storageJid, '| data:', JSON.stringify(tcData));
  } catch (e) {
    console.log('[TCTOKEN] error:', e?.message);
  }

  let pp = null;
  const targets = [jid];
  if (lid) targets.unshift(lid);
  console.log('[INFO-LID] targets pp:', targets);

  for (const t of targets) {
    try {
      const url = await conn.profilePictureUrl(t, 'image');
      console.log(`[INFO-LID] profilePictureUrl image (${t}):`, url);
      if (url) { pp = url; break; }
    } catch (e) {
      console.log(`[INFO-LID] profilePictureUrl image error (${t}):`, e?.message);
    }
    try {
      const url = await conn.profilePictureUrl(t, 'preview');
      console.log(`[INFO-LID] profilePictureUrl preview (${t}):`, url);
      if (url) { pp = url; break; }
    } catch (e) {
      console.log(`[INFO-LID] profilePictureUrl preview error (${t}):`, e?.message);
    }
  }

  console.log('[INFO-LID] pp final:', pp);

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
