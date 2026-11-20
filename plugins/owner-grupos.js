import {
  cleanJid,
  getLidForJid,
  getLidForJidAsync,
  isGroupJid,
  isLidJid,
  isPhoneJid,
  resolveJidToPhone,
  resolveToPhoneJid,
} from '../src/funcion/lid-resolver.js';

const MAX_MESSAGE_LENGTH = 3500;

const normalizeText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

const phoneDigits = (jid) => (typeof jid === 'string'
  ? cleanJid(jid).split('@')[0].replace(/\D/g, '')
  : '');

const formatAddressingMode = (mode) => {
  const normalized = String(mode || '').toLowerCase();
  if (normalized === 'lid') return 'LID';
  if (normalized === 'pn') return 'PN';
  return null;
};

function normalizeParticipant(entry, conn) {
  const isObj = entry && typeof entry === 'object';
  const rawId = cleanJid(typeof entry === 'string' ? entry : (entry?.id || entry?.jid || ''));
  const rawLid = cleanJid(isObj ? (entry.lid || '') : '');
  const rawPhoneInput = isObj && entry.phoneNumber ? String(entry.phoneNumber) : '';
  const rawPhone = rawPhoneInput
    ? cleanJid(rawPhoneInput.includes('@') ? rawPhoneInput : `${rawPhoneInput}@s.whatsapp.net`)
    : '';

  const lid = isLidJid(rawLid)
    ? rawLid
    : isLidJid(rawId)
      ? rawId
      : (getLidForJid(rawPhone || rawId, conn) || '');

  const phoneJid = isPhoneJid(rawPhone)
    ? rawPhone
    : isPhoneJid(rawId)
      ? rawId
      : (lid ? (resolveToPhoneJid(lid, conn) || '') : '');

  return {
    lid,
    phoneJid,
    phone: phoneJid ? phoneDigits(phoneJid) : '',
    rawId,
    admin: isObj ? (entry.admin || null) : null,
  };
}

function normalizeGroupRecord(id, meta = {}, chatFallback = {}) {
  const groupId = cleanJid(meta?.id || id || '');
  const subject = String(
    meta?.subject || chatFallback?.subject || chatFallback?.name || '',
  ).trim() || 'Grupo sin nombre';
  const participants = Array.isArray(meta?.participants) ? meta.participants : [];
  const size = Number.isFinite(Number(meta?.size)) && Number(meta.size) > 0
    ? Number(meta.size)
    : participants.length;

  return {
    id: groupId,
    subject,
    size,
    addressingMode: meta?.addressingMode || null,
    owner: meta?.owner ? cleanJid(meta.owner) : '',
    ownerPn: meta?.ownerPn ? cleanJid(meta.ownerPn) : '',
    linkedParent: meta?.linkedParent ? cleanJid(meta.linkedParent) : '',
    isCommunity: Boolean(meta?.isCommunity),
    isCommunityAnnounce: Boolean(meta?.isCommunityAnnounce),
    participants,
  };
}

async function fetchAllGroups(conn) {
  let fromCache = false;
  const groupsMap = new Map();

  if (typeof conn?.groupFetchAllParticipating === 'function') {
    try {
      const participating = await conn.groupFetchAllParticipating();
      for (const [key, meta] of Object.entries(participating || {})) {
        const id = cleanJid(meta?.id || key || '');
        if (!isGroupJid(id)) continue;
        groupsMap.set(id, normalizeGroupRecord(id, meta, conn?.chats?.[id]));
      }
    } catch {
      fromCache = true;
    }
  } else {
    fromCache = true;
  }

  if (fromCache) {
    for (const [key, chat] of Object.entries(conn?.chats || {})) {
      const id = cleanJid(chat?.id || key || '');
      if (!isGroupJid(id) || chat?.isChats === false) continue;
      groupsMap.set(id, normalizeGroupRecord(id, chat?.metadata || {}, chat));
    }
  }

  const groups = [...groupsMap.values()].sort(
    (a, b) => a.subject.localeCompare(b.subject, 'es', { sensitivity: 'base' })
      || a.id.localeCompare(b.id),
  );

  return { groups, fromCache };
}

