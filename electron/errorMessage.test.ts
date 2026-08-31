import { describe, expect, it } from 'vitest'
import { unwrapIpcError } from './errorMessage'

describe('unwrapIpcError', () => {
  it('removes Electron remote method wrappers', () => {
    expect(unwrapIpcError(new Error("Error invoking remote method 'playback:start': Error: MPV IPC 参数无效")))
      .toBe('MPV IPC 参数无效')
  })

  it('returns a useful fallback for empty errors', () => {
    expect(unwrapIpcError('')).toBe('操作失败')
  })
})
