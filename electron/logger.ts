import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

const LOG_FILE = 'jellyfin-mpv-player.log'
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_BACKUPS = 4
const MAX_TEXT_LENGTH = 2000
const SENSITIVE_KEY = /token|password|authorization|cookie|username|title|mediaurl|streamurl|headers?|body|path/i

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//[server]${url.pathname}`
  } catch {
    return '[url]'
  }
}

export function redactText(value: string): string {
  let output = value.slice(0, MAX_TEXT_LENGTH)
  output = output.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactUrl(match))
  output = output.replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^,\s"']+/gi, '$1[REDACTED]')
  output = output.replace(/((?:x-media-browser-token|cookie|password|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s"']+)/gi, '$1[REDACTED]')
  output = output.replace(/([?&][^=&#\s]+)=([^&#\s]*)/g, '$1=[REDACTED]')
  output = output.replace(/\b[A-Za-z]:\\[^\r\n\t"']+/g, '[path]')
  return output
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]'
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeLogValue(item, depth + 1))
  if (typeof value !== 'object') return String(value)

  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value).slice(0, 40)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeLogValue(entry, depth + 1)
  }
  return output
}

function errorText(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

export class AppLogger {
  private directory = ''

  initialize(directory: string): void {
    this.directory = directory
    try {
      mkdirSync(directory, { recursive: true })
      this.pruneBackups()
    } catch (error) {
      this.reportWriteFailure(error)
    }
  }

  getDirectory(): string {
    return this.directory
  }

  info(scope: string, event: string, context?: Record<string, unknown>): void {
    this.write('info', scope, event, context)
  }

  warn(scope: string, event: string, context?: Record<string, unknown>): void {
    this.write('warn', scope, event, context)
  }

  error(scope: string, event: string, errorOrContext?: unknown, context?: Record<string, unknown>): void {
    const error = errorText(errorOrContext)
    this.write('error', scope, event, {
      ...context,
      error: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    })
  }

  private write(level: LogLevel, scope: string, event: string, context?: Record<string, unknown>): void {
    if (!this.directory) return
    try {
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        scope,
        event,
        ...(context ? { context: sanitizeLogValue(context) } : {}),
      }) + '\n'
      const filePath = join(this.directory, LOG_FILE)
      this.rotateIfNeeded(filePath, Buffer.byteLength(line, 'utf8'))
      appendFileSync(filePath, line, 'utf8')
    } catch (error) {
      this.reportWriteFailure(error)
    }
  }

  private rotateIfNeeded(filePath: string, incomingBytes: number): void {
    const currentBytes = existsSync(filePath) ? statSync(filePath).size : 0
    if (currentBytes + incomingBytes <= MAX_FILE_BYTES) return
    for (let index = MAX_BACKUPS; index >= 1; index -= 1) {
      const source = index === 1 ? filePath : `${filePath}.${index - 1}`
      const target = `${filePath}.${index}`
      if (existsSync(target)) unlinkSync(target)
      if (existsSync(source)) renameSync(source, target)
    }
  }

  private pruneBackups(): void {
    for (const name of readdirSync(this.directory)) {
      const match = name.match(/^jellyfin-mpv-player\.log\.(\d+)$/)
      if (match && Number(match[1]) > MAX_BACKUPS) unlinkSync(join(this.directory, name))
    }
  }

  private reportWriteFailure(error: unknown): void {
    const details = errorText(error)
    process.stderr.write(`Jellyfin MPV Player logger failed: ${redactText(details.message)}\n`)
  }
}

export const logger = new AppLogger()