async function getBotIdentity(conn) {
  const rawJid = cleanJid(conn?.user?.jid || conn?.user?.id || '');
  const phoneJid = isPhoneJid(rawJid) ? rawJid : (resolveToPhoneJid(rawJid, conn) || '');
  const botPhone = phoneDigits(phoneJid || rawJid);

  let botLid = isLidJid(conn?.user?.lid)
    ? cleanJid(conn.user.lid)
    : (isLidJid(rawJid) ? rawJid : '');

  if (!botLid && phoneJid) {
    try {
      const resolved = await getLidForJidAsync(phoneJid, conn);
      if (isLidJid(resolved)) botLid = cleanJid(resolved);
    } catch {}
  }

  return { botPhone, botLid };
}

function isBotAdminInGroup(participants, { botPhone, botLid }, conn) {
  const matched = participants.find((p) => {
    if (botLid && p.lid && p.lid === botLid) return true;
    if (botPhone && p.phone && p.phone === botPhone) return true;
    if (botPhone && p.rawId && resolveJidToPhone(p.rawId, conn) === botPhone) return true;
    return false;
  });
  return matched?.admin === 'admin' || matched?.admin === 'superadmin';
}

function groupBadge(group) {
  if (group.isCommunity) return ' 🏘️';
  if (group.isCommunityAnnounce) return ' 📢';
  return '';
}

function formatGroupEntry(group, index, botIdentity, conn) {
  const participants = group.participants.map((p) => {
    const info = normalizeParticipant(p, conn);
    if (!info.lid && botIdentity?.botLid && botIdentity?.botPhone && info.phone === botIdentity.botPhone) {
      info.lid = botIdentity.botLid;
    }
    return info;
  });
  const totalMembers = group.size || participants.length;
  const lidCount = participants.filter((p) => p.lid).length;
  const mode = formatAddressingMode(group.addressingMode);
  const botStatus = participants.length
    ? (isBotAdminInGroup(participants, botIdentity, conn) ? '👑 Admin' : '👤 Miembro')
    : 'N/D';

  const stats = [];
  if (totalMembers > 0) stats.push(`*Miembros:* ${totalMembers}`);
  if (participants.length > 0) stats.push(`*LIDs:* ${lidCount}`);
  if (mode) stats.push(`*Modo:* ${mode}`);
  stats.push(`*Bot:* ${botStatus}`);

  const lines = [
    `*${index}.* *${group.subject}*${groupBadge(group)}`,
    `┊ ↳ *ID/JID:* \`${group.id}\``,
    `┊ ↳ ${stats.join(' │ ')}`,
  ];

  if (group.linkedParent) {
    lines.push(`┊ ↳ *Comunidad:* \`${group.linkedParent}\``);
  }

  return lines.join('\n');
}

async function enrichGroupDetail(group, conn, botIdentity) {
  let target = group;

  if (!target.participants.length && typeof conn?.groupMetadata === 'function') {
    try {
      const fresh = await conn.groupMetadata(target.id);
      if (fresh) target = normalizeGroupRecord(target.id, fresh, target);
    } catch {}
  }

  const participants = target.participants.map((p) => normalizeParticipant(p, conn));

  if (botIdentity?.botLid && botIdentity?.botPhone) {
    for (const p of participants) {
      if (!p.lid && p.phone === botIdentity.botPhone) {
        p.lid = botIdentity.botLid;
      }
    }
  }

  const missingLidPns = [...new Set(
    participants.filter((p) => !p.lid && p.phoneJid).map((p) => p.phoneJid),
  )];

  const getLIDsForPNs = conn?.signalRepository?.lidMapping?.getLIDsForPNs;
  if (missingLidPns.length && typeof getLIDsForPNs === 'function') {
    try {
      const resolvedList = await conn.signalRepository.lidMapping.getLIDsForPNs(missingLidPns);
      const pnToLid = new Map();
      for (const pair of resolvedList || []) {
        if (pair?.pn && pair?.lid) {
          pnToLid.set(cleanJid(pair.pn), cleanJid(pair.lid));
        }
      }
      for (const p of participants) {
        if (!p.lid && p.phoneJid && pnToLid.has(p.phoneJid)) {
          p.lid = pnToLid.get(p.phoneJid);
        }
      }
    } catch {}
  }

  const roleWeight = (admin) => (admin === 'superadmin' ? 0 : admin === 'admin' ? 1 : 2);
  participants.sort((a, b) => (
    roleWeight(a.admin) - roleWeight(b.admin)
    || (a.lid || a.phone || a.rawId).localeCompare(b.lid || b.phone || b.rawId)
  ));

  return { group: target, participants };
}

