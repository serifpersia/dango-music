import { Client, StatusDisplayType } from '@xhayper/discord-rpc'
import logger from './logger.js'
import { CONFIG } from './config.js'

const log = logger.child({ module: 'DiscordRPC' })

interface DiscordActivityData {
  title: string
  episode: string
  totalEpisodes?: string
  currentTime: number
  duration: number
  thumbnail: string
  isPlaying: boolean
  sessionId?: string
  stateLine?: string
}

class DiscordRPCService {
  private client: Client | null = null
  private isEnabled: boolean = false
  private reconnectTimeout: NodeJS.Timeout | null = null
  private lastActivity: DiscordActivityData | null = null
  private currentSessionId: string | null = null
  private hasEverConnected: boolean = false
  private permanentlyDisabled: boolean = false
  private heartbeats: Map<string, number> = new Map()
  private heartbeatTimer: NodeJS.Timeout | null = null
  private retryCount: number = 0
  private readonly MAX_RETRIES = 5
  private readonly INITIAL_RECONNECT_DELAY = 15000
  private readonly MAX_RECONNECT_DELAY = 300000
  private readonly HEARTBEAT_TIMEOUT = 40000
  private readonly HEARTBEAT_CHECK_INTERVAL = 10000

  public async setEnabled(enabled: boolean) {
    if (this.isEnabled === enabled) return
    this.isEnabled = enabled
    if (enabled) {
      if (this.permanentlyDisabled) {
        log.debug('Discord Rich Presence is unavailable on this device/session. Not retrying.')
        this.isEnabled = false
        return
      }
      this.retryCount = 0
      this.connect()
    } else {
      await this.disconnect()
    }
  }

  public get isServiceEnabled(): boolean {
    return this.isEnabled && this.client !== null
  }

  public heartbeat(sessionId: string) {
    this.heartbeats.set(sessionId, Date.now())
    if (!this.heartbeatTimer && this.isEnabled) {
      this.heartbeatTimer = setInterval(() => {
        void this.checkHeartbeats()
      }, this.HEARTBEAT_CHECK_INTERVAL)
    }
  }

  public removeHeartbeat(sessionId: string) {
    this.heartbeats.delete(sessionId)
    void this.checkHeartbeats()
  }

  private async checkHeartbeats() {
    if (!this.isEnabled) {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
      return
    }

    const now = Date.now()
    for (const [sessionId, lastSeen] of this.heartbeats) {
      if (now - lastSeen > this.HEARTBEAT_TIMEOUT) {
        this.heartbeats.delete(sessionId)
      }
    }

    if (this.heartbeats.size === 0) {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
      if (this.lastActivity || this.currentSessionId) {
        this.lastActivity = null
        this.currentSessionId = null
        await this.setIdleStatus()
      }
    }
  }

