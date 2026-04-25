import { smsg } from './src/libraries/simple.js';
import { normalizeSender, registerLidPhone, isLidJid } from './lib/funcion/lid-resolver.js';
import { fileURLToPath } from 'url';
import path, { join } from 'path';
import { unwatchFile, watchFile } from 'fs';
import fs from 'fs';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const recentMessages = new Map();
const DUPLICATE_TIMEOUT = 3000;
const MAX_CACHE = 150;

function isDuplicate(id, sender, text) {
  const key = `${id}_${sender}_${(text || '').slice(0, 30)}`;
  if (recentMessages.has(key)) {
    if (Date.now() - recentMessages.get(key) < DUPLICATE_TIMEOUT) return true;
  }
  if (recentMessages.size >= MAX_CACHE) {
    recentMessages.delete(recentMessages.keys().next().value);
  }
  recentMessages.set(key, Date.now());
  return false;
}

function extractText(m) {
  return (
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    m.message?.buttonsResponseMessage?.selectedButtonId ||
    m.message?.templateButtonReplyMessage?.selectedId ||
    m.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  );
}

function getSender(m, conn) {
  const raw = m.key?.fromMe
    ? conn.user?.jid || conn.user?.id
    : m.key?.participant || m.participant || m.key?.remoteJid || '';
  return conn.decodeJid(raw);
}

function isOwner(sender) {
  const num = sender.replace(/\D/g, '');
  const owners = (global.owner || []).map(o => String(Array.isArray(o) ? o[0] : o).replace(/\D/g, ''));
  return owners.includes(num) || global.suittag?.map(n => n.replace(/\D/g, '')).includes(num);
}

function isPrem(sender) {
  const num = sender.replace(/\D/g, '');
  const prems = (global.prems || []).map(n => String(n).replace(/\D/g, ''));
  return isOwner(sender) || prems.includes(num);
}

export async function handler(chatUpdate) {
  try {
    if (!this?.user?.jid) return;
    if (!chatUpdate?.messages?.length) return;

    const conn = this;
    const connectTime = global.timestamp?.connect || 0;

    const validMsgs = chatUpdate.messages.filter(msg => {
      const ts = (msg.messageTimestamp || 0) * 1000;
      return ts >= connectTime - 60000;
    });

    if (!validMsgs.length) return;

    const rawM = validMsgs[validMsgs.length - 1];
    if (!rawM?.message) return;
    if (rawM.key?.remoteJid?.endsWith('broadcast')) return;

    const rawText = extractText(rawM);
    const rawSender = getSender(rawM, conn);

    if (isDuplicate(rawM.key?.id || '', rawSender, rawText)) return;

    let m;
    try {
      m = smsg(conn, rawM);
    } catch {
      return;
    }
    if (!m) return;

    if (isLidJid(m.sender)) {
      const rawPart = rawM.key?.participant || rawM.participant || '';
      if (rawPart) registerLidPhone(rawPart, rawPart);
    }

    m.text = extractText(m);
    if (typeof m.text !== 'string') m.text = '';

    if (m.isBaileys && !m.message?.audioMessage) return;

    const _isOwner = isOwner(m.sender);
    const _isPrems = isPrem(m.sender);

    for (const name in global.plugins) {
      const plugin = global.plugins[name];
      if (!plugin) continue;
      if (plugin.disabled) continue;

      if (typeof plugin.all === 'function') {
        try {
          await plugin.all.call(conn, m, { conn });
        } catch (e) {
          logError(e, name);
        }
      }

      if (typeof plugin.before === 'function') {
        try {
          const stop = await plugin.before.call(conn, m, { conn, isOwner: _isOwner });
          if (stop) continue;
        } catch (e) {
          logError(e, name);
        }
      }

      if (typeof plugin !== 'function') continue;

      const _prefix = plugin.customPrefix || conn.prefix || global.prefix;
      const prefixMatch = matchPrefix(m.text, _prefix);
      if (!prefixMatch) continue;

      const noPrefix = m.text.slice(prefixMatch.length).trim();
      const [cmd, ...argArr] = noPrefix.split(/\s+/);
      const command = (cmd || '').toLowerCase();
      const args = argArr;
      const text = argArr.join(' ');

      const isAccept =
        plugin.command instanceof RegExp
          ? plugin.command.test(command)
          : Array.isArray(plugin.command)
          ? plugin.command.includes(command)
          : typeof plugin.command === 'string'
          ? plugin.command === command
          : false;

      if (!isAccept) continue;

      m.plugin = name;

      let isAdmin = false;
      let isBotAdmin = false;

      if (m.isGroup) {
        try {
          const meta = await conn.groupMetadata(m.chat).catch(() => null);
          if (meta) {
            const participants = meta.participants || [];
            const senderEntry = participants.find(p =>
              conn.decodeJid(p.id || p.jid) === conn.decodeJid(m.sender)
            );
            const botEntry = participants.find(p =>
              conn.decodeJid(p.id || p.jid) === conn.decodeJid(conn.user.jid)
            );
            isAdmin = senderEntry?.admin === 'admin' || senderEntry?.admin === 'superadmin';
            isBotAdmin = botEntry?.admin === 'admin' || botEntry?.admin === 'superadmin';

            if (!global.groupCache) global.groupCache = new Map();
            global.groupCache.set(m.chat, {
              data: { groupMetadata: meta, participants },
              timestamp: Date.now(),
            });
          }
        } catch {}
      }

      if (plugin.rowner && !_isOwner) {
        m.reply('*[ ⛔ ]* Este comando es solo para el propietario del bot.');
        continue;
      }
      if (plugin.owner && !_isOwner) {
        m.reply('*[ ⛔ ]* Solo el owner puede usar este comando.');
        continue;
      }
      if (plugin.premium && !_isPrems) {
        m.reply('*[ 💎 ]* Este comando es solo para usuarios premium.');
        continue;
      }
      if (plugin.group && !m.isGroup) {
        m.reply('*[ 👥 ]* Este comando solo funciona en grupos.');
        continue;
      }
      if (plugin.private && m.isGroup) {
        m.reply('*[ 🔒 ]* Este comando solo funciona en privado.');
        continue;
      }
      if (plugin.admin && m.isGroup && !isAdmin) {
        m.reply('*[ 🔰 ]* Este comando es solo para administradores del grupo.');
        continue;
      }
      if (plugin.botAdmin && m.isGroup && !isBotAdmin) {
        m.reply('*[ 🤖 ]* Necesito ser administrador del grupo para esto.');
        continue;
      }

      try {
        conn.sendPresenceUpdate('composing', m.chat).catch(() => {});
        await plugin.call(conn, m, {
          conn,
          args,
          text,
          usedPrefix: prefixMatch,
          command,
          isOwner: _isOwner,
          isROwner: _isOwner,
          isAdmin,
          isBotAdmin,
          isPrems: _isPrems,
          chatUpdate,
        });
      } catch (e) {
        logError(e, name);
        const errText = e?.message || String(e);
        if (errText) m.reply(`*[ ❌ ] Error:*\n\`\`\`${errText}\`\`\``).catch(() => {});
      }

      break;
    }
  } catch (e) {
    console.error(chalk.red('[Handler Error]'), e.message);
  }
}

