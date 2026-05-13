import { WAMessageStubType } from "@whiskeysockets/baileys";
import PhoneNumber from 'awesome-phonenumber';
import chalk from 'chalk';
import { watchFile } from 'fs';
import { resolveToPhoneJidAsync, isLidJid } from '../funcion/lid-resolver.js';

const terminalImage = global.opts['img'] ? require('terminal-image') : '';
const urlRegex = (await import('url-regex-safe')).default({ strict: false });

const MAX_MESSAGE_LENGTH = 400;

function formatPhone(jid) {
  if (!jid) return 'desconocido';
  // Quitar sufijo de dispositivo: 51925092348:15@s.whatsapp.net → 51925092348
  const num = jid
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@lid$/, '')
    .replace(/@c\.us$/, '')
    .replace(/:\d+$/, '');
  if (!num || !/^\d+$/.test(num)) return num || 'desconocido';
  try {
    return PhoneNumber('+' + num).getNumber('international') || num;
  } catch (_) {
    return num;
  }
}

/**
 * Resuelve el JID real del sender usando el LIDMappingStore nativo de Baileys.
 * Síncrono primero (LRU cache), async como fallback (DB persistente).
 */
async function resolveSenderJid(rawSender, conn) {
  if (!rawSender) return rawSender;
  if (!isLidJid(rawSender)) return rawSender;

  // Síncrono: LRU cache del LIDMappingStore
  const mappingCache = conn?.signalRepository?.lidMapping?.mappingCache;
  if (mappingCache) {
    const lidKey = rawSender.split('@')[0];
    const pnUser = mappingCache.get(`lid:${lidKey}`);
    if (pnUser && typeof pnUser === 'string') return `${pnUser}@s.whatsapp.net`;
  }

  // Async: consulta DB persistente de Baileys
  const resolved = await resolveToPhoneJidAsync(rawSender, conn);
  if (resolved && !isLidJid(resolved)) return resolved;

  return rawSender; // sin resolver — devuelve el LID original
}

