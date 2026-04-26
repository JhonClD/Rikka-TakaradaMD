/**
 * advertencias.js — KanaArima-MD / Rikka-Bot
 * Librería de persistencia para el sistema de warns.
 * Adaptado de Luna-BotV6 para la estructura de Kana.
 * DB: ./tmp/advertencias.json  (separado del global db para portabilidad)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_DIR    = join(__dirname, '../../tmp')
const DB_PATH   = join(DB_DIR, 'advertencias.json')

if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })
if (!existsSync(DB_PATH)) writeFileSync(DB_PATH, JSON.stringify({ users: {} }, null, 2))

function readDB() {
  try {
    return JSON.parse(readFileSync(DB_PATH, 'utf-8'))
  } catch {
    return { users: {} }
  }
}

function writeDB(data) {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2))
}

/** Devuelve el número de warns actuales del usuario */
export async function getWarnings(userId) {
  const data = readDB()
  return data.users[userId]?.warn || 0
}

/** Añade un warn y devuelve el total */
export async function addWarning(userId) {
  const data = readDB()
  data.users[userId] ??= { warn: 0 }
  data.users[userId].warn++
  writeDB(data)
  return data.users[userId].warn
}

/** Quita un warn y devuelve el total */
export async function removeWarning(userId) {
  const data = readDB()
  data.users[userId] ??= { warn: 0 }
  if (data.users[userId].warn > 0) data.users[userId].warn--
  writeDB(data)
  return data.users[userId].warn
}

/** Resetea los warns de un usuario a 0 */
export async function resetWarnings(userId) {
  const data = readDB()
  data.users[userId] ??= { warn: 0 }
  data.users[userId].warn = 0
  writeDB(data)
}

/** Lista todos los usuarios con warns > 0 */
export async function listWarnings() {
  const data = readDB()
  return Object.entries(data.users)
    .filter(([, u]) => u.warn > 0)
    .map(([id, u]) => ({ id, warns: u.warn }))
}
