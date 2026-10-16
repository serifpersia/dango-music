import { discordRPCService } from './discord-rpc.js'

function cleanThumb(raw: unknown): string {
  let thumb = String(raw || '')
  if (thumb.includes('/api/image-proxy')) {
    const match = thumb.match(/url=([^&]+)/)
    if (match) thumb = decodeURIComponent(match[1])
  }
  if (thumb && !thumb.startsWith('https://')) thumb = ''
  if (thumb.includes('localhost') || thumb.includes('127.0.0.1')) thumb = ''
  return thumb
}

export const discordHandlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>> =
  {
    heartbeat: async (input) => {
      if (!discordRPCService.isServiceEnabled) return { success: true }
      const sessionId = input['sessionId']
      if (typeof sessionId !== 'string') return { success: true }
      if (input['bye']) discordRPCService.removeHeartbeat(sessionId)
      else discordRPCService.heartbeat(sessionId)
      return { success: true }
    },

    clear: async (input) => {
      if (!discordRPCService.isServiceEnabled) return { success: true }
      const sessionId = input['sessionId']
      discordRPCService.clearPresence(typeof sessionId === 'string' ? sessionId : undefined)
      return { success: true }
    },

    radioPresence: async (input) => {
      if (!discordRPCService.isServiceEnabled) return { success: true }
      const sessionId = input['sessionId']
      if (typeof sessionId === 'string') discordRPCService.heartbeat(sessionId)
      const stationLabel = String(input['stationLabel'] || '')
      discordRPCService.updatePresence({
        title: String(input['title'] || 'Radio').slice(0, 128),
        episode: stationLabel.slice(0, 64),
        totalEpisodes: '',
        stateLine: (stationLabel || 'Radio').slice(0, 64),
        currentTime: Number(input['currentTime']) || 0,
        duration: 0,
        thumbnail: cleanThumb(input['thumbnail']),
        isPlaying: !!input['isPlaying'],
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      })
      return { success: true }
    },

    musicPresence: async (input) => {
      if (!discordRPCService.isServiceEnabled) return { success: true }
      const sessionId = input['sessionId']
      if (typeof sessionId === 'string') discordRPCService.heartbeat(sessionId)
      const artistLabel = String(input['artistLabel'] || '')
      discordRPCService.updatePresence({
        title: String(input['title'] || 'Music').slice(0, 128),
        episode: artistLabel.slice(0, 64),
        totalEpisodes: '',
        stateLine: (artistLabel || 'Music').slice(0, 64),
        currentTime: Number(input['currentTime']) || 0,
        duration: Number(input['duration']) || 0,
        thumbnail: cleanThumb(input['thumbnail']),
        isPlaying: !!input['isPlaying'],
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      })
      return { success: true }
    },
  }
