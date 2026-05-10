import syntaxError from 'syntax-error'
import { format, inspect }  from 'util'
import { fileURLToPath }    from 'url'
import { dirname, join }    from 'path'
import { createRequire }    from 'module'
import { performance }      from 'perf_hooks'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require   = createRequire(import.meta.url)

// ─── helpers ────────────────────────────────────────────────────────────────

/** Trunca texto largo y añade indicador */
const truncate = (str, max = 3500) =>
  str.length > max ? str.slice(0, max) + `\n\n… _(+${str.length - max} caracteres recortados)_` : str

/** Colorea el tipo del valor retornado */
const typeTag = (v) => {
  if (v === null)              return 'null'
  if (Array.isArray(v))        return `Array(${v.length})`
  if (v instanceof Promise)    return 'Promise'
  if (v instanceof Map)        return `Map(${v.size})`
  if (v instanceof Set)        return `Set(${v.size})`
  if (typeof v === 'function') return `Function:${v.name || '(anon)'}`
  return typeof v
}

/** Serializa el resultado de forma legible */
const serialize = (v, depth = 2) => {
  if (typeof v === 'string') return v
  if (v === undefined)       return 'undefined'
  if (v === null)            return 'null'
  try {
    return inspect(v, { depth, colors: false, compact: false, showHidden: false, breakLength: 80 })
  } catch {
    return String(v)
  }
}

// ─── handler ────────────────────────────────────────────────────────────────

const handler = async (m, { conn, args, usedPrefix, command, text, isOwner }) => {
  // Requiere owner (doble seguro además del flag)
  if (!isOwner) return

  if (!text) {
    return conn.reply(
      m.chat,
      `*💻 Eval* — Ejecuta código JavaScript en el contexto del bot.\n\n` +
      `*Uso:*\n` +
      `  \`${usedPrefix}ev <código>\`\n` +
      `  \`${usedPrefix}ev =<expresión>\`  ← retorna el valor directamente\n\n` +
      `*Ejemplos:*\n` +
      `  \`${usedPrefix}ev =conn.user.jid\`\n` +
      `  \`${usedPrefix}ev await conn.sendMessage(m.chat,{text:"hola"},{})\`\n` +
      `  \`${usedPrefix}ev return Object.keys(global.db.data)\``,
      m
    )
  }

  // Si empieza con "=" lo tratamos como expresión de retorno
  const _code = (/^=/.test(text) ? 'return ' : '') + text

  let _result, _type, _time, _syntaxErr = ''

  try {
    await m.react('⌛')

    // ── Contexto de ejecución ──────────────────────────────────────────────
    // Exponemos todo lo útil sin usar eval() global (más seguro + mejor scope)
    const ctx = {
      // Baileys / bot
      conn,
      m,
      // helpers
      require,
      format,
      inspect,
      // proceso
      process,
      global,
      // libs comunes que ya están en el bot
      Buffer,
      JSON,
      Math,
      Date,
      // utils inline
      sleep : (ms) => new Promise(r => setTimeout(r, ms)),
      db    : global.db,
      opts  : global.opts,
    }

    const keys   = Object.keys(ctx)
    const vals   = Object.values(ctx)
    const exec   = new (async () => {}).constructor(...keys, _code)

    const t0 = performance.now()
    _result  = await exec(...vals)
    _time    = (performance.now() - t0).toFixed(2)
    _type    = typeTag(_result)

    _result  = truncate(serialize(_result))

    await m.react('✅')

  } catch (e) {
    // ── Intenta detectar error de sintaxis para feedback preciso ──────────
    const synErr = syntaxError(_code, 'eval', {
      allowReturnOutsideFunction : true,
      allowAwaitOutsideFunction  : true,
      sourceType                 : 'module',
    })
    if (synErr) {
      _syntaxErr = `*🔴 Error de sintaxis*\n\`\`\`\n${synErr}\n\`\`\`\n\n`
    }

    _result = truncate(e?.stack ?? e?.message ?? String(e))
    _type   = e?.name ?? 'Error'
    _time   = '—'
    await m.react('❌')
  }

  // ── Cabecera de la respuesta ─────────────────────────────────────────────
  const header = [
    `*💻 Eval*  ·  \`${_type}\`  ·  ⏱ ${_time} ms`,
    ``,
    `*📥 Input:*`,
    `\`\`\`${text.slice(0, 200)}${text.length > 200 ? '…' : ''}\`\`\``,
    ``,
    `*📤 Output:*`,
  ].join('\n')

  const body = `\`\`\`\n${_result}\n\`\`\``

  await conn.reply(m.chat, _syntaxErr + header + '\n' + body, m)
}

// ─── metadata ────────────────────────────────────────────────────────────────
handler.help    = ['ev <código>', 'eval <código>', 'ex <código>']
handler.tags    = ['owner']
handler.command = /^(ev|eval|ex)$/i
handler.owner   = true

export default handler
      
