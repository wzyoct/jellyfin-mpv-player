export interface PlaybackLoadDiagnostic {
  status?: number
  contentType?: string
  redirects: number
  rangeRequested: boolean
  requiredHeaders: boolean
  phase: 'upstream' | 'redirect' | 'response' | 'stream' | 'gateway'
  source: 'upstream' | 'gateway' | 'redirect'
}

function isGenericLoadingError(value: string): boolean {
  return /^(?:loading failed|failed to load|无法加载)$/i.test(value.trim())
}

export function formatPlaybackLoadError(
  itemName: string,
  fileError?: string,
  diagnostic?: PlaybackLoadDiagnostic,
  reason?: string,
): string {
  const prefix = `《${itemName}》加载失败`
  if (diagnostic?.status !== undefined && diagnostic.status >= 400) {
    const source = diagnostic.source === 'gateway' ? '播放网关' : '媒体服务器'
    return `${prefix}：${source}返回 HTTP ${diagnostic.status}`
  }
  if (diagnostic && (diagnostic.source === 'redirect' || diagnostic.phase === 'redirect')) {
    return `${prefix}：重定向后的媒体地址无法加载`
  }
  if (fileError && !isGenericLoadingError(fileError)) return `${prefix}：${fileError}`
  if (isGenericLoadingError(fileError || '') || diagnostic?.status !== undefined) {
    return `${prefix}：${diagnostic?.redirects ? '重定向后的媒体地址无法加载' : '媒体资源无法加载'}`
  }
  const reasonLabel = reason && reason !== 'unknown' ? `（${reason}）` : ''
  return `${prefix}${reasonLabel}`
}