  private async connect() {
    if (!this.isEnabled || this.client || this.permanentlyDisabled) return

    const isTermux = !!process.env.TERMUX_VERSION
    const isAndroid = process.platform === 'android'
    if (isTermux || isAndroid) {
      log.debug('Discord Rich Presence is not supported on Android/Termux. Skipping connection.')
      this.isEnabled = false
      this.permanentlyDisabled = true
      return
    }

    const clientId = CONFIG.DISCORD_CLIENT_ID
    if (!clientId) {
      log.debug('DISCORD_CLIENT_ID is not configured. Discord Rich Presence is disabled.')
      this.isEnabled = false
      this.permanentlyDisabled = true
      return
    }

    try {
      this.client = new Client({ clientId })

      this.client.on('ready', () => {
        log.info('Connected to Discord client successfully')
        this.hasEverConnected = true
        this.retryCount = 0
        if (this.lastActivity) {
          this.updatePresence(this.lastActivity)
        } else {
          this.setIdleStatus()
        }
      })

      this.client.on('disconnected', () => {
        log.warn('Disconnected from Discord client, scheduling reconnect...')
        this.cleanup()
        this.scheduleReconnect()
      })

      this.client.on('ERROR', (err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (errMsg.includes('ENOENT') || errMsg.includes('ECONNREFUSED')) {
          this.cleanup()
          if (!this.hasEverConnected) {
            log.debug('Discord client not detected. Rich Presence disabled for this session.')
            this.isEnabled = false
            this.permanentlyDisabled = true
            return
          }
          log.debug('Discord client not running or connection refused.')
          this.scheduleReconnect()
        } else {
          log.error({ err }, 'Discord RPC client error')
          this.cleanup()
          this.scheduleReconnect()
        }
      })

      const loginPromise = this.client.login()
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Login timeout')), 5000)
      )

      await Promise.race([loginPromise, timeoutPromise])
      this.hasEverConnected = true
    } catch (err) {
      this.cleanup()
      if (!this.hasEverConnected) {
        log.debug(
          'Discord client not available at startup. Rich Presence disabled for the rest of this session.'
        )
        this.isEnabled = false
        this.permanentlyDisabled = true
        return
      }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    if (!this.isEnabled || this.reconnectTimeout || this.permanentlyDisabled) return

    const delay = Math.min(
      this.INITIAL_RECONNECT_DELAY * Math.pow(1.5, this.retryCount),
      this.MAX_RECONNECT_DELAY
    )

    this.retryCount++

    if (this.retryCount > this.MAX_RETRIES) {
      log.debug(
        `Discord RPC login failed ${this.retryCount} times. Retrying in ${Math.round(delay / 1000)}s...`
      )
    } else {
      log.info(`Discord RPC login failed. Retrying in ${Math.round(delay / 1000)}s...`)
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      this.connect()
    }, delay)
  }

  private cleanup() {
    if (this.client) {
      try {
        this.client.removeAllListeners()
        this.client.destroy()
      } catch (err) {
        // ignore
      }
      this.client = null
    }
  }

  public async disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.client?.user) {
      try {
        await this.client.user.clearActivity()
      } catch {
        // ignore
      }
    }

    this.cleanup()
    this.lastActivity = null
    this.currentSessionId = null
    this.heartbeats.clear()
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  public async updatePresence(data: DiscordActivityData) {
    this.lastActivity = data
    if (data.sessionId) {
      this.currentSessionId = data.sessionId
    }
    if (!this.isEnabled) return

    if (!this.client || !this.client.user) return

    const isSafeUrl = (url: string): boolean =>
      url.startsWith('https://') && !url.includes('localhost') && !url.includes('127.0.0.1')

    let imageKey = 'logo'
    if (data.thumbnail && isSafeUrl(data.thumbnail)) {
      imageKey = data.thumbnail
    }

    try {
      if (!data.isPlaying) {
        await this.client.user.clearActivity()
        await this.client.user.setActivity({
          details: data.title,
          state: data.stateLine
            ? `${data.stateLine} (Paused)`
            : `Episode ${data.episode}${data.totalEpisodes ? `/${data.totalEpisodes}` : ''} (Paused)`,
          largeImageKey: imageKey,
          largeImageText: data.title,
          type: 2,
          statusDisplayType: StatusDisplayType.DETAILS,
          buttons: [
            {
              label: 'Learn More',
              url: 'https://github.com/serifpersia/dango-music',
            },
          ],
        })
        return
      }

      const nowSeconds = Math.round(Date.now() / 1000)

      const activity: {
        details: string
        state: string
        startTimestamp?: number
        endTimestamp?: number
        largeImageKey: string
        largeImageText: string
        type: number
        statusDisplayType?: number
        buttons: { label: string; url: string }[]
      } = {
        details: data.title,
        state: data.stateLine
          ? data.stateLine
          : `Episode ${data.episode}${data.totalEpisodes ? `/${data.totalEpisodes}` : ''}`,
        largeImageKey: imageKey,
        largeImageText: data.title,
        type: 2,
        statusDisplayType: StatusDisplayType.DETAILS,
        buttons: [
          {
            label: 'Learn More',
            url: 'https://github.com/serifpersia/dango-music',
          },
        ],
      }

      if (data.currentTime && data.currentTime > 0) {
        activity.startTimestamp = Math.round(nowSeconds - data.currentTime)
      }

      if (data.duration && data.duration > data.currentTime) {
        activity.endTimestamp = Math.round(nowSeconds + (data.duration - data.currentTime))
      }

      await this.client.user.setActivity(activity)
    } catch (err) {
      log.error({ err }, 'Failed to set Discord activity')
    }
  }

  public async setIdleStatus() {
    if (!this.isEnabled) return

    if (!this.client?.user) {
      log.warn('Discord client not connected, skipping idle status update')
      return
    }

    try {
      await this.client.user.setActivity({
        details: 'dango-music',
        state: 'Idle',
        largeImageKey: 'logo',
        largeImageText: 'dango-music',
        type: 2,
        statusDisplayType: StatusDisplayType.DETAILS,
        buttons: [
          {
            label: 'Learn More',
            url: 'https://github.com/serifpersia/dango-music',
          },
        ],
      })
    } catch (err) {
      if ((err as Error).message === 'Closed by Discord') {
        log.warn('Discord connection ended, skipping idle status update')
      } else {
        log.error({ err }, 'Failed to set Discord idle status')
      }
    }
  }

  public async clearPresence(sessionId?: string) {
    if (sessionId && this.currentSessionId && sessionId !== this.currentSessionId) {
      return
    }

    this.lastActivity = null
    this.currentSessionId = null

    await this.setIdleStatus()
  }
}

export const discordRPCService = new DiscordRPCService()
