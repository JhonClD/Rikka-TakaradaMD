// anime-inter.js — Interacciones anime (pat, kiss, hug, slap, fuck, etc.)
// Portado de YukiBot-MD → Rikka-TakaradaMD (Baileys ES Modules)

const captions = {
  peek:       (f, t) => f === t ? 'está espiando detrás de una puerta.' : 'está espiando a',
  comfort:    (f, t) => f === t ? 'se está consolando a sí mismo.' : 'está consolando a',
  thinkhard:  (f, t) => f === t ? 'se quedó pensando muy intensamente.' : 'está pensando profundamente en',
  curious:    (f, t) => f === t ? 'se muestra curioso por todo.' : 'está curioso por lo que hace',
  sniff:      (f, t) => f === t ? 'se olfatea a sí mismo.' : 'está olfateando a',
  stare:      (f, t) => f === t ? 'se queda mirando al techo.' : 'se queda mirando fijamente a',
  trip:       (f, t) => f === t ? 'se tropezó consigo mismo.' : 'tropezó con',
  blowkiss:   (f, t) => f === t ? 'se manda un beso al espejo.' : 'le lanzó un beso a',
  snuggle:    (f, t) => f === t ? 'se acurruca con una almohada.' : 'se acurruca con',
  sleep:      (f, t) => f === t ? 'está durmiendo plácidamente.' : 'está durmiendo con',
  cold:       (f, t) => f === t ? 'tiene mucho frío.' : 'se congela por el frío de',
  sing:       (f, t) => f === t ? 'está cantando.' : 'le está cantando a',
  tickle:     (f, t) => f === t ? 'se está haciendo cosquillas.' : 'le está haciendo cosquillas a',
  scream:     (f, t) => f === t ? 'está gritando al viento.' : 'le está gritando a',
  push:       (f, t) => f === t ? 'se empujó a sí mismo.' : 'empujó a',
  nope:       (f, t) => f === t ? 'expresa su desacuerdo.' : 'dice "¡No!" a',
  jump:       (f, t) => f === t ? 'salta de felicidad.' : 'salta feliz con',
  heat:       (f, t) => f === t ? 'siente mucho calor.' : 'tiene calor por',
  gaming:     (f, t) => f === t ? 'está jugando solo.' : 'está jugando con',
  draw:       (f, t) => f === t ? 'hace un lindo dibujo.' : 'dibuja inspirado en',
  call:       (f, t) => f === t ? 'marca su propio número.' : 'llamó al número de',
  seduce:     (f, t) => f === t ? 'lanzó una mirada seductora al vacío.' : 'está intentando seducir a',
  shy:        (f, t) => f === t ? 'se sonrojó tímidamente.' : 'se siente tímido ante',
  slap:       (f, t) => f === t ? 'se dio una bofetada a sí mismo.' : 'le dio una bofetada a',
  bath:       (f, t) => f === t ? 'se está bañando.' : 'está bañando a',
  angry:      (f, t) => f === t ? 'está muy enojado.' : 'está super enojado con',
  bored:      (f, t) => f === t ? 'está muy aburrido.' : 'está aburrido de',
  bite:       (f, t) => f === t ? 'se mordió solito.' : 'mordió a',
  bleh:       (f, t) => f === t ? 'se sacó la lengua frente al espejo.' : 'le está haciendo muecas a',
  bonk:       (f, t) => f === t ? 'se dio un bonk a sí mismo.' : 'le dio un golpe a',
  blush:      (f, t) => f === t ? 'se sonrojó.' : 'se sonrojó por',
  impregnate: (f, t) => f === t ? 'se embarazó.' : 'embarazó a',
  bully:      (f, t) => f === t ? 'se hace bullying a sí mismo.' : 'le está haciendo bullying a',
  cry:        (f, t) => f === t ? 'está llorando.' : 'está llorando por',
  happy:      (f, t) => f === t ? 'está feliz.' : 'está feliz con',
  coffee:     (f, t) => f === t ? 'está tomando café.' : 'está tomando café con',
  clap:       (f, t) => f === t ? 'está aplaudiendo.' : 'está aplaudiendo por',
  cringe:     (f, t) => f === t ? 'siente cringe.' : 'siente cringe por',
  dance:      (f, t) => f === t ? 'está bailando.' : 'está bailando con',
  cuddle:     (f, t) => f === t ? 'se acurrucó solo.' : 'se acurrucó con',
  drunk:      (f, t) => f === t ? 'está demasiado borracho.' : 'está borracho con',
  dramatic:   (f, t) => f === t ? 'está haciendo un drama exagerado.' : 'le está haciendo drama a',
  handhold:   (f, t) => f === t ? 'se dio la mano consigo mismo.' : 'le agarró la mano a',
  eat:        (f, t) => f === t ? 'está comiendo algo delicioso.' : 'está comiendo con',
  highfive:   (f, t) => f === t ? 'se chocó los cinco frente al espejo.' : 'chocó los 5 con',
  hug:        (f, t) => f === t ? 'se abrazó a sí mismo.' : 'le dio un abrazo a',
  kill:       (f, t) => f === t ? 'se autoeliminó dramáticamente.' : 'asesinó a',
  kiss:       (f, t) => f === t ? 'se mandó un beso al aire.' : 'le dio un beso a',
  kisscheek:  (f, t) => f === t ? 'se besó en la mejilla con un espejo.' : 'le dio un beso en la mejilla a',
  lick:       (f, t) => f === t ? 'se lamió por curiosidad.' : 'lamió a',
  laugh:      (f, t) => f === t ? 'se está riendo.' : 'se está burlando de',
  pat:        (f, t) => f === t ? 'se acarició la cabeza con ternura.' : 'le dio una caricia a',
  love:       (f, t) => f === t ? 'se quiere mucho a sí mismo.' : 'siente atracción por',
  pout:       (f, t) => f === t ? 'está haciendo pucheros solo.' : 'está haciendo pucheros con',
  punch:      (f, t) => f === t ? 'lanzó un puñetazo al aire.' : 'le dio un puñetazo a',
  run:        (f, t) => f === t ? 'está corriendo por su vida.' : 'está corriendo con',
  scared:     (f, t) => f === t ? 'está asustado por algo.' : 'está asustado por',
  sad:        (f, t) => f === t ? 'está triste.' : 'está expresando su tristeza a',
  smoke:      (f, t) => f === t ? 'está fumando tranquilamente.' : 'está fumando con',
  smile:      (f, t) => f === t ? 'está sonriendo.' : 'le sonrió a',
  spit:       (f, t) => f === t ? 'se escupió por accidente.' : 'le escupió a',
  smug:       (f, t) => f === t ? 'está presumiendo.' : 'está presumiendo a',
  think:      (f, t) => f === t ? 'está pensando profundamente.' : 'no puede dejar de pensar en',
  step:       (f, t) => f === t ? 'se pisó a sí mismo.' : 'está pisando a',
  wave:       (f, t) => f === t ? 'se saludó en el espejo.' : 'está saludando a',
  walk:       (f, t) => f === t ? 'salió a caminar en soledad.' : 'decidió dar un paseo con',
  wink:       (f, t) => f === t ? 'se guiñó en el espejo.' : 'le guiñó a',
  fuck:       (f, t) => f === t ? 'se está divirtiendo solo... 👀' : 'hizo cosas inapropiadas con',
};

