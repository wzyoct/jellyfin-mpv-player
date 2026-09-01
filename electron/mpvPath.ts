import { win32 } from 'node:path'

const DEFAULT_MPV_PATH = 'mpv.exe'

function stripWrappingQuotes(value: string): string {
  let result = value.trim()
  while (result.length >= 2) {
    const first = result[0]
    const last = result[result.length - 1]
    if ((first !== '"' && first !== "'") || last !== first) break
    result = result.slice(1, -1).trim()
  }
  return result
}

function normalizeUncPath(value: string): string {
  if (!/^[\\/]{2,}/.test(value)) return win32.normalize(value)
  const body = value.replace(/^[\\/]+/, '')
  const normalizedBody = win32.normalize(body).replace(/^[\\/]+/, '')
  return `\\\\${normalizedBody}`
}

export function normalizeMpvPath(input?: string): string {
  const value = stripWrappingQuotes(typeof input === 'string' ? input : '')
  if (!value) return DEFAULT_MPV_PATH
  return normalizeUncPath(value)
}