export default async function(m, conn = { user: {} }) {
  // Resolver sender: LID → @s.whatsapp.net usando solo Baileys nativo
  const senderJid = await resolveSenderJid(m.sender || '', conn);

  const _name = await conn.getName(senderJid);
  const sender = formatPhone(senderJid) + (_name ? ' ~' + _name : '');
  const chat   = await conn.getName(m.chat);

  let img;
  try {
    if (global.opts['img']) {
      img = /sticker|image/gi.test(m.mtype)
        ? await terminalImage.buffer(await m.download())
        : false;
    }
  } catch (e) {
    console.error(e);
  }

  const filesize = (m.msg
    ? m.msg.vcard
      ? m.msg.vcard.length
      : m.msg.fileLength
        ? m.msg.fileLength.low || m.msg.fileLength
        : m.msg.axolotlSenderKeyDistributionMessage
          ? m.msg.axolotlSenderKeyDistributionMessage.length
          : m.text ? m.text.length : 0
    : m.text ? m.text.length : 0) || 0;

  // Usar el JID resuelto para buscar en la DB de usuarios
  const user = global.db.data.users[senderJid] || global.db.data.users[m.sender];
  const me   = formatPhone(conn.user?.jid || conn.user?.id || '');

  console.log(
    `▣────────────···\n│ ${chalk.hex('#7ecfff').bold('%s')}\n│⏰ㅤ${chalk.hex('#1a1a2e')(chalk.bgHex('#cdb4db')('%s'))}\n│📑ㅤ${chalk.hex('#1a1a2e')(chalk.bgHex('#b5ead7')('%s'))}\n│📊ㅤ${chalk.hex('#ffafcc')('%s [%s %sB]')}\n│📤ㅤ${chalk.hex('#ff85c2').bold('%s')}\n│📃ㅤ${chalk.hex('#ffd6e7')('%s%s')}\n│📥ㅤ${chalk.hex('#a8dadc').bold('%s')}\n│💬ㅤ${chalk.hex('#1a1a2e')(chalk.bgHex('#ffafcc')('%s'))}\n▣────────────···`.trim(),
    me + ' ~' + conn.user.name + (conn.user.jid == global.conn.user.jid ? '' : ' (Sub Bot)'),
    (m.messageTimestamp
      ? new Date(1000 * (m.messageTimestamp.low || m.messageTimestamp))
      : new Date()).toTimeString(),
    m.messageStubType ? WAMessageStubType[m.messageStubType] : '',
    filesize,
    filesize === 0 ? 0 : (filesize / 1009 ** Math.floor(Math.log(filesize) / Math.log(1000))).toFixed(1),
    ['', ...'KMGTP'][Math.floor(Math.log(filesize) / Math.log(1000))] || '',
    sender,
    m ? m.exp : '?',
    user ? '|' + user.exp + '|' + user.limit + '|' + user.level : '',
    m.chat + (chat ? ' ~' + chat : ''),
    m.mtype
      ? m.mtype
          .replace(/message$/i, '')
          .replace('audio', m.msg?.ptt ? 'PTT' : 'audio')
          .replace(/^./, v => v.toUpperCase())
      : ''
  );

  if (img) console.log(img.trimEnd());

  if (typeof m.text === 'string' && m.text) {
    let log = m.text.replace(/\u200e+/g, '');

    let mdRegex = /(?<=(?:^|[\s\n])\S?)(?:([*_~`])(?!`)(.+?)\1|```((?:.|[\n\r])+?)```|`([^`]+?)`)(?=\S?(?:[\s\n]|$))/g;
    let mdFormat = (depth = 4) => (_, type, text, monospace) => {
      const types = { '_': 'italic', '*': 'bold', '~': 'strikethrough', '`': 'bgGray' };
      text = text || monospace;
      return !types[type] || depth < 1
        ? text
        : chalk[types[type]](text.replace(/`/g, '').replace(mdRegex, mdFormat(depth - 1)));
    };

    log = log.replace(mdRegex, mdFormat(4));

    if (log.length > MAX_MESSAGE_LENGTH) {
      log = log.substring(0, MAX_MESSAGE_LENGTH) + '\n' + chalk.blue('Character Limit Exceeded...');
    }

    log = log.split('\n').map(line => {
      if (line.trim().startsWith('>'))
        return chalk.bgGray.dim(line.replace(/^>/, '┃'));
      if (/^([1-9]|[1-9][0-9])\./.test(line.trim()))
        return line.replace(/^(\d+)\./, (_, n) => (n.length === 1 ? '  ' : ' ') + n + '.');
      if (/^[-*]\s/.test(line.trim()))
        return line.replace(/^[*-]/, '  •');
      return line;
    }).join('\n');

    log = log.replace(urlRegex, (url, i, text) => {
      const end = url.length + i;
      return i === 0 || end === text.length ||
        (/^\s$/.test(text[end]) && /^\s$/.test(text[i - 1]))
        ? chalk.blueBright(url) : url;
    });

    log = log.replace(mdRegex, mdFormat(4));

    const mentions = await m.mentionedJid;
    if (mentions) {
      for (const u of mentions) {
        const uStr = typeof u === 'string' ? u : (u.jid || u.lid || u.id || '');
        if (!uStr) continue;
        // Si la mención es un LID, resolverla para mostrar el nombre real
        const resolvedU = isLidJid(uStr)
          ? await resolveSenderJid(uStr, conn)
          : uStr;
        const username = await conn.getName(resolvedU || uStr);
        log = log.replace('@' + uStr.split('@')[0], chalk.blueBright('@' + (username || uStr.split('@')[0])));
      }
    }

    console.log(log);
  }

  if (m.messageStubParameters) {
    console.log(
      m.messageStubParameters
        .map(jid => {
          try {
            if (!jid || typeof jid !== 'string') return '';
            const decodedJid = conn.decodeJid(jid);
            if (!decodedJid) return '';
            const name = conn.getName(decodedJid) || '';
            const phoneNumber = decodedJid
              .replace('@s.whatsapp.net', '')
              .replace('@lid', '')
              .replace(/:\d+$/, '');
            let formattedNumber = phoneNumber;
            try {
              formattedNumber = PhoneNumber('+' + phoneNumber).getNumber('international') || phoneNumber;
            } catch {}
            return chalk.gray(formattedNumber + (name ? ' ~' + name : ''));
          } catch (error) {
            console.error('Error processing messageStubParameter:', error);
            return '';
          }
        })
        .filter(Boolean)
        .join(', ')
    );
  }

  if (/document/i.test(m.mtype))       console.log(`🗂️ ${m.msg.fileName || m.msg.displayName || 'Document'}`);
  else if (/ContactsArray/i.test(m.mtype)) console.log(`👨‍👩‍👧‍👦 ${' ' || ''}`);
  else if (/contact/i.test(m.mtype))   console.log(`👨 ${m.msg.displayName || ''}`);
  else if (/audio/i.test(m.mtype)) {
    const duration = m.msg.seconds;
    console.log(`${m.msg.ptt ? '🎤ㅤ(PTT ' : '🎵ㅤ('}AUDIO) ${Math.floor(duration / 60).toString().padStart(2, 0)}:${(duration % 60).toString().padStart(2, 0)}`);
  }
}

const file = global.__filename(import.meta.url);
watchFile(file, () => {
  console.log(chalk.redBright("Update 'lib/print.js'"));
});
    