const alias = {
  angry:      ['angry','enojado','enojada'],
  bleh:       ['bleh'],
  bored:      ['bored','aburrido','aburrida'],
  clap:       ['clap','aplaudir'],
  coffee:     ['coffee','cafe'],
  dramatic:   ['dramatic','drama'],
  drunk:      ['drunk'],
  cold:       ['cold'],
  impregnate: ['impregnate','preg','preñar','embarazar'],
  kisscheek:  ['kisscheek','besomejilla'],
  laugh:      ['laugh'],
  love:       ['love','amor'],
  pout:       ['pout','mueca'],
  punch:      ['punch','golpear'],
  run:        ['run','correr'],
  sad:        ['sad','triste'],
  scared:     ['scared','asustado'],
  seduce:     ['seduce','seducir'],
  shy:        ['shy','timido','timida'],
  sleep:      ['sleep','dormir'],
  smoke:      ['smoke','fumar'],
  spit:       ['spit','escupir'],
  step:       ['step','pisar'],
  think:      ['think','pensar'],
  walk:       ['walk','caminar'],
  hug:        ['hug','abrazar'],
  kill:       ['kill','matar'],
  eat:        ['eat','nom','comer'],
  kiss:       ['kiss','muak','besar'],
  wink:       ['wink','guiñar'],
  pat:        ['pat','acariciar'],
  happy:      ['happy','feliz'],
  bully:      ['bully','molestar'],
  bite:       ['bite','morder'],
  blush:      ['blush','sonrojarse'],
  wave:       ['wave','saludar'],
  bath:       ['bath','bañarse'],
  smug:       ['smug','presumir'],
  smile:      ['smile','sonreir'],
  highfive:   ['highfive','choca'],
  handhold:   ['handhold','tomarlamano'],
  cringe:     ['cringe'],
  bonk:       ['bonk','golpe'],
  cry:        ['cry','llorar'],
  lick:       ['lick','lamer'],
  slap:       ['slap','bofetada'],
  dance:      ['dance','bailar'],
  cuddle:     ['cuddle','acurrucar'],
  sing:       ['sing','cantar'],
  tickle:     ['tickle','cosquillas'],
  scream:     ['scream','gritar'],
  push:       ['push','empujar'],
  nope:       ['nope'],
  jump:       ['jump','saltar'],
  heat:       ['heat','calor'],
  gaming:     ['gaming','jugar'],
  draw:       ['draw','dibujar'],
  call:       ['call','llamar'],
  snuggle:    ['snuggle','acurrucarse'],
  blowkiss:   ['blowkiss','besito'],
  trip:       ['trip','tropezar'],
  stare:      ['stare','mirar'],
  sniff:      ['sniff','oler'],
  curious:    ['curious','curioso','curiosa'],
  thinkhard:  ['thinkhard'],
  comfort:    ['comfort','consolar'],
  peek:       ['peek'],
  fuck:       ['fuck','coger','follar'],
};

