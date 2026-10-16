import { dangoUrl } from './api'

function body(input: unknown): string {
  return JSON.stringify({ 0: input ?? {} })
}

function url(path: string): string {
  return dangoUrl(`/api/trpc/${path}?batch=1`)
}

export function trpcBeacon(path: string, input: unknown): void {
  const payload = body(input)
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url(path), new Blob([payload], { type: 'application/json' }))
      return
    }
  } catch {
    // ignore
  }
  fetch(url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {})
}

export function clearDiscordPresence(sessionId: string | undefined): void {
  if (!sessionId) return
  trpcBeacon('discord.clear', { sessionId })
  trpcBeacon('discord.heartbeat', { sessionId, bye: true })
}
