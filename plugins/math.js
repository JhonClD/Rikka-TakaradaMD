// math.js — Portado de YukiBot-MD → Rikka-TakaradaMD
import { promises as fs } from 'fs';


global.math = global.math || {}
const limits = { facil: 10, medio: 50, dificil: 90, imposible: 100, imposible2: 160 }
const generateRandomNumber = (max) => Math.floor(Math.random() * max) + 1
const getOperation = () => ['+', '-', '*', '/'][Math.floor(Math.random() * 4)]
const rewardRanges = { facil: [500, 1000], medio: [1000, 2000], dificil: [2000, 3500], imposible: [3500, 4800], imposible2: [5000, 6500] }

const generarProblema = (dificultad) => {
  const maxLimit = limits[dificultad] || 30
  const num1 = generateRandomNumber(maxLimit)
  const num2 = generateRandomNumber(maxLimit)
  const operador = getOperation()
  const resultado = eval(`${num1} ${operador} ${num2}`)
  const simbolo = operador === '*' ? '×' : operador === '/' ? '÷' : operador
  return { problema: `${num1} ${simbolo} ${num2}`, resultado }
}


const handler = async (m, { conn, command, usedPrefix, args }) => {
    const chatId = m.chat
    const db = global.db.data.chats[chatId]
    const user = global.db.data.users[m.sender]
    const juego = global.math[chatId]
    if (db.adminonly || !db.economy) return m.reply(`ꕥ Los comandos de *Economía* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}economy on*`)
    if (command === 'resp') {
      if (!juego?.juegoActivo) return
      const quotedId = m.quoted?.key?.id || m.quoted?.id || m.quoted?.stanzaId
      if (quotedId !== juego.problemMessageId) return
      const respuestaUsuario = parseFloat(args[0])
      if (isNaN(respuestaUsuario)) return conn.sendMessage(m.chat, { text: chatId, `「✎」Debes escribir tu respuesta numérica. Ejemplo: *${usedPrefix}resp 42*` }, { quoted: m })
      const respuestaCorrecta = parseFloat(juego.respuesta)
      const botId = conn.user?.id.split(':')[0] + '@s.whatsapp.net'
      const primaryBotId = db.primaryBot
      if (!primaryBotId || primaryBotId === botId) {
        if (respuestaUsuario === respuestaCorrecta) {
          const [min, max] = rewardRanges[juego.dificultad] || [500, 1000]
          const coinsAleatorio = Math.floor(Math.random() * (max - min + 1)) + min
          user.coins += coinsAleatorio
          clearTimeout(juego.tiempoLimite)
          delete global.math[chatId]
          return conn.sendMessage(m.chat, { text: chatId, `「❀」Respuesta correcta.\n> *Ganaste ›* ¥${coinsAleatorio.toLocaleString()}` }, { quoted: m })
        } else {
          juego.intentos += 1
          if (juego.intentos >= 3) {
            clearTimeout(juego.tiempoLimite)
            delete global.math[chatId]
            return conn.sendMessage(m.chat, { text: chatId, '「✎」Te quedaste sin intentos. Suerte a la próxima.' }, { quoted: m })
          } else {
            const intentosRestantes = 3 - juego.intentos
            return conn.sendMessage(m.chat, { text: chatId, `「✎」Respuesta incorrecta, te quedan ${intentosRestantes} intentos.` }, { quoted: m })
          }
        }
      }
      return
    }
    if (["math", "mates"].includes(command)) {
      if (juego?.juegoActivo) return conn.sendMessage(m.chat, { text: chatId, 'ꕥ Ya hay un juego activo. Espera a que termine.' }, { quoted: m })
      const dificultad = args[0]?.toLowerCase()
      if (!limits[dificultad]) return conn.sendMessage(m.chat, { text: chatId, '「✎」Especifica una dificultad válida: *facil, medio, dificil, imposible, imposible2*' }, { quoted: m })
      const { problema, resultado } = generarProblema(dificultad)
      const problemMessage = await conn.sendMessage(m.chat, { text: chatId, `「✩」Tienes 1 minuto para resolver:\n\n> ✩ *${problema}*\n\n_✐ Usa » *${usedPrefix}resp* para responder!_` }, { quoted: m })
      global.math[chatId] = {
        juegoActivo: true,
        problema,
        respuesta: resultado.toString(),
        intentos: 0,
        dificultad,
        timeout: Date.now() + 60000,
        problemMessageId: problemMessage.key?.id,
        tiempoLimite: setTimeout(() => {
          if (global.math[chatId]?.juegoActivo) {
            delete global.math[chatId]
            conn.sendMessage(m.chat, { text: chatId, '「✿」Tiempo agotado. El juego ha terminado.' }, { quoted: m })
          }
        }, 60000)
      }
    }
};

handler.command = ['math', 'mates', 'resp'];
handler.tags = ['economy'];

export default handler;