const symbols = ['(⁠◠⁠‿⁠◕⁠)','˃͈◡˂͈','(づ｡◕‿‿◕｡)づ','(✿◡‿◡)','(*≧ω≦)','(✧ω◕)','˃ 𖥦 ˂','(⌒‿⌒)','(✧ω✧)','ʕ•́ᴥ•̀ʔっ','(∩︵∩)','(✪ω✪)','(✯◕‿◕✯)'];
const randSym = () => symbols[Math.floor(Math.random() * symbols.length)];

// Comandos que usan el endpoint /nsfw/ de stellarwa
const NSFW_INTERACTIONS = new Set([
  'fuck', 'cum', 'blowjob', 'anal', 'hentai', 'yuri', 'yaoi',
  'neko_nsfw', 'trap',
]);

// Flatten alias map to build command array
const allCommands = Object.values(alias).flat();

const handler = async (m, { conn, command, usedPrefix }) => {
  const canonical = Object.keys(alias).find(k => alias[k].includes(command)) || command;
  if (!captions[canonical]) return;

  // Verificar si el comando es NSFW y si el chat lo permite
  const isNsfwCmd = NSFW_INTERACTIONS.has(canonical);
  if (isNsfwCmd) {
    const chat = global.db.data.chats?.[m.chat] || {};
    if (!chat.nsfw) {
      return m.reply(`🔞 Este comando es NSFW.\nUn admin debe activarlo con *${usedPrefix}nsfwon*`);
    }
  }

  // Resolve target: mention > quoted > self
  let whoRaw = m.mentionedJid?.[0] || (m.quoted ? m.quoted.sender : m.sender);

  // LID resolution (same helper used internally by Rikka)
  let who = whoRaw;
  if (m.isGroup && !whoRaw.endsWith('@s.whatsapp.net')) {
    try {
      const meta = await conn.groupMetadata(m.chat);
      for (const p of meta.participants || []) {
        if (p?.id?.split('@')[0] === whoRaw.split('@')[0]) {
          who = p.id;
          break;
        }
      }
    } catch { /* silently ignore */ }
  }

  const fromName = global.db.data.users[m.sender]?.name || '@' + m.sender.split('@')[0];
  const toName   = global.db.data.users[who]?.name     || '@' + who.split('@')[0];
  const captionText = captions[canonical](fromName, toName);
  const caption = who !== m.sender
    ? `\`${fromName}.\` ${captionText} \`${toName}.\` ${randSym()}.`
    : `\`${fromName}\` ${captionText} ${randSym()}.`;

  try {
    const mode = NSFW_INTERACTIONS.has(canonical) ? 'nsfw' : 'sfw';
    const res = await fetch(`https://api.stellarwa.xyz/${mode}/interaction?inter=${canonical}`);
    const json = await res.json();
    const { result } = json;
    if (!result) throw new Error('No media URL returned');
    await conn.sendMessage(m.chat, {
      video: { url: result },
      gifPlayback: true,
      caption,
      mentions: [who, m.sender],
    }, { quoted: m });
  } catch (e) {
    await m.reply(`❌ Error al ejecutar *${usedPrefix + command}*: ${e.message}`);
  }
};

handler.command = allCommands;
handler.tags    = ['anime', 'interacciones'];
handler.help    = ['pat @usuario', 'kiss @usuario', 'hug @usuario', 'slap @usuario', 'fuck @usuario', '... y más'];

export default handler;
  
