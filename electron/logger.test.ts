import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppLogger, redactText, sanitizeLogValue } from './logger'

describe('log sanitization', () => {
  it('removes credentials, query values and full Windows paths', () => {
    const value = redactText('https://emby.example/Items/1?api_key=secret&SearchTerm=movie Authorization: Bearer abc C:\\Users\\mickey\\secret.txt')
    expect(value).toContain('https://[server]/Items/1')
    expect(value).toContain('Authorization: [REDACTED]')
    expect(value).not.toContain('secret')
    expect(value).not.toContain('abc')
    expect(redactText('/Items/1?api_key=secret&SearchTerm=movie')).toContain('api_key=[REDACTED]')
    expect(redactText('Authorization: MediaBrowser Client="Ember Player", Token="secret-token"')).not.toContain('secret-token')
  })

  it('redacts sensitive object keys and truncates deep values', () => {
    expect(sanitizeLogValue({ username: 'mickey', title: 'Movie', nested: { value: { value: { value: { value: 'x' } } } } }))
      .toEqual({ username: '[REDACTED]', title: '[REDACTED]', nested: { value: { value: { value: '[truncated]' } } } })
  })
})

describe('AppLogger', () => {
  it('writes JSONL entries and rotates after the size limit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ember-logger-'))
    const logger = new AppLogger()
    logger.initialize(directory)
    for (let index = 0; index < 3600; index += 1) logger.info('test', 'large-entry', { value: 'x'.repeat(1800) })

    const current = readFileSync(join(directory, 'jellyfin-mpv-player.log'), 'utf8')
    expect(current).toContain('"scope":"test"')
    expect(readFileSync(join(directory, 'jellyfin-mpv-player.log.1'), 'utf8').length).toBeGreaterThan(0)
  })

  it('does not throw when the log path is a file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ember-logger-file-'))
    const blockedPath = join(directory, 'blocked')
    writeFileSync(blockedPath, 'blocked')
    const logger = new AppLogger()
    expect(() => {
      logger.initialize(blockedPath)
      logger.info('test', 'write')
    }).not.toThrow()
  })

  it('prunes history beyond the four retained backups', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ember-logger-prune-'))
    writeFileSync(join(directory, 'jellyfin-mpv-player.log.4'), 'keep')
    writeFileSync(join(directory, 'jellyfin-mpv-player.log.5'), 'remove')
    const logger = new AppLogger()

    logger.initialize(directory)

    expect(existsSync(join(directory, 'jellyfin-mpv-player.log.4'))).toBe(true)
    expect(existsSync(join(directory, 'jellyfin-mpv-player.log.5'))).toBe(false)
  })

  it('serializes non-Error failures and ignores writes before initialization', () => {
    const logger = new AppLogger()
    expect(logger.getDirectory()).toBe('')
    expect(() => logger.error('test', 'before-init', 'plain failure')).not.toThrow()
    const directory = mkdtempSync(join(tmpdir(), 'ember-logger-error-'))
    logger.initialize(directory)
    logger.warn('test', 'warning')
    logger.error('test', 'non-error', 'plain failure', { token: 'secret' })
    const line = readFileSync(join(directory, 'jellyfin-mpv-player.log'), 'utf8')
    expect(line).toContain('plain failure')
    expect(line).toContain('[REDACTED]')
  })
})
