/** Save bytes or text as a browser download. */

export function downloadBytes(name: string, data: Uint8Array | string, type = 'application/octet-stream'): void {
  const blob = new Blob([typeof data === 'string' ? data : (data.slice().buffer as ArrayBuffer)], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