function formatOwnerLine(group, participants, conn) {
  const superAdmin = participants.find((p) => p.admin === 'superadmin');
  const ownerLid = isLidJid(group.owner)
    ? group.owner
    : (superAdmin?.lid || (isPhoneJid(group.owner) ? getLidForJid(group.owner, conn) : '') || '');
  const ownerPhoneJid = isPhoneJid(group.ownerPn)
    ? group.ownerPn
    : isPhoneJid(group.owner)
      ? group.owner
      : (superAdmin?.phoneJid || (ownerLid ? resolveToPhoneJid(ownerLid, conn) : '') || '');
  const ownerPhone = ownerPhoneJid ? phoneDigits(ownerPhoneJid) : '';

  if (ownerLid && ownerPhone) return `\`${ownerLid}\` (+${ownerPhone})`;
  if (ownerLid) return `\`${ownerLid}\``;
  if (ownerPhone) return `+${ownerPhone}`;
  return '';
}

function formatGroupDetailBlocks(group, index, participants, conn) {
  const mode = formatAddressingMode(group.addressingMode);
  const totalMembers = group.size || participants.length;
  const lidCount = participants.filter((p) => p.lid).length;
  const ownerLine = formatOwnerLine(group, participants, conn);

  const headerLines = [
    '╔═════✰⋆⋅☆⋅⋆✰═════╗',
    '     ೃ⁀➷  *Detalle del Grupo*',
    '╚═════✰⋆⋅☆⋅⋆✰═════╝',
    '',
    `✧ *#${index} Nombre:* *${group.subject}*${groupBadge(group)}`,
    `✧ *ID/JID:* \`${group.id}\``,
  ];

  if (mode) headerLines.push(`✧ *Modo:* ${mode}`);
  if (group.linkedParent) headerLines.push(`✧ *Comunidad:* \`${group.linkedParent}\``);
  if (ownerLine) headerLines.push(`✧ *Creador:* ${ownerLine}`);
  headerLines.push(`✧ *Miembros:* ${totalMembers} │ *Con LID:* ${lidCount}`);

  const blocks = [headerLines.join('\n')];

  if (!participants.length) {
    blocks.push('\n⚠️ _No se pudieron obtener los participantes de este grupo._');
  } else {
    blocks.push('\n*Participantes y LIDs:*');
    for (const p of participants) {
      const icon = p.admin === 'superadmin' ? '👑' : p.admin === 'admin' ? '⭐' : '👤';
      if (p.lid && p.phone) {
        blocks.push(`${icon} \`${p.lid}\` (+${p.phone})`);
      } else if (p.lid) {
        blocks.push(`${icon} \`${p.lid}\``);
      } else if (p.phone) {
        blocks.push(`${icon} _sin LID_ (+${p.phone})`);
      } else {
        blocks.push(`${icon} \`${p.rawId || 'desconocido'}\``);
      }
    }
  }

  blocks.push('\n☆✦・*・✦・*・✦・*・✦・*・✦☆');
  return blocks;
}

