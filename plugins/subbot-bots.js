/**
 * subbot-bots.js
 * ╭──────────────────────────────────────────────────────────╮
 * │  Lista de Sub-Bots — Rikka-TakaradaMD                   │
 * │  Comandos: .bots  /  .sockets                           │
 * ╰──────────────────────────────────────────────────────────╯
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const JADIBTS_DIR = path.join(__dirname, '../jadibts');

const handler = async (m, { conn, isOwner }) => {
  if (!isOwner) {
    return m.reply('╰─► ✗ Solo el *owner* puede ver la lista de sub-bots.');
  }

  const from = m.key.remoteJid;

  // ── Participantes del grupo (para mostrar solo los que están) ──
  let groupParticipants = [];
  if (m.isGroup) {
    try {
      const meta = await conn.groupMetadata(from);
      groupParticipants = meta?.participants?.map(
        (p) => (p.phoneNumber || p.jid || p.lid || p.id || '').split('@')[0]
      ) || [];
    } catch {}
  }

  // ── Bot principal ──
  const mainId  = (global.conn?.user?.jid || conn.user?.jid || '')
                    .split(':')[0]
                    .split('@')[0];
  const mainJid = `${mainId}@s.whatsapp.net`;

  // ── Sub-bots registrados ──
  const subsIds = fs.existsSync(JADIBTS_DIR)
    ? fs.readdirSync(JADIBTS_DIR).filter((d) =>
        fs.existsSync(path.join(JADIBTS_DIR, d, 'creds.json'))
      )
    : [];

  // ── Conexiones activas ──
  const activeIds = new Set(
    (global.conns || [])
      .filter((c) => c.isInit)
      .map((c) => (c.userId || '').replace(/\D/g, ''))
  );

  // ── Construir lista ──
  const mentionedJid = [];
  const ownerLines   = [];
  const subLines     = [];

  // Botón principal
  const mainSettings = global.db?.data?.settings?.[mainJid] || {};
  const mainName     = mainSettings.namebot || 'Rikka';
  const mainOnline   = activeIds.has(mainId) || conn.isInit ? '✦' : '◌';

  if (!m.isGroup || groupParticipants.includes(mainId)) {
    mentionedJid.push(mainJid);
    ownerLines.push(`${mainOnline} ꒰ Owner ꒱ *${mainName}* › @${mainId}`);
  }

  // Sub-bots
  for (const subId of subsIds) {
    const cleanId = subId.replace(/\D/g, '');
    const subJid  = `${cleanId}@s.whatsapp.net`;

    if (m.isGroup && !groupParticipants.includes(cleanId)) continue;

    const subSettings = global.db?.data?.settings?.[subJid] || {};
    const subName     = subSettings.namebot || 'Sub';
    const online      = activeIds.has(cleanId) ? '✦' : '◌';

    mentionedJid.push(subJid);
    subLines.push(`${online} ꒰ Sub ꒱ *${subName}* › @${cleanId}`);
  }

  const totalBots    = 1 + subsIds.length;
  const totalEnGrupo = ownerLines.length + subLines.length;
  const enGrupoText  = m.isGroup
    ? `\n┊ ↳ En este grupo: *${totalEnGrupo}*`
    : '';

  const ownerBlock = ownerLines.length
    ? `\n┊\n┊ ⸙ *Principales*\n┊ ${ownerLines.join('\n┊ ')}`
    : '';
  const subBlock   = subLines.length
    ? `\n┊\n┊ ❁ *Sub-Bots*\n┊ ${subLines.join('\n┊ ')}`
    : '';
  const noSubs     = !subLines.length && !subBlock
    ? `\n┊\n┊ ◌ No hay sub-bots activos.`
    : '';

  const texto =
    `╭──── ✧ Sockets Registrados ────╮\n` +
    `┊ ↳ Total: *${totalBots}*  ꒰ Owner: ${ownerLines.length} • Sub: ${subsIds.length} ꒱` +
    enGrupoText +
    ownerBlock +
    subBlock +
    noSubs +
    `\n╰───── ❁ཻུ۪۪ ──────────────────────╯\n\n` +
    `_✦ = conectado  ·  ◌ = desconectado_`;

  await conn.sendMessage(
    from,
    { text: texto, mentions: mentionedJid },
    { quoted: m }
  );
};

handler.help    = ['bots', 'sockets'];
handler.tags    = ['subbot'];
handler.command = /^(bots|sockets)$/i;
handler.owner   = true;

export default handler;
