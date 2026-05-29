import fetch from 'node-fetch';

async function resolveLid(jid, conn, chatId) {
  if (!jid || !jid.includes('@lid')) return jid;
  try {
    const result = await conn.signalRepository?.lidToJid?.(jid);
    return result || jid;
  } catch { return jid; }
}

const captions = {
  peek:      (f, t) => f===t ? 'está espiando detrás de una puerta.' : 'está espiando a',
  comfort:   (f, t) => f===t ? 'se está consolando a sí mismo.' : 'está consolando a',
  thinkhard: (f, t) => f===t ? 'se quedó pensando muy intensamente.' : 'está pensando profundamente en',
  curious:   (f, t) => f===t ? 'se muestra curioso por todo.' : 'está curioso por lo que hace',
  sniff:     (f, t) => f===t ? 'se olfatea como si buscara algo raro.' : 'está olfateando a',
  stare:     (f, t) => f===t ? 'se queda mirando al techo sin razón.' : 'se queda mirando fijamente a',
  trip:      (f, t) => f===t ? 'se tropezó consigo mismo, otra vez.' : 'tropezó accidentalmente con',
  blowkiss:  (f, t) => f===t ? 'se manda un beso al espejo.' : 'le lanzó un beso a',
  snuggle:   (f, t) => f===t ? 'se acurruca con una almohada suave.' : 'se acurruca dulcemente con',
  sleep:     (f, t) => f===t ? 'está durmiendo plácidamente.' : 'está durmiendo con',
  cold:      (f, t) => f===t ? 'tiene mucho frío.' : 'se congela por el frío de',
  sing:      (f, t) => f===t ? 'está cantando.' : 'le está cantando a',
  tickle:    (f, t) => f===t ? 'se está haciendo cosquillas.' : 'le está haciendo cosquillas a',
  scream:    (f, t) => f===t ? 'está gritando al viento.' : 'le está gritando a',
  push:      (f, t) => f===t ? 'se empujó a sí mismo.' : 'empujó a',
  nope:      (f, t) => f===t ? 'expresa claramente su desacuerdo.' : 'dice "¡No!" a',
  jump:      (f, t) => f===t ? 'salta de felicidad.' : 'salta feliz con',
  heat:      (f, t) => f===t ? 'siente mucho calor.' : 'tiene calor por',
  gaming:    (f, t) => f===t ? 'está jugando solo.' : 'está jugando con',
  draw:      (f, t) => f===t ? 'hace un lindo dibujo.' : 'dibuja inspirado en',
  call:      (f, t) => f===t ? 'marca su propio número esperando respuesta.' : 'llamó al número de',
  seduce:    (f, t) => f===t ? 'lanzó una mirada seductora al vacío.' : 'está intentando seducir a',
  shy:       (f, t, g) => f===t ? `se sonrojó tímidamente.` : `se siente demasiado ${g==='Hombre'?'tímido':g==='Mujer'?'tímida':'tímide'} para mirar a`,
  slap:      (f, t, g) => f===t ? `se dio una bofetada a sí ${g==='Hombre'?'mismo':g==='Mujer'?'misma':'mismx'}.` : 'le dio una bofetada a',
  bath:      (f, t) => f===t ? 'se está bañando.' : 'está bañando a',
  angry:     (f, t, g) => f===t ? `está muy ${g==='Hombre'?'enojado':g==='Mujer'?'enojada':'enojadx'}.` : `está super ${g==='Hombre'?'enojado':g==='Mujer'?'enojada':'enojadx'} con`,
  bored:     (f, t, g) => f===t ? `está muy ${g==='Hombre'?'aburrido':g==='Mujer'?'aburrida':'aburridx'}.` : `está ${g==='Hombre'?'aburrido':g==='Mujer'?'aburrida':'aburridx'} de`,
  bite:      (f, t, g) => f===t ? `se mordió ${g==='Hombre'?'solito':g==='Mujer'?'solita':'solitx'}.` : 'mordió a',
  bleh:      (f, t) => f===t ? 'se sacó la lengua frente al espejo.' : 'le está haciendo muecas con la lengua a',
  bonk:      (f, t, g) => f===t ? `se dio un bonk a sí ${g==='Hombre'?'mismo':g==='Mujer'?'misma':'mismx'}.` : 'le dio un golpe a',
  blush:     (f, t) => f===t ? 'se sonrojó.' : 'se sonrojó por',
  impregnate:(f, t) => f===t ? 'se embarazó.' : 'embarazó a',
  bully:     (f, t, g) => f===t ? `se hace bullying.` : 'le está haciendo bullying a',
  cry:       (f, t) => f===t ? 'está llorando.' : 'está llorando por',
  happy:     (f, t) => f===t ? 'está feliz.' : 'está feliz con',
  coffee:    (f, t) => f===t ? 'está tomando café.' : 'está tomando café con',
  clap:      (f, t) => f===t ? 'está aplaudiendo.' : 'está aplaudiendo por',
  cringe:    (f, t) => f===t ? 'siente cringe.' : 'siente cringe por',
  dance:     (f, t) => f===t ? 'está bailando.' : 'está bailando con',
  cuddle:    (f, t, g) => f===t ? `se acurrucó ${g==='Hombre'?'solo':g==='Mujer'?'sola':'solx'}.` : 'se acurrucó con',
  drunk:     (f, t, g) => f===t ? `está demasiado ${g==='Hombre'?'borracho':g==='Mujer'?'borracha':'borrachx'}.` : `está ${g==='Hombre'?'borracho':g==='Mujer'?'borracha':'borrachx'} con`,
  dramatic:  (f, t) => f===t ? 'está haciendo un drama exagerado.' : 'le está haciendo un drama a',
  handhold:  (f, t, g) => f===t ? `se dio la mano consigo ${g==='Hombre'?'mismo':g==='Mujer'?'misma':'mismx'}.` : 'le agarró la mano a',
  eat:       (f, t) => f===t ? 'está comiendo algo delicioso.' : 'está comiendo con',
  highfive:  (f, t) => f===t ? 'se chocó los cinco frente al espejo.' : 'chocó los 5 con',
  hug:       (f, t, g) => f===t ? `se abrazó a sí ${g==='Hombre'?'mismo':g==='Mujer'?'misma':'mismx'}.` : 'le dio un abrazo a',
  kill:      (f, t) => f===t ? 'se autoeliminó en modo dramático.' : 'asesinó a',
  kiss:      (f, t) => f===t ? 'se mandó un beso al aire.' : 'le dio un beso a',
  kisscheek: (f, t) => f===t ? 'se besó en la mejilla usando un espejo.' : 'le dio un beso en la mejilla a',
  lick:      (f, t) => f===t ? 'se lamió por curiosidad.' : 'lamió a',
  laugh:     (f, t) => f===t ? 'se está riendo de algo.' : 'se está burlando de',
  pat:       (f, t) => f===t ? 'se acarició la cabeza con ternura.' : 'le dio una caricia a',
  love:      (f, t, g) => f===t ? `se quiere mucho a sí ${g==='Hombre'?'mismo':g==='Mujer'?'misma':'mismx'}.` : 'siente atracción por',
  pout:      (f, t, g) => f===t ? `está haciendo pucheros ${g==='Hombre'?'solo':g==='Mujer'?'sola':'solx'}.` : 'está haciendo pucheros con',
  punch:     (f, t) => f===t ? 'lanzó un puñetazo al aire.' : 'le dio un puñetazo a',
  run:       (f, t) => f===t ? 'está corriendo por su vida.' : 'está corriendo con',
  scared:    (f, t, g) => f===t ? `está ${g==='Hombre'?'asustado':g==='Mujer'?'asustada':'asustxd'} por algo.` : `está ${g==='Hombre'?'asustado':g==='Mujer'?'asustada':'asustxd'} por`,
  sad:       (f, t) => f===t ? 'está triste.' : 'está expresando su tristeza a',
  smoke:     (f, t) => f===t ? 'está fumando tranquilamente.' : 'está fumando con',
  smile:     (f, t) => f===t ? 'está sonriendo.' : 'le sonrió a',
  spit:      (f, t, g) => f===t ? `se escupió a sí ${g==='Hombre'?'mismo':g==='Mujer'?'misma':'mismx'} por accidente.` : 'le escupió a',
  smug:      (f, t) => f===t ? 'está presumiendo mucho.' : 'está presumiendo a',
  think:     (f, t) => f===t ? 'está pensando profundamente.' : 'no puede dejar de pensar en',
  step:      (f, t, g) => f===t ? `se pisó a sí ${g==='Hombre'?'mismo':g==='Mujer'?'misma':'mismx'} por accidente.` : 'está pisando a',
  wave:      (f, t, g) => f===t ? `se saludó a sí ${g==='Hombre'?'mismo':g==='Mujer'?'misma':'mismx'} en el espejo.` : 'está saludando a',
  walk:      (f, t) => f===t ? 'salió a caminar en soledad.' : 'decidió dar un paseo con',
  wink:      (f, t, g) => f===t ? `se guiñó a sí ${g==='Hombre'?'mismo':g==='Mujer'?'misma':'mismx'} en el espejo.` : 'le guiñó a',
};

