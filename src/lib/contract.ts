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

export interface RadioStation {
  id: string
  name: string
  streamUrl: string
  homepage?: string
  favicon?: string
  tags?: string
  codec?: string
  bitrate?: number
  source: 'listen.moe' | 'radio-browser'
  gateway?: string
}

export interface RpcContract {
  'music.authStatus': { input: Record<string, never>; output: { authenticated: boolean } }
  'music.authStart': {
    input: { cookie?: string }
    output: { success: boolean; tracks: number; playlists: number }
  }
  'music.authSignOut': { input: Record<string, never>; output: { success: boolean } }
  'music.trackById': { input: { id: string }; output: { tracks: MusicTrack[] } }
  'music.search': { input: { q: string }; output: { tracks: MusicTrack[] } }
  'music.playlist': { input: { id?: string }; output: { tracks: MusicTrack[] } }
  'music.library': { input: Record<string, never>; output: { tracks: MusicTrack[]; playlists: MusicPlaylist[] } }
  'music.upnext': { input: { id?: string }; output: { tracks: MusicTrack[]; playlistId: string | null } }
  'music.likes': { input: Record<string, never>; output: { likedIds: string[] } }
  'music.like': { input: { id: string; like: boolean }; output: { success: boolean; liked: boolean } }
  'radio.stations': { input: Record<string, never>; output: { stations: RadioStation[] } }
  'radio.search': { input: { q: string }; output: { stations: RadioStation[] } }
  'discord.heartbeat': { input: { sessionId: string; bye?: boolean }; output: { success: boolean } }
  'discord.clear': { input: { sessionId?: string }; output: { success: boolean } }
  'discord.radioPresence': {
    input: {
      title: string
      stationLabel: string
      isPlaying: boolean
      thumbnail: string
      currentTime: number
      sessionId?: string
    }
    output: { success: boolean }
  }
  'discord.musicPresence': {
    input: {
      title: string
      artistLabel: string
      isPlaying: boolean
      thumbnail: string
      currentTime: number
      duration: number
      sessionId?: string
    }
    output: { success: boolean }
  }
}
