import { useEffect, useRef, useState } from 'react'
import { useRpc } from '../lib/rpc'
export type { RadioStation } from '../lib/contract'


export interface ListenMoeSong {
  id: number
  title: string
  titleRomaji?: string | null
  artists: { name: string; nameRomaji?: string | null; image?: string | null }[]
  sources: { name?: string | null; nameRomaji?: string | null; image?: string | null }[]
  albums: { name?: string | null; nameRomaji?: string | null; image?: string | null }[]
  duration: number
}

export interface ListenMoeNowPlaying {
  song: ListenMoeSong | null
  lastPlayed: ListenMoeSong[]
  listeners: number
  startTime: string | null
}

const STALE_5_MIN = 5 * 60 * 1000

const COVER_BASE = 'https://cdn.listen.moe/covers/'

export function coverUrl(file?: string | null): string | null {
  if (!file) return null
  if (file.startsWith('http')) return file
  return `${COVER_BASE}${file}`
}

export function songArt(song: ListenMoeSong | null): string | null {
  if (!song) return null
  return (
    coverUrl(song.albums[0]?.image) ||
    coverUrl(song.artists[0]?.image) ||
    coverUrl(song.sources[0]?.image)
  )
}

export function songArtist(song: ListenMoeSong | null): string {
  if (!song) return ''
  return song.artists.map((a) => a.nameRomaji || a.name).join(', ')
}

export const useRadioStations = () =>
  useRpc('radio.stations', {}, { staleTime: STALE_5_MIN })

export const useRadioSearch = (query: string) =>
  useRpc('radio.search', { q: query }, { enabled: query.trim().length > 0, staleTime: STALE_5_MIN })

const emptyNowPlaying: ListenMoeNowPlaying = {
  song: null,
  lastPlayed: [],
  listeners: 0,
  startTime: null,
}

export const useListenMoe = (gateway?: string) => {
  const [nowPlaying, setNowPlaying] = useState<ListenMoeNowPlaying>(emptyNowPlaying)
  const heartbeatRef = useRef<number | null>(null)

  useEffect(() => {
    setNowPlaying(emptyNowPlaying)
    if (!gateway) return

    let ws: WebSocket | null = null

    try {
      ws = new WebSocket(gateway)
    } catch {
      return
    }

    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data as string)
        if (d.op === 0) {
          const interval = d.d?.heartbeat || 35000
          if (heartbeatRef.current) window.clearInterval(heartbeatRef.current)
          heartbeatRef.current = window.setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 9 }))
          }, interval)
        } else if (d.op === 1) {
          setNowPlaying({
            song: d.d?.song || null,
            lastPlayed: d.d?.lastPlayed || [],
            listeners: d.d?.listeners || 0,
            startTime: d.d?.startTime || null,
          })
        }
      } catch {
        // ignore
      }
    }

    return () => {
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current)
      heartbeatRef.current = null
      if (ws) ws.close()
    }
  }, [gateway])

  return { nowPlaying }
}