const symbols = ['(⁠◠⁠‿⁠◕⁠)','˃͈◡˂͈','૮(˶ᵔᵕᵔ˶)ა','(づ｡◕‿‿◕｡)づ','(✿◡‿◡)','(꒪⌓꒪)','(✿✪‿✪｡)','(*≧ω≦)','(✧ω◕)','˃ 𖥦 ˂','(⌒‿⌒)','(¬‿¬)','(✧ω✧)','✿(◕ ‿◕)✿','ʕ•́ᴥ•̀ʔっ','(ㅇㅅㅇ❀)','(∩︵∩)','(✪ω✪)','(✯◕‿◕✯)','(•̀ᴗ•́)و ̑̑'];
const randSym = () => symbols[Math.floor(Math.random() * symbols.length)];

const alias = {
  angry:['angry','enojado','enojada'], bleh:['bleh'], bored:['bored','aburrido','aburrida'],
  clap:['clap','aplaudir'], coffee:['coffee','cafe'], dramatic:['dramatic','drama'],
  drunk:['drunk'], cold:['cold'], impregnate:['impregnate','preg','preñar','embarazar'],
  kisscheek:['kisscheek','beso','besar'], laugh:['laugh'], love:['love','amor'],
  pout:['pout','mueca'], punch:['punch','golpear'], run:['run','correr'],
  sad:['sad','triste'], scared:['scared','asustado'], seduce:['seduce','seducir'],
  shy:['shy','timido','timida'], sleep:['sleep','dormir'], smoke:['smoke','fumar'],
  spit:['spit','escupir'], step:['step','pisar'], think:['think','pensar'],
  walk:['walk','caminar'], hug:['hug','abrazar'], kill:['kill','matar'],
  eat:['eat','nom','comer'], kiss:['kiss','muak'], wink:['wink','guiñar'],
  pat:['pat','acariciar'], happy:['happy','feliz'], bully:['bully','molestar'],
  bite:['bite','morder'], blush:['blush','sonrojarse'], wave:['wave','saludar'],
  bath:['bath','bañarse'], smug:['smug','presumir'], smile:['smile','sonreir'],
  highfive:['highfive','choca'], handhold:['handhold','tomar'], cringe:['cringe'],
  bonk:['bonk','golpe'], cry:['cry','llorar'], lick:['lick','lamer'],
  slap:['slap','bofetada'], dance:['dance','bailar'], cuddle:['cuddle','acurrucar'],
  sing:['sing','cantar'], tickle:['tickle','cosquillas'], scream:['scream','gritar'],
  push:['push','empujar'], nope:['nope'], jump:['jump','saltar'],
  heat:['heat','calor'], gaming:['gaming','jugar'], draw:['draw','dibujar'],
  call:['call','llamar'], snuggle:['snuggle','acurrucarse'], blowkiss:['blowkiss','besito'],
  trip:['trip','tropezar'], stare:['stare','mirar'], sniff:['sniff','oler'],
  curious:['curious','curioso','curiosa'], thinkhard:['thinkhard'],
  comfort:['comfort','consolar'], peek:['peek'],
};

