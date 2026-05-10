/**
 * handler.js — Rikka-TakaradaMD
 * ════════════════════════════════════════════════════════════════════════════
 * Reescrito desde cero.
 * Usa src/funcion/index.js   → resolver universal (JID / LID / sender / admin)
 * Usa src/funcion/defaults.js → valores iniciales de DB
 *
 * NO contiene resolvers inline. Todo va a través del módulo funcion/.
 * ════════════════════════════════════════════════════════════════════════════
 */

// ── Imports externos ──────────────────────────────────────────────────────────
import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import { smsg }         from './src/libraries/simple.js';
import { format }       from 'util';
import { fileURLToPath } from 'url';
import path             from 'path';
import { watchFile, unwatchFile } from 'fs';
import fs               from 'fs';
import chalk            from 'chalk';
import ws               from 'ws';

// ── Resolver universal ────────────────────────────────────────────────────────
import {
  // Decode / normalize
  decodeJidSafe,
  // Phone utils
  phoneFromJid,
  toPhoneJid,
  // LID resolution
  resolveLidSync,
  resolveSender,
  // Participants
  resolveParticipantJid,
  // Owner / admin
  buildOwnerList,
  isOwnerJid,
  isBotAdminInGroup,
  // Message utils
  isValidMessage,
  isDuplicate,
  extractMessageText,
} from './src/funcion/index.js';

// ── Defaults de DB ────────────────────────────────────────────────────────────
import {
  getDefaultUser,
  getDefaultAkinator,
  getDefaultGameGlx,
  getDefaultChat,
  getDefaultSettings,
} from './src/funcion/defaults.js';

// ── Print module ──────────────────────────────────────────────────────────────
import _printMod from './src/libraries/print.js';
const _print = _printMod?.default ?? _printMod;

// ── Baileys proto (async top-level import) ────────────────────────────────────
const { proto } = (await import('@whiskeysockets/baileys')).default;

// ══════════════════════════════════════════════════════════════════════════════
// ESTADO DEL MÓDULO  (singleton por proceso)
// ══════════════════════════════════════════════════════════════════════════════

const _recentMsgs  = new Map();  // caché de deduplicación
const _prefixCache = new Map();  // caché de regex de prefijos
const _initUsers   = new Set();  // usuarios ya inicializados en DB esta sesión

const DEDUP_TTL  = 3_000;   // ventana anti-duplicate en ms
const DEDUP_MAX  = 150;      // máximo de entradas en caché
const META_TTL   = 5 * 60_000; // caché de groupMetadata en ms (5 min)

/** Referencia al último mensaje procesado (accesible por eventos paralelos). */
let _mconn;

// Limpia el caché de dedup cada 30 s para no crecer indefinidamente.
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of _recentMsgs)
    if (now - ts > DEDUP_TTL * 3) _recentMsgs.delete(k);
}, 30_000);

// ══════════════════════════════════════════════════════════════════════════════
// SUB-BOT: lista blanca de comandos permitidos
// ══════════════════════════════════════════════════════════════════════════════

const _SUBBOT_CMDS = new Set([
  // Sticker
  's', 'sticker', 'st',
  // TikTok
  'tiktok', 'ttdl', 'tiktokdl', 'tiktoknowm', 'tt', 'ttnowm', 'tiktokaudio', 'tiktok2', 'tt2',
  // Facebook
  'fb', 'facebook', 'fbdl',
  // Play
  'play', 'play2', 'playaudio', 'mp4', 'video',
  // Gacha
  'rw', 'rollwaifu', 'roll', 'c', 'claim', 'reclamar',
  'harem', 'waifus', 'claims', 'mischicas',
  'ginfo', 'infogacha', 'gachainfo',
  'sell', 'vender', 'buyc', 'buychar', 'comprarwaifu', 'wshop', 'haremshop', 'tiendawaifus',
  'trade', 'intercambiar', 'aceptar', 'accept',
  'setfav', 'setfavourite', 'favorito', 'charimage', 'waifuimage', 'cimage', 'wimage', 'charinfo', 'wifu',
  'removesale', 'quitarventa', 'cancelsale',
  'balance', 'bal', 'monedas', 'coins', 'deposit', 'depositar', 'withdraw', 'retirar',
  'daily', 'diario', 'weekly', 'semanal', 'monthly', 'mensual', 'work', 'trabajar', 'farm',
  // Waifu / neko
  'waifu', 'neko',
  // Interacciones anime
  ...['pat','kiss','hug','slap','fuck','bite','lick','dance','cry','blush','wave',
      'punch','run','sleep','laugh','angry','bored','clap','coffee','cuddle',
      'pout','sad','scared','shy','smile','stare','think','wink','eat','bleh',
      'bonk','blowkiss','call','cold','comfort','cringe','curious','draw','dramatic',
      'drunk','gaming','handhold','happy','heat','highfive','impregnate','jump',
      'kill','kisscheek','love','nope','peek','push','scream','seduce','sing',
      'smoke','smug','sniff','snuggle','spit','step','thinkhard','tickle',
      'trip','walk','bath','bully','abrazar','besar','acariciar','morder','lamer',
      'bailar','llorar','sonrojarse','saludar','golpear','correr','dormir',
      'reir','enojado','aburrido','aplaudir','cafe','acurrucar','mueca',
      'triste','asustado','timido','sonreir','fumar','escupir','pisar',
      'caminar','guiñar','comer','nom','bañarse','molestar','pensar',
      'muak','choca','tomarlamano','calor','jugar','dibujar','llamar',
      'besito','tropezar','mirar','oler','curioso','consolar','embarazar',
      'besomejilla','coger','follar','preñar'],
]);

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS PRIVADOS
// ══════════════════════════════════════════════════════════════════════════════

