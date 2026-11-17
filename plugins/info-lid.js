import {
  resolveToPhoneJidAsync,
  getLidForJidAsync,
  isLidJid,
  resolveFromParticipants,
} from '../src/funcion/lid-resolver.js';

const isPhoneJid = jid => typeof jid === 'string' && (
  jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us') || jid.endsWith('@hosted')
);
const normalizeLid = jid => typeof jid === 'string' && jid.endsWith('@lid')
  ? jid.replace(/:\d+@lid$/, '@lid')
  : jid;

const handler = async (m, { conn, args }) => {
  const key = m.quoted?.key || m.key || {};
  const quotedSender = m.quoted?.sender;
  let rawSender = args[0]
    ? `${args[0].replace(/[^0-9]/g, '')}@s.whatsapp.net`
    : (quotedSender || m.sender || '');
  const rawLid = [key.participant, key.remoteJid, rawSender]
    .find(jid => typeof jid === 'string' && isLidJid(jid)) || null;
  const alternateJid = key.participantAlt || key.remoteJidAlt || key.senderPn || key.participantPn || null;
  const configuredOwner = (global.owner || []).find(([, , , ownerLid]) => ownerLid && (normalizeLid(ownerLid) === normalizeLid(rawLid) || normalizeLid(ownerLid) === normalizeLid(rawSender)));
  let lid = rawLid;
  let realJid = isPhoneJid(alternateJid)
    ? alternateJid
    : configuredOwner
      ? `${configuredOwner[0]}@s.whatsapp.net`
      : rawSender;

  if (rawLid && !isPhoneJid(alternateJid) && !configuredOwner) {
    try { realJid = await resolveToPhoneJidAsync(rawLid, conn) || rawLid; } catch {}
    if (isLidJid(realJid)) {
      try { realJid = await resolveFromParticipants(rawLid, conn, m.chat) || rawLid; } catch {}
    }
  } else if (!rawLid && isPhoneJid(rawSender)) {
    try { lid = await getLidForJidAsync(rawSender, conn); } catch {}
    try { realJid = await resolveFromParticipants(rawSender, conn, m.chat) || rawSender; } catch {}
  }

  const hasPhone = isPhoneJid(realJid);
  const phone = hasPhone ? realJid.split('@')[0].replace(/:\d+$/, '').replace(/\D/g, '') : null;
  const displayJid = realJid || rawSender || '_(no disponible)_';
  const unresolved = !!rawLid && !hasPhone;
  const warnLine = unresolved
    ? '\n\n⚠️ _LID sin resolver: WhatsApp/Baileys no entregó un mapeo para este usuario._'
    : '';

  let pp = null;
  for (const target of [...new Set([lid, hasPhone ? realJid : null].filter(Boolean))]) {
    for (const type of ['image', 'preview']) {
      try {
        pp = await conn.profilePictureUrl(target, type);
        if (pp) break;
      } catch {}
    }
    if (pp) break;
  }

  const caption =
`╔═════✰⋆⋅☆⋅⋆✰═════╗
     ೃ⁀➷  *Info Del Usuario*
╚═════✰⋆⋅☆⋅⋆✰═════╝

✧ *Número de WhatsApp:*
\`${phone ? `+${phone}` : 'No disponible (identidad LID)'}\`

✧ *JID (ID de WhatsApp):*
\`${displayJid}\`

✧ *LID (ID Vinculado):*
\`${lid || '_(no disponible)_'}\`${warnLine}

☆✦・*・✦・*・✦・*・✦・*・✦☆`;
  const mentions = hasPhone ? [realJid] : [];
  if (pp) await conn.sendMessage(m.chat, { image: { url: pp }, caption, mentions }, { quoted: m });
  else await conn.sendMessage(m.chat, { text: caption, mentions }, { quoted: m });
};

handler.help = ['jid', 'lid', 'myjid'];
handler.tags = ['info'];
handler.command = /^(jid|lid|myjid|miid|infojid)$/i;
export default handler;
