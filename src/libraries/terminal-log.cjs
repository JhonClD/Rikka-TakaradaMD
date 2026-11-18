const RESET = '\u001b[0m'

function color(code, value) {
  return process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[${code}m${value}${RESET}` : value
}

function label(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, character => character.toUpperCase())
}

function formatValue(value) {
  if (value == null || value === '') return '—'
  if (Array.isArray(value)) return value.map(item => typeof item === 'object' && item !== null
    ? Object.values(item).filter(part => part != null && part !== '').join(' · ')
    : String(item)).join(' · ')
  if (typeof value === 'object') return Object.entries(value)
    .map(([key, part]) => `${label(key)}: ${formatValue(part)}`).join(' · ')
  return String(value).replace(/\s+/g, ' ').trim()
}

function wrap(value, width) {
  const text = String(value || '—')
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (!word) continue
    if (word.length > width) {
      if (line) { lines.push(line); line = '' }
      for (let offset = 0; offset < word.length; offset += width) lines.push(word.slice(offset, offset + width))
      continue
    }
    if (line && line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else line += `${line ? ' ' : ''}${word}`
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['—']
}

module.exports = function createTerminalLogger(namespace) {
  return function terminalLog(event, details = {}) {
    const now = new Date()
    const time = now.toLocaleTimeString('en-GB', { hour12: false })
    const columns = Number(process.stdout.columns) || 88
    const width = Math.max(40, Math.min(columns, 120))
    const failed = /fall[oó]|error|no pudo|fallid/i.test(String(event))
    const prefix = color('90', time) + ' ' + color('36;1', `[${namespace}]`)
    console.log(`${prefix} ${color(failed ? '31;1' : '37;1', event)}`)

    for (const [key, value] of Object.entries(details || {})) {
      if (value == null || value === '') continue
      const keyText = `  ${label(key)}: `
      const valueWidth = Math.max(16, width - keyText.length)
      if (Array.isArray(value) && value.length && value.every(item => item && typeof item === 'object')) {
        for (const item of value) {
          const parts = [item.nombre || item.name || item.server, item.tipo || item.kind, item.calidad && item.calidad !== 'n/d' ? item.calidad : null]
            .filter(Boolean)
          const itemText = parts.length ? parts.join(' · ') : formatValue(item)
          const lines = wrap(itemText, Math.max(16, width - 5))
          console.log(color('90', `  - ${lines[0]}`))
          for (const continuation of lines.slice(1)) console.log(color('90', `    ${continuation}`))
        }
        continue
      }
      const lines = wrap(formatValue(value), valueWidth)
      console.log(`${color('90', keyText)}${lines[0]}`)
      for (const continuation of lines.slice(1)) console.log(`${' '.repeat(keyText.length)}${continuation}`)
    }
  }
}