/** Convierte un string de prefijo a RegExp con caché. */
function _toPrefixRe(str) {
  if (_prefixCache.has(str)) return _prefixCache.get(str);
  const re = new RegExp(str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&'));
  _prefixCache.set(str, re);
  return re;
}

/** Construye los pares [matchResult, regex] para todos los prefijos. */
function _matchPrefix(text, prefix) {
  if (prefix instanceof RegExp)
    return [[prefix.exec(text), prefix]];
  if (Array.isArray(prefix))
    return prefix.map(p => { const re = p instanceof RegExp ? p : _toPrefixRe(p); return [re.exec(text), re]; });
  if (typeof prefix === 'string')
    return [[_toPrefixRe(prefix).exec(text), _toPrefixRe(prefix)]];
  return [[[], new RegExp]];
}

/** Delay numérico. */
const _delay = ms => new Promise(r => setTimeout(r, ms));

/** Detecta IDs de mensajes conocidos de bots/spam que deben ignorarse. */
function _isSpamId(id = '') {
  return (
    id.startsWith('EVO')              ||
    id.startsWith('Lyru-')            ||
    id.startsWith('B24E')             ||
    id.startsWith('FizzxyTheGreat-')  ||
    (id.startsWith('BAE5') && id.length === 16) ||
    (id.startsWith('8SCO') && id.length === 20)
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// §A  INICIALIZACIÓN DE DB
//     Rellena campos faltantes del usuario/chat/settings sin sobreescribir
//     lo que ya existe (Object.assign con defaults primero, luego los datos).
// ══════════════════════════════════════════════════════════════════════════════

function _initDb(m, conn) {
  const db = global.db.data;

  // ── Usuario ────────────────────────────────────────────────────────────────
  if (typeof db.users[m.sender] !== 'object') db.users[m.sender] = {};
  const user = db.users[m.sender];

  if (!_initUsers.has(m.sender)) {
    _initUsers.add(m.sender);
    Object.assign(user, { ...getDefaultUser(m.name), ...user });
  }

  // Akinator sub-objeto
  if (typeof user.akinator !== 'object') user.akinator = {};
  Object.assign(user.akinator, { ...getDefaultAkinator(), ...user.akinator });

  // GameGlx sub-objeto
  if (typeof user.gameglx !== 'object') user.gameglx = {};
  Object.assign(user.gameglx, { ...getDefaultGameGlx(), ...user.gameglx });

  // ── Chat ───────────────────────────────────────────────────────────────────
  if (typeof db.chats[m.chat] !== 'object') db.chats[m.chat] = {};
  Object.assign(db.chats[m.chat], { ...getDefaultChat(), ...db.chats[m.chat] });

  // ── Settings ───────────────────────────────────────────────────────────────
  const botJid = conn?.user?.jid;
  if (botJid) {
    if (typeof db.settings[botJid] !== 'object') db.settings[botJid] = {};
    Object.assign(db.settings[botJid], { ...getDefaultSettings(), ...db.settings[botJid] });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// §B  METADATA DE GRUPO (con caché TTL)
//     Evita llamar groupMetadata() en cada mensaje de un mismo grupo.
// ══════════════════════════════════════════════════════════════════════════════

async function _getGroupMeta(conn, chatId) {
  const chatStore = conn.chats[chatId] ??= {};
  const lastFetch  = chatStore._metaFetchedAt || 0;

  if (!chatStore.metadata || Date.now() - lastFetch > META_TTL) {
    try {
      chatStore.metadata       = await conn.groupMetadata(chatId);
      chatStore._metaFetchedAt = Date.now();
    } catch {}
  }

  const raw   = chatStore.metadata || {};
  const parts = (raw.participants || []).map(p => ({
    id:    decodeJidSafe(p.id || p.jid || ''),
    jid:   decodeJidSafe(p.id || p.jid || ''),
    lid:   p.lid   || null,
    admin: p.admin || null,
    phoneNumber: p.phoneNumber || null,
  }));

  return { meta: { ...raw, participants: parts }, participants: parts };
}

// ══════════════════════════════════════════════════════════════════════════════
// §C  ENCONTRAR PARTICIPANTE  (sender o bot dentro del grupo)
//     Compara por JID, teléfono y LID resuelto.
// ══════════════════════════════════════════════════════════════════════════════

function _findParticipant(targetJid, participants, conn) {
  if (!targetJid || !participants.length) return {};
  const tp = phoneFromJid(targetJid);

  return participants.find(p => {
    const pId = decodeJidSafe(p.id || '');
    if (pId && (pId === targetJid || phoneFromJid(pId) === tp)) return true;
    if (p.lid) {
      const rl = resolveLidSync(decodeJidSafe(p.lid), conn);
      if (rl && phoneFromJid(rl) === tp) return true;
    }
    return false;
  }) || {};
}

// ══════════════════════════════════════════════════════════════════════════════
// §D  BOT PRIMARIO
//     Verifica si hay un bot primario asignado al chat y si el bot actual debe
//     responder.
// ══════════════════════════════════════════════════════════════════════════════

function _checkPrimaryBot(chatId, currentBotJid) {
  const chatData = global.db.data.chats[chatId] || {};
  if (!chatData.setPrimaryBot) return true; // sin restricción

  const primJid = chatData.setPrimaryBot.replace(/\D/g, '') + '@s.whatsapp.net';
  const currJid = currentBotJid.replace(/\D/g, '') + '@s.whatsapp.net';

  // Verificar que el bot primario esté activo
  const isActive = primJid === global.conn.user.jid ||
    (global.conns || []).some(c => c.user?.jid === primJid);

  if (!isActive) {
    // Bot primario desconectado → limpiar
    delete chatData.setPrimaryBot;
    global.db.data.chats[chatId] = chatData;
    return true;
  }

  return currJid === primJid;
}

// ══════════════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL  — exportado y llamado por main.js / index.js
// ══════════════════════════════════════════════════════════════════════════════

export async function handler(chatUpdate) {
  this.msgqueque = this.msgqueque || [];
  if (!chatUpdate?.messages?.length) return;

  const opts = global.opts || {};
  const conn = this;

  // ── Filtrar mensajes anteriores a la conexión ──────────────────────────────
  const connTime = global.timestamp?.connect?.getTime() || Date.now();
  chatUpdate.messages = chatUpdate.messages.filter(
    msg => (msg.messageTimestamp || 0) * 1000 >= connTime - 60_000
  );
  if (!chatUpdate.messages.length) return;

  conn.pushMessage(chatUpdate.messages).catch(console.error);

  const rawMsg = chatUpdate.messages[chatUpdate.messages.length - 1];
  if (!rawMsg) return;

  // ── Validación básica ──────────────────────────────────────────────────────
  if (!isValidMessage(rawMsg)) return;

  const _rawText   = extractMessageText(rawMsg);
  const _rawSender = rawMsg.key?.fromMe
    ? (conn.user?.id || '')
    : (rawMsg.key?.participant || rawMsg.key?.remoteJid || '');

  if (isDuplicate(rawMsg.key?.id, _rawSender, _rawText, _recentMsgs, DEDUP_TTL, DEDUP_MAX)) return;

  // ── Carga de DB ────────────────────────────────────────────────────────────
  if (global.db.data == null) await global.loadDatabase();

  // `m` declarado aquí para que el bloque finally siempre pueda accederlo.
  let m;

  try {
    // ── smsg: serializar el mensaje con utilidades ──────────────────────────
    m = smsg(conn, rawMsg) || rawMsg;
    if (!m) return;

    // Referencia global al mensaje actual (usada por eventos paralelos)
    global.mconn = m;
    _mconn       = m;
    m.exp        = 0;
    m.money      = false;
    m.limit      = false;

    // ── Inicializar DB para este sender/chat ───────────────────────────────
    _initDb(m, conn);

    // ── Filtros globales de opts ───────────────────────────────────────────
    if (opts.nyimak) return;
    if (!m.fromMe && opts.self) return;
    if (opts.pconly && m.chat.endsWith('@g.us')) return;
    if (opts.gconly && !m.chat.endsWith('@g.us')) return;
    if (opts.swonly && m.chat !== 'status@broadcast') return;
    if (typeof m.text !== 'string') m.text = '';

    // ── Resolver sender a JID canónico ─────────────────────────────────────
    const senderJid   = resolveSender(m.sender, conn);
    const senderPhone = phoneFromJid(senderJid);

    // ── Permisos base ──────────────────────────────────────────────────────
    const ownerList = buildOwnerList(global.owner);
    const isROwner  = m.fromMe || isOwnerJid(senderJid, ownerList);
    const isOwner   = isROwner;

    const modsList  = (global.mods || []).map(v => toPhoneJid(v.replace(/\D/g, '')));
    const isMods    = isOwner || modsList.some(mJid => {
      const mp = phoneFromJid(mJid);
      return mp && senderPhone && mp === senderPhone;
    });

    // Premium (premiumTime es timestamp de expiración Unix ms)
    const _uRec    = global.db.data.users[m.sender] || {};
    const _premExp = typeof _uRec.premiumTime === 'number' ? _uRec.premiumTime : 0;
    const isPremium = _premExp > Date.now();
    if (_premExp > 0 && !isPremium) { _uRec.premiumTime = 0; _uRec.premium = false; }

    const isPrems   = isROwner || isOwner || isMods || isPremium;

    // ── Detectar si este bot es un sub-bot ────────────────────────────────
    const thisBotJid = conn.user?.jid || '';
    const thisBotPhone = phoneFromJid(thisBotJid);
    const _isSubBot  = !ownerList.some(o => phoneFromJid(o) === thisBotPhone)
                       && (global.conns || []).some(c => c.user?.jid === thisBotJid);

    // ── Cola anti-spam (para usuarios normales) ────────────────────────────
    if (opts.queque && m.text && !(isMods || isPrems)) {
      const q    = conn.msgqueque;
      const prev = q[q.length - 1];
      q.push(m.id || m.key.id);
      const interval = setInterval(async () => {
        if (!q.includes(prev)) { clearInterval(interval); return; }
        await _delay(5_000);
      }, 5_000);
    }

    if (m.isBaileys) return;
    m.exp += Math.ceil(Math.random() * 10);

    // ── Group metadata ────────────────────────────────────────────────────
    let groupMetadata = {};
    let participants  = [];

    if (m.isGroup) {
      const { meta, participants: parts } = await _getGroupMeta(conn, m.chat);
      groupMetadata = meta;
      participants  = parts;

      // Registrar mapeos LID→JID desde los participantes del grupo
      if (conn.resolveLid?.bulkCacheFromParticipants) {
        conn.resolveLid.bulkCacheFromParticipants(participants);
      }
    }

    // ── Participante: sender y bot dentro del grupo ───────────────────────
    const pUser     = m.isGroup ? _findParticipant(senderJid, participants, conn) : {};
    const pBot      = m.isGroup ? _findParticipant(thisBotJid, participants, conn) : {};
    const isRAdmin  = pUser?.admin === 'superadmin';
    const isAdmin   = isRAdmin || pUser?.admin === 'admin' || isROwner;
    const isBotAdmin = pBot?.admin === 'admin' || pBot?.admin === 'superadmin';

    // ── Directorio de plugins ─────────────────────────────────────────────
    const pluginsDir = (handler._pluginsDir ??= path.join(
      path.dirname(fileURLToPath(import.meta.url)), 'plugins'
    ));

    let usedPrefix;

    // ════════════════════════════════════════════════════════════════════════
    // LOOP DE PLUGINS
    // ════════════════════════════════════════════════════════════════════════

    for (const name in global.plugins) {
      const plugin = global.plugins[name];
      if (!plugin || plugin.disabled) continue;

      const __filename = path.join(pluginsDir, name);
      const __ctx      = { chatUpdate, __dirname: pluginsDir, __filename };

      // ── plugin.all (se ejecuta para TODOS los mensajes) ─────────────────
      if (typeof plugin.all === 'function') {
        try {
          await plugin.all.call(conn, m, __ctx);
        } catch (e) { console.error('[plugin.all]', name, e); }
      }

      // Saltar plugins de admin si el bot está en modo restricción
      if (!opts.restrict && plugin.tags?.includes('admin')) continue;

      // ── Match de prefijo ─────────────────────────────────────────────────
      const _pfx   = plugin.customPrefix ?? conn.prefix ?? global.prefix;
      const pairs  = _matchPrefix(m.text, _pfx);
      const pair   = pairs.find(([res]) => res);

      // ── plugin.before ────────────────────────────────────────────────────
      if (typeof plugin.before === 'function') {
        const beforeCtx = {
          ...(__ctx),
          match: pair, conn,
          participants, groupMetadata,
          user: pUser, bot: pBot,
          isROwner, isOwner, isRAdmin, isAdmin, isBotAdmin, isPrems,
        };
        try {
          if (await plugin.before.call(conn, m, beforeCtx)) continue;
        } catch (e) { console.error('[plugin.before]', name, e); continue; }
      }

      if (typeof plugin !== 'function') continue;

      // ── Sólo procesar si hay prefijo en el mensaje ───────────────────────
      if (!pair) continue;
      if (!(usedPrefix = (pair[0] || '')[0])) continue;

      const noPrefix = m.text.replace(usedPrefix, '');
      const parts    = noPrefix.trim().split(/\s+/).filter(Boolean);
      let   command  = (parts[0] || '').toLowerCase();
      const args     = parts.slice(1);
      const _args    = noPrefix.trim().split(/\s+/).slice(1);
      const text     = _args.join(' ');

      // ── Verificar que el comando coincide ────────────────────────────────
      const isAccept =
        plugin.command instanceof RegExp  ? plugin.command.test(command)
        : Array.isArray(plugin.command)   ? plugin.command.some(c =>
            c instanceof RegExp ? c.test(command) : c === command)
        : typeof plugin.command === 'string' ? plugin.command === command
        : false;

      if (!isAccept) continue;

      // ── Sub-bot: sólo comandos de la lista blanca ────────────────────────
      if (_isSubBot && !_SUBBOT_CMDS.has(command)) continue;

      // ── Ignorar IDs de bots/spam conocidos ──────────────────────────────
      if (_isSpamId(m.id)) continue;

      m.plugin = name;

      // ── Comprobaciones de estado en DB ───────────────────────────────────
      const _chatDb = global.db.data.chats[m.chat]   || {};
      const _userDb = global.db.data.users[m.sender] || {};
      const _setts  = global.db.data.settings[_mconn?.conn?.user?.jid] || {};

      // Chat baneado
      if (!['owner-update.js'].includes(name) && _chatDb.isBanned && !isROwner) continue;

      // Usuario baneado
      if (m.text && _userDb.banned && !isROwner) {
        _userDb.bannedMessageCount = _userDb.bannedMessageCount || 0;
        if (_userDb.bannedMessageCount < 3) {
          const reason = _userDb.bannedReason || 'Sin razón especificada';
          m.reply(`⛔ Tu cuenta ha sido suspendida.\n📋 Razón: ${reason}\n⚠️ Advertencia ${_userDb.bannedMessageCount + 1}/3`);
          _userDb.bannedMessageCount++;
        }
        continue;
      }

      // Anti-spam por tiempo entre comandos
      if (_setts.antispam && m.text && !isROwner) {
        const since = Date.now() - (_userDb.lastCommandTime || 0);
        if (since < 5_000) {
          if ((_userDb.commandCount || 0) >= 2) {
            const wait = Math.ceil(((_userDb.lastCommandTime || 0) + 5_000 - Date.now()) / 1000);
            if (wait > 0) {
              m.reply(`*[ ℹ️ ] Espera* _${wait} segundo(s)_ *antes de usar otro comando.*`);
              continue;
            }
            _userDb.commandCount = 0;
          } else {
            _userDb.commandCount = (_userDb.commandCount || 0) + 1;
          }
        } else {
          _userDb.lastCommandTime = Date.now();
          _userDb.commandCount    = 1;
        }
      }

      // Modo admin del grupo: sólo admins pueden usar comandos
      if (_chatDb.modoadmin && !isOwner && !isROwner && m.isGroup && !isAdmin) continue;

      // ── Permisos requeridos por el plugin ────────────────────────────────
      const fail = plugin.fail || global.dfail;

      if (plugin.rowner  && !isROwner)   { fail('rowner',   m, conn); continue; }
      if (plugin.owner   && !isOwner)    { fail('owner',    m, conn); continue; }
      if (plugin.mods    && !isMods)     { fail('mods',     m, conn); continue; }
      if (plugin.premium && !isPrems)    { fail('premium',  m, conn); continue; }
      if (plugin.group   && !m.isGroup)  { fail('group',    m, conn); continue; }
      if (plugin.botAdmin && !isBotAdmin){ fail('botAdmin', m, conn); continue; }
      if (plugin.admin   && !isAdmin)    { fail('admin',    m, conn); continue; }
      if (plugin.private && m.isGroup)   { fail('private',  m, conn); continue; }
      if (plugin.register && !_userDb.registered) { fail('unreg', m, conn); continue; }

      // ── Bot primario ──────────────────────────────────────────────────────
      if (!_checkPrimaryBot(m.chat, thisBotJid)) continue;

      // ── EXP del comando ───────────────────────────────────────────────────
      m.isCommand = true;
      const cmdXp  = 'exp' in plugin ? parseInt(plugin.exp) : 17;
      if (cmdXp > 200) m.reply('Ngecit -_-');
      else m.exp += cmdXp;

      // ── Límite de uso ────────────────────────────────────────────────────
      if (!isPrems && plugin.limit && (_userDb.limit || 0) < plugin.limit) {
        _mconn?.conn?.reply(m.chat, `Sin límites disponibles. Usa _${usedPrefix}buyall_`, m);
        continue;
      }

      // ── Nivel mínimo requerido ────────────────────────────────────────────
      if (plugin.level > (_userDb.level || 0)) {
        _mconn?.conn?.reply(m.chat,
          `Necesitas nivel ${plugin.level} para esto (tienes ${_userDb.level || 0}).`, m);
        continue;
      }

      // ── Contexto que se pasa al plugin ───────────────────────────────────
      const extra = {
        match:    pair,
        usedPrefix,
        noPrefix,
        _args,
        args,
        command,
        text,
        conn,
        participants,
        groupMetadata,
        user:       pUser,
        bot:        pBot,
        isROwner,
        isOwner,
        isRAdmin,
        isAdmin,
        isBotAdmin,
        isPrems,
        isPremium,
        isSubBot:   _isSubBot,
        chatUpdate,
        __dirname:  pluginsDir,
        __filename,
      };

      // ── Ejecutar plugin ───────────────────────────────────────────────────
      try {
        await plugin.call(conn, m, extra);
        if (!isPrems) m.limit = m.limit || plugin.limit || false;
      } catch (e) {
        m.error = e;
        console.error('[plugin.call]', name, e);
        if (e) {
          let errText = format(e);
          // Ocultar API keys del error
          for (const key of Object.values(global.APIKeys || {}))
            errText = errText.replace(new RegExp(key, 'g'), '#HIDDEN#');
          await m.reply(errText);
        }
      } finally {
        // plugin.after siempre se ejecuta aunque el plugin falle
        if (typeof plugin.after === 'function') {
          try { await plugin.after.call(conn, m, extra); }
          catch (e) { console.error('[plugin.after]', name, e); }
        }
        // Notificar límite usado
        if (m.limit)
          m.reply(`⚠️ Usaste ${+m.limit} límite${+m.limit !== 1 ? 's' : ''}.`);
      }

      break; // Sólo un plugin por mensaje
    }

  } catch (e) {
    console.error('[handler]', e);
  } finally {
    // ── Limpiar cola ─────────────────────────────────────────────────────────
    if (opts.queque && m?.text) {
      const idx = conn.msgqueque.indexOf(m.id || m.key?.id);
      if (idx !== -1) conn.msgqueque.splice(idx, 1);
    }

    // ── Actualizar EXP y límites del usuario ─────────────────────────────────
    if (m?.sender) {
      const u = global.db.data.users[m.sender];
      if (u) {
        u.exp   = (u.exp   || 0) + (m.exp   || 0);
        u.limit = (u.limit || 0) - (m.limit || 0) * 1;
      }
    }

    // ── Estadísticas de plugins ───────────────────────────────────────────────
    if (m?.plugin) {
      const now  = Date.now();
      const stat = (global.db.data.stats[m.plugin] ??= {
        total: 0, success: 0, last: now, lastSuccess: 0,
      });
      stat.total++;
      stat.last = now;
      if (!m.error) { stat.success++; stat.lastSuccess = now; }
    }

    // ── Print + autoread ──────────────────────────────────────────────────────
    try {
      if (!global.opts?.noprint) await _print(m, this);
    } catch (e) { console.error('[print]', e); }

    const _setts2 = global.db.data.settings[_mconn?.conn?.user?.jid] || {};
    if (global.opts?.autoread || _setts2.autoread2)
      await _mconn?.conn?.readMessages([m?.key]).catch(() => {});
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// EVENTO: participantsUpdate
// Se dispara cuando alguien entra o sale de un grupo, o cuando alguien sube /
// baja de admin.
// ══════════════════════════════════════════════════════════════════════════════

export async function participantsUpdate({ id, participants: rawParticipants, action }) {
  if (global.opts?.self) return;
  if (global.db.data == null) await global.loadDatabase();

  const chat   = global.db.data.chats[id] || {};
  const botSetts = global.db.data.settings[_mconn?.conn?.user?.jid] || {};

  // Normalizar participantes (resolver @lid, JSON, objetos)
  const conn = _mconn?.conn;
  const participants = (rawParticipants || [])
    .map(p => resolveParticipantJid(p, conn))
    .filter(Boolean);

  switch (action) {
    case 'add':
    case 'remove': {
      if (!chat.welcome || chat.isBanned) break;

      // Si el bot mismo fue removido, no enviar mensaje
      if (action === 'remove' && participants.includes(conn?.user?.jid)) break;

      const groupMetadata = await conn?.groupMetadata(id)
        .catch(() => conn?.chats?.[id]?.metadata || {});

      const antiArab = JSON.parse(fs.readFileSync('./src/antiArab.json', 'utf8') || '[]');
      const botJidClean   = conn?.user?.jid || '';
      const botPhoneClean = phoneFromJid(botJidClean);

      // Encontrar si el bot es admin en el grupo
      const botParticipant = (groupMetadata?.participants || []).find(p => {
        const pId = decodeJidSafe(p.id || p.jid || '');
        if (pId === botJidClean) return true;
        if (phoneFromJid(pId) === botPhoneClean) return true;
        if (p.lid) {
          const rl = resolveParticipantJid(p.lid, conn);
          if (phoneFromJid(rl) === botPhoneClean) return true;
        }
        return false;
      }) || {};
      const isBotAdminHere = ['admin','superadmin'].includes(botParticipant.admin);

      for (const userJid of participants) {
        try {
          // Anti-Arab: expulsar si el número está en la lista de prefijos bloqueados
          const userPrefix = antiArab.some(pfx => userJid.startsWith(pfx));
          if (userPrefix && chat.antiArab && botSetts.restrict && isBotAdminHere && action === 'add') {
            const result = await conn?.groupParticipantsUpdate(id, [userJid], 'remove');
            if (result?.[0]?.status === '404') continue;
            const fakeContact = {
              key: { participants: '0@s.whatsapp.net', remoteJid: 'status@broadcast', fromMe: false, id: 'Halo' },
              message: { contactMessage: { vcard: `BEGIN:VCARD\nVERSION:3.0\nN:Sy;Bot;;;\nFN:y\nitem1.TEL;waid=${userJid.split('@')[0]}:${userJid.split('@')[0]}\nitem1.X-ABLabel:Ponsel\nEND:VCARD` } },
              participant: '0@s.whatsapp.net',
            };
            await conn?.sendMessage(id, {
              text: `*[❗] @${userJid.split('@')[0]} ᴇɴ ᴇsᴛᴇ ɢʀᴜᴘᴏ ɴᴏ sᴇ ᴘᴇʀᴍɪᴛᴇɴ ɴᴜᴍᴇʀᴏs ᴀʀᴀʙᴇs ᴏ ʀᴀʀᴏs*`,
              mentions: [userJid],
            }, { quoted: fakeContact });
            continue;
          }

          // Foto de perfil
          const pp = await conn?.profilePictureUrl(userJid, 'image')
            .catch(() => 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png?q=60');
          const ppFile = await conn?.getFile(pp).catch(() => null);

          const userNum = userJid.split('@')[0];
          const subject = groupMetadata?.subject || 'el grupo';
          const desc    = groupMetadata?.desc?.toString() || '*SIN DESCRIPCIÓN*';

          const welcomeText = action === 'add'
            ? (chat.sWelcome || conn?.welcome || `¡Bienvenido/a @${userNum} a ${subject}!`)
                .replace('@subject', subject)
                .replace('@desc', desc)
                .replace('@user', `@${userNum}`)
            : (chat.sBye || conn?.bye || `Hasta luego, @${userNum}`)
                .replace('@user', `@${userNum}`);

          if (ppFile?.data) {
            await conn?.sendMessage(id, {
              image: ppFile.data,
              caption: welcomeText,
              mentions: [userJid],
            });
          } else {
            await conn?.sendMessage(id, { text: welcomeText, mentions: [userJid] });
          }
        } catch (e) { console.error('[participantsUpdate]', e); }
      }
      break;
    }

    case 'promote':
    case 'demote': {
      if (!chat.detect || chat.isBanned) break;
      const targetNum  = (participants[0] || '').split('@')[0];
      const actionText = action === 'promote'
        ? (chat.sPromote || conn?.spromote || `@${targetNum} ahora es Admin`)
        : (chat.sDemote  || conn?.sdemote  || `@${targetNum} ya no es Admin`);
      const finalText  = actionText.replace('@user', `@${targetNum}`);
      await conn?.sendMessage(id, { text: finalText, mentions: conn?.parseMention?.(finalText) || [`${targetNum}@s.whatsapp.net`] });
      break;
    }
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// EVENTO: groupsUpdate
// Se dispara cuando cambia la descripción, nombre, icono o link de un grupo.
// ══════════════════════════════════════════════════════════════════════════════

export async function groupsUpdate(groupsUpdate) {
  if (global.opts?.self) return;

  for (const update of groupsUpdate) {
    const { id } = update;
    if (!id) continue;
    if (update.subjectTime) continue; // ignorar cambios de timestamp de subject

    const chat = global.db.data?.chats?.[id];
    if (!chat?.detect || chat.isBanned) continue;

    let text = '';
    if (update.desc)    text = (chat.sDesc    || '```Descripción cambiada a```\n@desc').replace('@desc', update.desc);
    if (update.subject) text = (chat.sSubject || '```Nombre cambiado a```\n@subject').replace('@subject', update.subject);
    if (update.icon)    text = (chat.sIcon    || '```Ícono del grupo cambiado```');
    if (update.revoke)  text = (chat.sRevoke  || '```Link del grupo cambiado```\n@revoke').replace('@revoke', update.revoke);
    if (!text) continue;

    const conn = _mconn?.conn;
    await conn?.sendMessage(id, {
      text,
      mentions: conn?.parseMention?.(text) || [],
    }).catch(console.error);
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// EVENTO: callUpdate
// Reservado para futura implementación de anti-llamadas.
// ══════════════════════════════════════════════════════════════════════════════

export async function callUpdate(_callUpdate) {
  // Implementar anti-llamada aquí si se necesita.
}


// ══════════════════════════════════════════════════════════════════════════════
// EVENTO: deleteUpdate
// Se dispara cuando alguien elimina un mensaje; si antidelete está activo,
// reenvía el mensaje eliminado.
// ══════════════════════════════════════════════════════════════════════════════

export async function deleteUpdate(message) {
  try {
    if (message?.key?.fromMe) return;

    const msgId = message?.key?.id;
    if (!msgId) return;

    const conn = _mconn?.conn;
    const msg  = conn?.serializeM(conn?.loadMessage(msgId));
    if (!msg) return;

    const chatData = global.db.data?.chats?.[msg?.chat] || {};
    if (!chatData.antidelete) return;
    if (!msg?.isGroup) return;

    const participant    = message?.participant || message?.key?.participant || '';
    const participantNum = participant.split('@')[0];

    const now     = new Date(Date.now() + 3_600_000);
    const dateStr = now.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
    const timeStr = now.toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true });

    const notice = [
      `🗑️ *Mensaje eliminado detectado*`,
      `👤 Usuario: @${participantNum}`,
      `⏰ Hora: ${timeStr}`,
      `📅 Fecha: ${dateStr}`,
      ``,
      `📨 _Mensaje original rereenviado abajo:_`,
    ].join('\n');

    await conn?.sendMessage(
      msg.chat,
      { text: notice, mentions: participant ? [participant] : [] },
      { quoted: msg }
    );

    await conn?.copyNForward(msg.chat, msg).catch(() => {});
  } catch (e) {
    console.error('[deleteUpdate]', e);
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// global.dfail — respuesta cuando un plugin no se puede ejecutar por permisos
// ══════════════════════════════════════════════════════════════════════════════

global.dfail = (type, m, conn) => {
  // Mensajes vacíos (los plugins pueden sobreescribir con su propio `fail`).
  const msgs = {
    rowner:   '',
    owner:    '',
    mods:     '',
    premium:  '',
    group:    '',
    botAdmin: '',
    admin:    '',
    private:  '',
    unreg:    '',
  };
  const msg = msgs[type] || '';
  if (!msg) return;

  const chatPrim = global.db.data.chats[m.chat] || {};
  if (chatPrim.setPrimaryBot && !_checkPrimaryBot(m.chat, _mconn?.conn?.user?.jid || '')) return;

  const aa  = { quoted: m, userJid: conn.user.jid };
  const prep = generateWAMessageFromContent(m.chat, {
    extendedTextMessage: {
      text: msg,
      contextInfo: {
        externalAdReply: {
          title:     '',
          body:      '',
          thumbnail: global.imagen1,
          sourceUrl: '',
        },
      },
    },
  }, aa);

  conn.relayMessage(m.chat, prep.message, { messageId: prep.key.id });
};


// ══════════════════════════════════════════════════════════════════════════════
// HOT-RELOAD — recarga automática al guardar handler.js
// ══════════════════════════════════════════════════════════════════════════════

const _thisFile = global.__filename(import.meta.url, true);

watchFile(_thisFile, async () => {
  unwatchFile(_thisFile);
  console.log(chalk.redBright("♻️  Update 'handler.js' — recargando..."));
  if (global.reloadHandler) console.log(await global.reloadHandler());

  // Recargar también en sub-bots activos
  if (global.conns?.length) {
    const activeSubs = global.conns.filter(c =>
      c.user && c.ws?.socket?.readyState !== ws.CLOSED
    );
    for (const sub of activeSubs) {
      if (typeof sub.subreloadHandler === 'function')
        sub.subreloadHandler(false).catch(console.error);
    }
  }
});
