export function unwrapIpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const unwrapped = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim()
  return unwrapped || '操作失败'
}
