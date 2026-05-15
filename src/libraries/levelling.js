export const growth = Math.pow(Math.PI / Math.E, 1.618) * Math.E * 0.75

const toNumber = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const normalizeMultiplier = (multiplier = global.multiplier || 1) => {
  multiplier = toNumber(multiplier, 1)
  return multiplier > 0 ? multiplier : 1
}

export function xpRange(level, multiplier = global.multiplier || 1) {
  level = Math.floor(toNumber(level, 0))
  multiplier = normalizeMultiplier(multiplier)

  if (level < 0) {
    throw new TypeError('level cannot be negative value')
  }

  const min = level === 0
    ? 0
    : Math.round(Math.pow(level, growth) * multiplier) + 1

  const max = Math.round(Math.pow(level + 1, growth) * multiplier)

  return {
    min,
    max,
    xp: Math.max(1, max - min),
  }
}

export function findLevel(xp, multiplier = global.multiplier || 1) {
  xp = toNumber(xp, 0)
  multiplier = normalizeMultiplier(multiplier)

  if (xp === Infinity) {
    return Infinity
  }

  if (Number.isNaN(xp)) {
    return NaN
  }

  if (xp <= 0) {
    return 0
  }

  let level = 0

  while (xpRange(level + 1, multiplier).min <= xp) {
    level++
  }

  return level
}

export function canLevelUp(level, xp, multiplier = global.multiplier || 1) {
  level = Math.floor(toNumber(level, 0))
  xp = toNumber(xp, 0)
  multiplier = normalizeMultiplier(multiplier)

  if (level < 0) {
    return false
  }

  if (xp === Infinity) {
    return true
  }

  if (Number.isNaN(xp)) {
    return false
  }

  if (xp <= 0) {
    return false
  }

  return level < findLevel(xp, multiplier)
}
