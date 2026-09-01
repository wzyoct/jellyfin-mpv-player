import { describe, expect, it } from 'vitest'
import { normalizeMpvPath } from './mpvPath'

describe('normalizeMpvPath', () => {
  it.each([
    ['C:\\green\\mpv\\mpv.exe', 'C:\\green\\mpv\\mpv.exe'],
    ['C:\\\\green\\\\\\mpv\\\\\\mpv.exe', 'C:\\green\\mpv\\mpv.exe'],
    ['"C:\\green\\mpv\\mpv.exe"', 'C:\\green\\mpv\\mpv.exe'],
    ["'C:\\green\\mpv\\mpv.exe'", 'C:\\green\\mpv\\mpv.exe'],
    ['  C:/Program Files/mpv/mpv.exe  ', 'C:\\Program Files\\mpv\\mpv.exe'],
    ['"C:/Program Files/mpv/mpv.exe"', 'C:\\Program Files\\mpv\\mpv.exe'],
    ['\\\\server\\share\\mpv\\mpv.exe', '\\\\server\\share\\mpv\\mpv.exe'],
    ['\\\\\\server\\\\\\share\\\\\\mpv.exe', '\\\\server\\share\\mpv.exe'],
    ['mpv.exe', 'mpv.exe'],
  ])('normalizes %j', (input, expected) => {
    expect(normalizeMpvPath(input)).toBe(expected)
  })

  it('uses the PATH executable for empty input', () => {
    expect(normalizeMpvPath()).toBe('mpv.exe')
    expect(normalizeMpvPath('   ')).toBe('mpv.exe')
    expect(normalizeMpvPath('""')).toBe('mpv.exe')
  })
})