function splitBlocks(blocks, separator = '\n', maxLength = MAX_MESSAGE_LENGTH) {
  const chunks = [];
  let current = '';

  const pushPiece = (piece) => {
    if (!piece) return;
    if (!current) {
      current = piece;
      return;
    }
    if ((current.length + separator.length + piece.length) <= maxLength) {
      current += separator + piece;
      return;
    }
    chunks.push(current);
    current = piece;
  };

  for (const block of blocks) {
    if (block.length <= maxLength) {
      pushPiece(block);
      continue;
    }
    for (const line of block.split('\n')) {
      if (line.length <= maxLength) {
        pushPiece(line);
      } else {
        for (let i = 0; i < line.length; i += maxLength) {
          pushPiece(line.slice(i, i + maxLength));
        }
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendChunked(conn, chat, blocks, quoted, separator = '\n') {
  const chunks = splitBlocks(blocks, separator);
  for (let i = 0; i < chunks.length; i += 1) {
    await conn.sendMessage(
      chat,
      { text: chunks[i] },
      i === 0 && quoted ? { quoted } : {},
    );
  }
}

const handler = async (m, { conn, text, usedPrefix, command, isOwner }) => {
  if (!isOwner) return m.reply('꒰ ✗ ꒱ Solo el *owner* puede usar este comando.');

  const { groups, fromCache } = await fetchAllGroups(conn);
  if (!groups.length) {
    return m.reply('꒰ ✗ ꒱ El bot no se encuentra en ningún grupo actualmente.');
  }

  const botIdentity = await getBotIdentity(conn);
  const query = String(text || '').trim();
  const cmd = `${usedPrefix || '/'}${command}`;

  if (query) {
    let selectedIndex = -1;

    if (/^(actual|aqui|aquí|this)$/i.test(query)) {
      if (!m.isGroup) {
        return m.reply('꒰ ✗ ꒱ Usa esa opción dentro de un grupo o indica el número del grupo.');
      }
      selectedIndex = groups.findIndex((g) => g.id === cleanJid(m.chat));
      if (selectedIndex === -1) {
        const currentGroup = normalizeGroupRecord(m.chat, conn?.chats?.[m.chat]?.metadata || {}, conn?.chats?.[m.chat]);
        const { group, participants } = await enrichGroupDetail(currentGroup, conn, botIdentity);
        const detailBlocks = formatGroupDetailBlocks(group, 1, participants, conn);
        return sendChunked(conn, m.chat, detailBlocks, m, '\n');
      }
    } else if (/^\d+$/.test(query)) {
      const idx = Number.parseInt(query, 10) - 1;
      if (idx < 0 || idx >= groups.length) {
        return m.reply(`꒰ ✗ ꒱ Número fuera de rango. Usa un valor entre *1* y *${groups.length}*.`);
      }
      selectedIndex = idx;
    } else if (isGroupJid(query)) {
      const targetId = cleanJid(query);
      selectedIndex = groups.findIndex((g) => g.id === targetId);
      if (selectedIndex === -1) {
        return m.reply(`꒰ ✗ ꒱ El bot no está en el grupo \`${targetId}\`.`);
      }
    }

    if (selectedIndex !== -1) {
      const { group, participants } = await enrichGroupDetail(groups[selectedIndex], conn, botIdentity);
      const detailBlocks = formatGroupDetailBlocks(group, selectedIndex + 1, participants, conn);
      return sendChunked(conn, m.chat, detailBlocks, m, '\n');
    }

    const needle = normalizeText(query);
    const matches = groups
      .map((group, i) => ({ group, number: i + 1 }))
      .filter(({ group }) => (
        normalizeText(group.subject).includes(needle)
        || group.id.toLowerCase().includes(needle)
      ));

    if (!matches.length) {
      return m.reply(`꒰ ✗ ꒱ No se encontró ningún grupo que coincida con *${query}*.`);
    }

    const blocks = [
      [
        '╔═════✰⋆⋅☆⋅⋆✰═════╗',
        '     ೃ⁀➷  *Grupos Filtrados*',
        '╚═════✰⋆⋅☆⋅⋆✰═════╝',
        '',
        `✧ *Filtro:* ${query}`,
        `✧ *Coincidencias:* ${matches.length} de ${groups.length}`,
      ].join('\n'),
      ...matches.map(({ group, number }) => formatGroupEntry(group, number, botIdentity, conn)),
      `💡 *Ver LIDs de un grupo:* \`${cmd} <número>\`\n☆✦・*・✦・*・✦・*・✦・*・✦☆`,
    ];

    return sendChunked(conn, m.chat, blocks, m, '\n\n');
  }

  const headerLines = [
    '╔═════✰⋆⋅☆⋅⋆✰═════╗',
    '     ೃ⁀➷  *Grupos del Bot*',
    '╚═════✰⋆⋅☆⋅⋆✰═════╝',
    '',
    `✧ *Total de grupos:* ${groups.length}`,
  ];

  if (botIdentity.botLid) {
    headerLines.push(`✧ *LID del bot:* \`${botIdentity.botLid}\``);
  }
  if (fromCache) {
    headerLines.push('⚠️ _Lista obtenida desde caché local._');
  }

  const blocks = [
    headerLines.join('\n'),
    ...groups.map((group, i) => formatGroupEntry(group, i + 1, botIdentity, conn)),
    `💡 *Ver LIDs de miembros:* \`${cmd} <número>\` │ *Filtrar:* \`${cmd} <nombre>\`\n☆✦・*・✦・*・✦・*・✦・*・✦☆`,
  ];

  return sendChunked(conn, m.chat, blocks, m, '\n\n');
};

handler.help = ['grupos', 'group', 'gp'];
handler.tags = ['owner'];
handler.command = /^(grupos|group|gp)$/i;
handler.owner = true;

export default handler;
