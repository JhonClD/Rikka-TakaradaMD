// nsfw-inter.js — Interacciones NSFW
// Portado de YukiBot-MD → Rikka-TakaradaMD

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NSFW_PATH = path.join(__dirname, '../core/nsfw.json');

async function resolveLid(jid, conn) {
  if (!jid || !jid.includes('@lid')) return jid;
  try { return await conn.signalRepository?.lidToJid?.(jid) || jid; } catch { return jid; }
}

const captions = {
  anal:        (f,t) => f===t ? 'se la metió en el ano.' : 'se la metió en el ano a',
  cum:         (f,t) => f===t ? 'se vino dentro de... Omitiremos eso.' : 'se vino dentro de',
  undress:     (f,t) => f===t ? 'se está quitando la ropa.' : 'le está quitando la ropa a',
  fuck:        (f,t) => f===t ? 'se entrega al deseo.' : 'se está cogiendo a',
  spank:       (f,t) => f===t ? 'está dando una nalgada.' : 'le está dando una nalgada a',
  lickpussy:   (f,t) => f===t ? 'está lamiendo un coño.' : 'le está lamiendo el coño a',
  fap:         (f,t) => f===t ? 'se está masturbando.' : 'se está masturbando pensando en',
  grope:       (f,t) => f===t ? 'se lo está manoseando.' : 'se lo está manoseando a',
  sixnine:     (f,t) => f===t ? 'está haciendo un 69.' : 'está haciendo un 69 con',
  suckboobs:   (f,t) => f===t ? 'está chupando unas ricas tetas.' : 'le está chupando las tetas a',
  grabboobs:   (f,t) => f===t ? 'está agarrando unas tetas.' : 'le está agarrando las tetas a',
  blowjob:     (f,t) => f===t ? 'está dando una rica mamada.' : 'le dio una mamada a',
  boobjob:     (f,t) => f===t ? 'está haciendo una rusa.' : 'le está haciendo una rusa a',
  footjob:     (f,t) => f===t ? 'está haciendo una paja con los pies.' : 'le está haciendo una paja con los pies a',
  yuri:        (f,t) => f===t ? 'está haciendo tijeras!' : 'hizo tijeras con',
  cummouth:    (f,t) => f===t ? 'está llenando la boca de alguien.' : 'está llenando la boca de',
  cumshot:     (f,t) => f===t ? 'le da un regalo sorpresa a alguien.' : 'le dio un regalo sorpresa a',
  handjob:     (f,t) => f===t ? 'le da una paja a alguien.' : 'le está haciendo una paja a',
  lickass:     (f,t) => f===t ? 'saborea un culo.' : 'le está lamiendo el culo a',
  lickdick:    (f,t) => f===t ? 'chupa un pene.' : 'se la mete en la boca para',
  fingering:   (f,t) => f===t ? 'se está metiendo los dedos.' : 'le está metiendo los dedos a',
  creampie:    (f,t) => f===t ? 'terminó dentro.' : 'terminó dentro de',
  facesitting: (f,t) => f===t ? 'está sentándose en una cara.' : 'se sentó en la cara de',
  deepthroat:  (f,t) => f===t ? 'se la traga hasta el fondo.' : 'le está haciendo una garganta profunda a',
  thighjob:    (f,t) => f===t ? 'está frotando entre los muslos.' : 'le está haciendo una entre piernas a',
  bondage:     (f,t) => f===t ? 'está atado y sin escapatoria.' : 'ató bien amarrado a',
  pegging:     (f,t) => f===t ? 'está recibiendo lo que no esperaba.' : 'le está dando por detrás a',
  futanari:    (f,t) => f===t ? 'tiene lo mejor de los dos mundos.' : 'le demostró lo que tiene a',
  yaoi:        (f,t) => f===t ? 'está disfrutando de un momento intenso.' : 'se lo pasó genial con',
  bukkake:     (f,t) => f===t ? 'terminó de una forma muy especial.' : 'invitó a sus amigos a acabar encima de',
  orgy:        (f,t) => f===t ? 'está en una orgía.' : 'organizó una orgía con',
  squirting:   (f,t) => f===t ? 'llegó al límite y se vino con todo.' : 'la llevó al límite hasta que se vino con todo',
};

const symbols = ['(⁠◠⁠‿⁠◕⁠)','˃͈◡˂͈','૮(˶ᵔᵕᵔ˶)ა','(づ｡◕‿‿◕｡)づ','(✿◡‿◡)','(꒪⌓꒪)','(✿✪‿✪｡)','(*≧ω≦)','(✧ω◕)','˃ 𖥦 ˂'];
const randSym = () => symbols[Math.floor(Math.random() * symbols.length)];

const alias = {
  anal:['anal','violar'], cum:['cum'], undress:['undress','encuerar'], fuck:['fuck','coger'],
  spank:['spank','nalgada'], lickpussy:['lickpussy'], fap:['fap','paja'], grope:['grope'],
  sixnine:['sixnine','69'], suckboobs:['suckboobs'], grabboobs:['grabboobs'],
  blowjob:['blowjob','mamada','bj'], boobjob:['boobjob'], yuri:['yuri','tijeras'],
  footjob:['footjob'], cummouth:['cummouth'], cumshot:['cumshot'], handjob:['handjob'],
  lickass:['lickass'], lickdick:['lickdick'], fingering:['fingering'], creampie:['creampie'],
  facesitting:['facesitting'], deepthroat:['deepthroat'], thighjob:['thighjob'],
  bondage:['bondage'], pegging:['pegging'], futanari:['futanari','futa'],
  yaoi:['yaoi'], bukkake:['bukkake'], orgy:['orgy','orgia'], squirting:['squirt','squirting'],
};

const handler = async (m, { conn, command, usedPrefix }) => {
  const chat = global.db.data.chats[m.chat] || {};
  if (!chat.nsfw) {
    return m.reply(`ꕥ El contenido *NSFW* está desactivado en este grupo.\n> Un *administrador* puede activarlo con *${usedPrefix}nsfw on*`);
  }
  const currentCommand = Object.keys(alias).find(k => alias[k].includes(command)) || command;
  if (!captions[currentCommand]) return;
  const mentionedJid = m.mentionedJid || [];
  let who2 = mentionedJid.length > 0 ? mentionedJid[0] : (m.quoted ? m.quoted.sender : m.sender);
  const who = await resolveLid(who2, conn);
  const fromName = global.db.data.users[m.sender]?.name || '@' + m.sender.split('@')[0];
  const toName   = global.db.data.users[who]?.name   || '@' + who.split('@')[0];
  const captionText = captions[currentCommand](fromName, toName);
  const caption = who !== m.sender
    ? `\`${fromName}.\` ${captionText} \`${toName}.\` ${randSym()}.`
    : `\`${fromName}\` ${captionText} ${randSym()}.`;
  try {
    const nsfwData = JSON.parse(fs.readFileSync(NSFW_PATH, 'utf-8'));
    const videos = nsfwData[currentCommand] || [];
    if (!videos.length) return m.reply(`↳ ✗ No hay videos para *${currentCommand}*.`);
    const randomVideo = videos[Math.floor(Math.random() * videos.length)];
    await conn.sendMessage(m.chat, { video: { url: randomVideo }, gifPlayback: true, caption, mentions: [who, m.sender] }, { quoted: m });
  } catch (e) {
    await m.reply(`↳ ✗ Error en *${usedPrefix + command}*: ${e.message}`);
  }
};

handler.command = Object.values(alias).flat();
handler.tags = ['nsfw'];

export default handler;
