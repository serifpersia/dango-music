import { useRpc, useRpcMutation } from '../lib/rpc'

export type { MusicThumb } from '../lib/contract'
export type { MusicTrack, MusicPlaylist } from '../lib/contract'

const STALE_5_MIN = 5 * 60 * 1000

export const useMusicAuthStatus = () =>
  useRpc('music.authStatus', {}, {
    staleTime: 30 * 1000,
    refetchInterval: (query) =>
      (query.state.data as { authenticated: boolean } | undefined)?.authenticated ? false : 3000,
  })

export const useMusicSaveCookie = () =>
  useRpcMutation('music.authStart', (_data, variables) =>
    localStorage.setItem('ytmusic_cookie', variables.cookie ?? '')
  )

export const useMusicSignOut = () => useRpcMutation('music.authSignOut')

export const useMusicSearch = (query: string) =>
  useRpc('music.search', { q: query }, { enabled: query.trim().length > 0, staleTime: STALE_5_MIN })

export const useMusicLibrary = (enabled: boolean) =>
  useRpc('music.library', {}, { enabled, staleTime: STALE_5_MIN })

export const useMusicPlaylist = (playlistId: string | null) =>
  useRpc('music.playlist', { id: playlistId ?? undefined }, { enabled: !!playlistId, staleTime: STALE_5_MIN })

export const useMusicUpNext = (trackId: string | null) =>
  useRpc('music.upnext', { id: trackId ?? undefined }, { enabled: !!trackId, staleTime: STALE_5_MIN })

export const useMusicLikedIds = (enabled: boolean) =>
  useRpc('music.likes', {}, { enabled, staleTime: 2 * 60 * 1000 })

export const useMusicRate = () => useRpcMutation('music.like')