export async function participantsUpdate({ id, participants, action }) {
  try {
    const conn = global.conn;
    if (!conn?.user?.jid) return;

    const groupMeta = await conn.groupMetadata(id).catch(() => null);
    const groupName = groupMeta?.subject || id;

    for (const jid of participants) {
      let num = jid.split('@')[0];
      let tag = '@' + num;

      const msgs = {
        add: `*[ 👋 ] Bienvenid@ al grupo!*\n\nHola ${tag}, bienvenid@ a *${groupName}*!\n> Disfruta tu estadía 🌸`,
        remove: `*[ 👋 ] Adiós!*\n\n${tag} ha salido de *${groupName}*.\n> ¡Hasta pronto! 💫`,
        promote: `*[ 🔰 ] Nuevo Admin*\n\n${tag} ahora es administrador de *${groupName}*.`,
        demote: `*[ 📉 ] Admin Removido*\n\n${tag} ya no es administrador de *${groupName}*.`,
      };

      const text = msgs[action];
      if (text) {
        const chatData = global.db?.data?.chats?.[id] || {};
        if (
          (action === 'add' && chatData.welcome !== false) ||
          (action === 'remove' && chatData.bye !== false) ||
          (action === 'promote' || action === 'demote')
        ) {
          await conn.sendMessage(id, { text, mentions: [jid] }).catch(() => {});
        }
      }
    }
  } catch {}
}

function matchPrefix(text, prefix) {
  if (!text) return null;
  if (prefix instanceof RegExp) {
    const m = prefix.exec(text);
    return m ? m[0] : null;
  }
  if (typeof prefix === 'string' && text.startsWith(prefix)) return prefix;
  if (Array.isArray(prefix)) {
    for (const p of prefix) {
      const result = matchPrefix(text, p);
      if (result !== null) return result;
    }
  }
  return null;
}

function logError(e, plugin = 'unknown') {
  console.log(chalk.red(`\n[ ❌ ] Error en plugin: ${chalk.yellow(plugin)}`));
  console.log(chalk.red(`→ ${e?.message || String(e)}`));
}

export async function reloadPlugin(filename) {
  const filepath = path.join(__dirname, 'plugins', filename);
  if (!fs.existsSync(filepath)) {
    delete global.plugins[filename];
    console.log(chalk.red(`[ 🗑️ ] Plugin eliminado: ${filename}`));
    return;
  }
  try {
    const mod = await import(`${filepath}?t=${Date.now()}`);
    global.plugins[filename] = mod.default;
    console.log(chalk.green(`[ 🔄 ] Plugin recargado: ${filename}`));
  } catch (e) {
    console.log(chalk.red(`[ ❌ ] Error al recargar ${filename}: ${e.message}`));
  }
}
