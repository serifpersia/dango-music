import { useRpc, useRpcMutation } from '../lib/rpc'

export interface MusicThumb {
  url: string
  width?: number
  height?: number
}

export interface MusicTrack {
  id: string
  title: string
  artists: string
  album?: string
  duration?: string
  thumbnails: MusicThumb[]
  liked?: boolean | null
}

export interface MusicPlaylist {
  id: string
  title: string
  subtitle?: string
  thumbnails: MusicThumb[]
}

const STALE_5_MIN = 5 * 60 * 1000

export const useMusicAuthStatus = () =>
  useRpc<{ authenticated: boolean }>(
    'music.authStatus',
    {},
    {
      staleTime: 30 * 1000,
      refetchInterval: (query) =>
        (query.state.data as { authenticated: boolean } | undefined)?.authenticated ? false : 3000,
    }
  )

export const useMusicSaveCookie = () =>
  useRpcMutation<unknown, { cookie?: string }>('music.authStart', (_data, variables) =>
    localStorage.setItem('ytmusic_cookie', variables.cookie ?? '')
  )

export const useMusicSearch = (query: string) =>
  useRpc<{ tracks: MusicTrack[] }>(
    'music.search',
    { q: query },
    { enabled: query.trim().length > 0, staleTime: STALE_5_MIN }
  )

export const useMusicLibrary = (enabled: boolean) =>
  useRpc<{ playlists: MusicPlaylist[] }>('music.library', {}, { enabled, staleTime: STALE_5_MIN })

export const useMusicPlaylist = (playlistId: string | null) =>
  useRpc<{ tracks: MusicTrack[] }>(
    'music.playlist',
    { id: playlistId ?? undefined },
    { enabled: !!playlistId, staleTime: STALE_5_MIN }
  )

export const useMusicUpNext = (trackId: string | null) =>
  useRpc<{ tracks: MusicTrack[] }>(
    'music.upnext',
    { id: trackId ?? undefined },
    { enabled: !!trackId, staleTime: STALE_5_MIN }
  )

export const useMusicLikedIds = (enabled: boolean) =>
  useRpc<{ likedIds: string[] }>('music.likes', {}, { enabled, staleTime: 2 * 60 * 1000 })

export const useMusicRate = () =>
  useRpcMutation<unknown, { id: string; like: boolean }>('music.like')
