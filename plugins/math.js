// math.js — Portado de YukiBot-MD → Rikka-TakaradaMD

global.math = global.math || {};

const limits = { facil: 10, medio: 50, dificil: 90, imposible: 100, imposible2: 160 };
const rewardRanges = { facil: [500, 1000], medio: [1000, 2000], dificil: [2000, 3500], imposible: [3500, 4800], imposible2: [5000, 6500] };

const generarProblema = (dificultad) => {
  const max = limits[dificultad] || 30;
  const n1 = Math.floor(Math.random() * max) + 1;
  const n2 = Math.floor(Math.random() * max) + 1;
  const ops = ['+', '-', '*', '/'];
  const op = ops[Math.floor(Math.random() * ops.length)];
  const resultado = eval(`${n1} ${op} ${n2}`);
  const simbolo = op === '*' ? '×' : op === '/' ? '÷' : op;
  return { problema: `${n1} ${simbolo} ${n2}`, resultado };
};

const handler = async (m, { conn, command, usedPrefix, args }) => {
  const chatId = m.chat;
  const db = global.db.data.chats[chatId];
  const user = global.db.data.users[m.sender];
  const juego = global.math[chatId];
  if (db.adminonly || !db.economy)
    return m.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`);

  if (command === 'resp') {
    if (!juego?.juegoActivo) return;
    const quotedId = m.quoted?.key?.id || m.quoted?.id || m.quoted?.stanzaId;
    if (quotedId !== juego.problemMessageId) return;
    const respuestaUsuario = parseFloat(args[0]);
    if (isNaN(respuestaUsuario)) return m.reply(`「✎」Debes escribir tu respuesta numérica. Ejemplo: *${usedPrefix}resp 42*`);
    const respuestaCorrecta = parseFloat(juego.respuesta);
    const botId = (conn.user?.id?.split(':')[0] || 'bot') + '@s.whatsapp.net';
    const primaryBotId = db.primaryBot;
    if (!primaryBotId || primaryBotId === botId) {
      if (respuestaUsuario === respuestaCorrecta) {
        const [min, max] = rewardRanges[juego.dificultad] || [500, 1000];
        const coins = Math.floor(Math.random() * (max - min + 1)) + min;
        user.coins += coins;
        clearTimeout(juego.tiempoLimite);
        delete global.math[chatId];
        return m.reply(`「❀」Respuesta correcta.\n> *Ganaste ›* ¥${coins.toLocaleString()}`);
      } else {
        juego.intentos += 1;
        if (juego.intentos >= 3) {
          clearTimeout(juego.tiempoLimite);
          delete global.math[chatId];
          return m.reply('「✎」Te quedaste sin intentos. Suerte a la próxima.');
        }
        return m.reply(`「✎」Respuesta incorrecta, te quedan ${3 - juego.intentos} intentos.`);
      }
    }
    return;
  }

  if (['math', 'mates'].includes(command)) {
    if (juego?.juegoActivo) return m.reply('ꕥ Ya hay un juego activo. Espera a que termine.');
    const dificultad = args[0]?.toLowerCase();
    if (!limits[dificultad]) return m.reply('「✎」Especifica una dificultad válida: *facil, medio, dificil, imposible, imposible2*');
    const { problema, resultado } = generarProblema(dificultad);
    const problemMessage = await m.reply(`「✩」Tienes 1 minuto para resolver:\n\n> ✩ *${problema}*\n\n_✐ Usa » *${usedPrefix}resp* para responder!_`);
    global.math[chatId] = {
      juegoActivo: true, problema, respuesta: resultado.toString(),
      intentos: 0, dificultad, timeout: Date.now() + 60000,
      problemMessageId: problemMessage?.key?.id,
      tiempoLimite: setTimeout(() => {
        if (global.math[chatId]?.juegoActivo) {
          delete global.math[chatId];
          conn.sendMessage(chatId, { text: '「✿」Tiempo agotado. El juego ha terminado.' });
        }
      }, 60000),
    };
  }
};

handler.command = ['math', 'mates', 'resp'];
handler.tags = ['economy'];

export default handler;