const handler = async (m, { conn, command, usedPrefix }) => {
  const currentCommand = Object.keys(alias).find(k => alias[k].includes(command)) || command;
  if (!captions[currentCommand]) return;
  const mentionedJid = m.mentionedJid || [];
  let who2 = mentionedJid.length > 0 ? mentionedJid[0] : (m.quoted ? m.quoted.sender : m.sender);
  const who = await resolveLid(who2, conn, m.chat);
  const fromName = global.db.data.users[m.sender]?.name || '@' + m.sender.split('@')[0];
  const toName   = global.db.data.users[who]?.name   || '@' + who.split('@')[0];
  const genero   = global.db.data.users[m.sender]?.genre || 'Oculto';
  const captionText = captions[currentCommand](fromName, toName, genero);
  const caption = who !== m.sender
    ? `\`${fromName}.\` ${captionText} \`${toName}.\` ${randSym()}.`
    : `\`${fromName}\` ${captionText} ${randSym()}.`;
  try {
    const response = await fetch(`https://api.stellarwa.xyz/sfw/interaction?inter=${currentCommand}`);
    const json = await response.json();
    await conn.sendMessage(m.chat, { video: { url: json.result }, gifPlayback: true, caption, mentions: [who, m.sender] }, { quoted: m });
  } catch (e) {
    await m.reply(`↳ ✗ Error en *${usedPrefix + command}*: ${e.message}`);
  }
};

handler.command = Object.values(alias).flat();
handler.tags = ['anime'];

export default handler;
