import { describe, expect, it } from 'vitest'
import { consumeJsonLines } from './mpvIpc'

describe('consumeJsonLines', () => {
  it('keeps incomplete JSON until the next chunk', () => {
    const first = consumeJsonLines('', '{"event":"property-change","name":"time-pos"')
    expect(first.messages).toEqual([])

    const second = consumeJsonLines(first.buffer, ',"data":12.5}\n')
    expect(second.buffer).toBe('')
    expect(second.messages).toEqual([{ event: 'property-change', name: 'time-pos', data: 12.5 }])
  })

  it('parses multiple responses and events in one chunk', () => {
    const parsed = consumeJsonLines('', [
      '{"request_id":1,"error":"success","data":12.5}',
      '{"event":"property-change","name":"pause","data":false}',
      '{"request_id":2,"error":"success"}',
    ].join('\n') + '\n')
    expect(parsed.messages).toEqual([
      { request_id: 1, error: 'success', data: 12.5 },
      { event: 'property-change', name: 'pause', data: false },
      { request_id: 2, error: 'success' },
    ])
  })

  it('ignores malformed lines without losing the following message', () => {
    const parsed = consumeJsonLines('', 'not-json\n{"event":"end-file"}\n')
    expect(parsed.messages).toEqual([{ event: 'end-file' }])
  })

  it('preserves MPV end-file reasons used by the playback session', () => {
    const parsed = consumeJsonLines('', [
      '{"event":"end-file","reason":"eof"}',
      '{"event":"end-file","reason":"quit"}',
      '{"event":"end-file","reason":"error","file_error":"not found"}',
    ].join('\n') + '\n')
    expect(parsed.messages.map((message) => message.reason)).toEqual(['eof', 'quit', 'error'])
    expect(parsed.messages[2].file_error).toBe('not found')
  })
})
