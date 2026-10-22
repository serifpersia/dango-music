import logger from './logger.js'
import {
  getInnertube,
  getAuthedInnertube,
  refreshAuthedInnertube,
  saveMusicCookie,
  clearMusicCookie,
  getMusicAuthStatus,
  isParserVariantError,
  verifyMusicSession,
  type YtPanel,
  type YtSessionActions,
} from './ytmusic.js'

export interface MusicTrack {
  id: string
  title: string
  artists: string
  album?: string
  duration?: string
  thumbnails: { url: string; width?: number; height?: number }[]
  liked?: boolean | null
}

export interface MusicPlaylist {
  id: string
  title: string
  subtitle?: string
  thumbnails: { url: string; width?: number; height?: number }[]
}

const NAME_SUFFIXES = [
  /\s*(- topic)$/i,
  /\s*vevo$/i,
  /\s*[(|[]official(.*?)[)|\]]/i,
  /\s*[(|[]((lyrics?|visualizer|audio)\s*(video)?)[)|\]]/i,
  /\s*[(|[](performance video)[)|\]]/i,
  /\s*[(|[](clip official)[)|\]]/i,
  /\s*[(|[](video version)[)|\]]/i,
  /\s*[(|[](HD|HQ)\s*?(?:audio)?[)|\]]$/i,
  /\s*[(|[](live)[)|\]]$/i,
  /\s*[(|[]4K\s*?(?:upgrade)?[)|\]]$/i,
]

function cleanupMusicName(name: string): string {
  if (!name) return name
  let out = name
  for (const re of NAME_SUFFIXES) out = out.replace(re, '')
  return out.trim()
}

function textOf(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  const obj = value as { text?: string; runs?: { text?: string }[] }
  if (typeof obj.text === 'string') return obj.text
  if (Array.isArray(obj.runs)) return obj.runs.map((r) => r.text || '').join('')
  return ''
}

function thumbsOf(value: unknown): MusicTrack['thumbnails'] {
  if (!value) return []
  if (Array.isArray(value)) {
    return (value as { url?: string; width?: number; height?: number }[])
      .filter((t) => t && typeof t.url === 'string')
      .map((t) => ({ url: t.url as string, width: t.width, height: t.height }))
  }
  const obj = value as { thumbnails?: unknown }
  if (Array.isArray(obj.thumbnails)) return thumbsOf(obj.thumbnails)
  return []
}

function toTrack(node: unknown): MusicTrack | null {
  const n = node as Record<string, unknown>
  const id = (n['video_id'] as string) || (n['videoId'] as string) || (n['id'] as string) || ''
  if (!id || typeof id !== 'string') return null
  const titleObj = n['title'] as { text?: string } | string | undefined
  const title = typeof titleObj === 'string' ? titleObj : (titleObj?.text ?? 'Unknown title')
  const artistsRaw = n['artists'] ?? n['authors'] ?? n['subtitle']
  let artists = ''
  if (Array.isArray(artistsRaw)) {
    artists = artistsRaw
      .map((a) => {
        const item = a as { name?: string; text?: string; title?: string }
        return item.name || item.text || item.title || ''
      })
      .filter(Boolean)
      .join(', ')
  } else if (typeof artistsRaw === 'string') {
    artists = artistsRaw
  } else if (artistsRaw && typeof artistsRaw === 'object') {
    artists = (artistsRaw as { text?: string }).text ?? ''
  }
  const thumbnails = thumbsOf(n['thumbnails'] ?? n['thumbnail'])
  const albumText = textOf(n['album'])
  const durationText = textOf(n['duration'])
  return {
    id,
    title: cleanupMusicName(String(title)),
    artists: cleanupMusicName(artists),
    album: albumText ? cleanupMusicName(albumText) : undefined,
    duration: durationText || undefined,
    thumbnails,
  }
}

function nodeType(node: unknown): string {
  const n = node as { type?: unknown; constructor?: { name?: string } }
  if (typeof n?.type === 'string') return n.type
  return n?.constructor?.name ?? ''
}

function asMenuItems(menu: unknown): Record<string, unknown>[] {
  if (!menu || typeof menu !== 'object') return []
  const items = (menu as { items?: unknown }).items
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : []
}

function upnextToTrack(node: unknown, trustLike = false): MusicTrack | null {
  const kind = nodeType(node)
  if (kind === 'AutomixPreviewVideo') return null
  const n = node as Record<string, unknown>
  const video =
    kind === 'PlaylistPanelVideoWrapper'
      ? ((n['primary'] as Record<string, unknown> | null) ?? null)
      : n
  if (!video || typeof video !== 'object') return null
  const id = video['video_id']
  if (typeof id !== 'string' || !id) return null
  const artistsRaw = video['artists']
  let artists = ''
  if (Array.isArray(artistsRaw)) {
    artists = artistsRaw
      .map((a) => (a as { name?: string })?.name || '')
      .filter(Boolean)
      .join(', ')
  }
  if (!artists && typeof video['author'] === 'string') artists = video['author']
  const albumRaw = video['album'] as { name?: string } | undefined
  const durationRaw = video['duration'] as { text?: string } | string | undefined
  const durationText = typeof durationRaw === 'string' ? durationRaw : (durationRaw?.text ?? '')
  let liked: boolean | null = null
  if (trustLike) {
    for (const menu of [video['menu'], (node as Record<string, unknown>)['menu']]) {
      let found: boolean | null = null
      for (const entry of asMenuItems(menu)) {
        if (nodeType(entry) !== 'ToggleMenuServiceItem') continue
        const icon = entry['icon_type']
        if (icon !== 'FAVORITE' && icon !== 'UNFAVORITE') continue
        found = icon === 'UNFAVORITE'
        break
      }
      if (found !== null) {
        liked = found
        break
      }
    }
  }
  return {
    id,
    title: cleanupMusicName(textOf(video['title']) || 'Unknown title'),
    artists: cleanupMusicName(artists || 'Unknown artist'),
    album: albumRaw?.name ? cleanupMusicName(albumRaw.name) : undefined,
    duration: durationText || undefined,
    thumbnails: thumbsOf(video['thumbnail'] ?? video['thumbnails']),
    ...(liked !== null ? { liked } : {}),
  }
}

function parseUpnext(
  panel: unknown,
  trustLike: boolean
): { tracks: MusicTrack[]; playlistId: string | null } {
  const tracks: MusicTrack[] = []
  const shaped = panel as YtPanel
  const contents = shaped.contents ?? []
  for (const item of contents) {
    const track = upnextToTrack(item, trustLike)
    if (track) tracks.push(track)
    if (tracks.length >= 50) break
  }
  return { tracks, playlistId: shaped.playlist_id ?? null }
}

interface MenuEndpoint {
  call: (actions: unknown) => Promise<unknown>
  payload?: { signInEndpoint?: unknown }
}

function isSignInPrompt(endpoint: MenuEndpoint | null): boolean {
  return !!endpoint?.payload && 'signInEndpoint' in endpoint.payload
}

function findLikeToggle(
  item: unknown,
  videoId: string
): { like: MenuEndpoint | null; unlike: MenuEndpoint | null } {
  const result = { like: null as MenuEndpoint | null, unlike: null as MenuEndpoint | null }
  const kind = nodeType(item)
  const n = item as Record<string, unknown>
  const video =
    kind === 'PlaylistPanelVideoWrapper'
      ? ((n['primary'] as Record<string, unknown> | null) ?? null)
      : n
  if (!video || video['video_id'] !== videoId) return result
  for (const menu of [video['menu'], n['menu']]) {
    for (const entry of asMenuItems(menu)) {
      if (nodeType(entry) !== 'ToggleMenuServiceItem') continue
      const icon = entry['icon_type']
      if (icon !== 'FAVORITE' && icon !== 'UNFAVORITE') continue
      for (const key of ['default_endpoint', 'toggled_endpoint'] as const) {
        const ep = entry[key] as Partial<MenuEndpoint> & { payload?: { status?: string } }
        if (typeof ep?.call !== 'function') continue
        const status = ep.payload?.status
        if (status === 'LIKE' && !result.like) result.like = ep as MenuEndpoint
        else if (status === 'INDIFFERENT' && !result.unlike) result.unlike = ep as MenuEndpoint
      }
      if (result.like && result.unlike) return result
    }
  }
  return result
}

type Tube = NonNullable<Awaited<ReturnType<typeof getAuthedInnertube>>>

interface PlaylistPage {
  items?: unknown[]
  contents?: unknown[]
  has_continuation?: boolean
  getContinuation?: () => Promise<unknown>
}

async function fetchPlaylistTracks(yt: Tube, id: string, cap = 1000): Promise<MusicTrack[]> {
  const tracks: MusicTrack[] = []
  let page = (await yt.music.getPlaylist(id)) as unknown as PlaylistPage
  for (let fetches = 0; fetches < 25; fetches++) {
    for (const item of (page.items ?? page.contents ?? []).slice(0, cap - tracks.length)) {
      const track = toTrack(item)
      if (track) tracks.push(track)
      if (tracks.length >= cap) break
    }
    if (tracks.length >= cap) break
    if (!page.has_continuation || typeof page.getContinuation !== 'function') break
    try {
      page = (await page.getContinuation()) as PlaylistPage
    } catch (err) {
      logger.warn({ err }, '[music] playlist continuation failed')
      break
    }
  }
  return tracks
}

async function readLibrary(yt: Tube) {
  let lib: { contents?: { items?: unknown[]; contents?: unknown[] }[] }
  try {
    lib = (await yt.music.getLibrary()) as unknown as {
      contents?: { items?: unknown[]; contents?: unknown[] }[]
    }
  } catch (err) {
    if (!isParserVariantError(err)) throw err
    logger.warn('[music] library landing hit a layout variant, falling back to Liked playlist')
    try {
      return { tracks: await fetchPlaylistTracks(yt, 'LM'), playlists: [] as MusicPlaylist[] }
    } catch (fallbackErr) {
      logger.warn({ err: fallbackErr }, '[music] liked playlist fallback failed')
      return { tracks: [] as MusicTrack[], playlists: [] as MusicPlaylist[] }
    }
  }
  const gridItems: unknown[] = []
  for (const section of lib.contents ?? []) {
    gridItems.push(...(section.items ?? section.contents ?? []))
  }
  const playlists: MusicPlaylist[] = []
  const seen = new Set<string>()
  for (const item of gridItems) {
    const n = item as Record<string, unknown>
    const id =
      (typeof n['playlist_id'] === 'string' && (n['playlist_id'] as string)) ||
      (typeof n['playlistId'] === 'string' && (n['playlistId'] as string)) ||
      (typeof n['id'] === 'string' && (n['id'] as string)) ||
      ''
    const title = textOf(n['title'])
    const subtitle = textOf(n['subtitle'])
    if (!id || !title || seen.has(id)) continue
    if (!/playlist|mix/i.test(subtitle) && title !== 'Liked Music') continue
    seen.add(id)
    playlists.push({
      id,
      title,
      subtitle: subtitle || undefined,
      thumbnails: thumbsOf(n['thumbnails'] ?? n['thumbnail']),
    })
  }
  const tracks: MusicTrack[] = []
  const liked = playlists.find((p) => p.title === 'Liked Music')
  if (liked) {
    try {
      tracks.push(...(await fetchPlaylistTracks(yt, liked.id)))
    } catch (err) {
      logger.warn({ err }, '[music] liked playlist fetch failed')
    }
  }
  return { tracks, playlists }
}

const cache = new Map<string, { value: unknown; until: number }>()

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() > hit.until) {
    cache.delete(key)
    return undefined
  }
  return hit.value as T
}

function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
  cache.set(key, { value, until: Date.now() + ttlSeconds * 1000 })
}

export class MusicError extends Error {
  constructor(
    message: string,
    readonly code = 'BAD_REQUEST'
  ) {
    super(message)
  }
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

function requireId(input: Record<string, unknown>): string {
  const id = str(input, 'id').trim()
  if (!id) throw new MusicError('id is required')
  return id
}

export type Handler = (input: Record<string, unknown>) => Promise<unknown>

export const musicHandlers: Record<string, Handler> = {
  authStatus: async () => getMusicAuthStatus(),

  trackById: async (input) => {
    const id = str(input, 'id').trim()
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new MusicError('Enter a valid YouTube video ID.')
    const yt = await getInnertube()
    const info = await yt.music.getInfo(id)
    const basic = (info as { basic_info?: Record<string, unknown> }).basic_info ?? {}
    if (basic['id'] !== id || !basic['title'])
      throw new MusicError('Could not find that YouTube Music track.')
    const duration = Number(basic['duration']) || 0
    return {
      tracks: [
        {
          id,
          title: String(basic['title']),
          artists: String(basic['author'] ?? ''),
          duration: duration
            ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`
            : undefined,
          thumbnails: thumbsOf(basic['thumbnail']),
        } satisfies MusicTrack,
      ],
    }
  },

  authStart: async (input) => {
    let cookie = str(input, 'cookie').trim()
    if (!cookie) throw new MusicError('Cookie is required')
    cookie = cookie
      .replace(/^cookie\s*:\s*/i, '')
      .replace(/^["']+|["']+$/g, '')
      .trim()
    if (cookie.includes('…') || cookie.includes('...')) {
      throw new MusicError(
        `Cookie looks truncated (${cookie.length} chars). In DevTools, right-click the Cookie header then Copy value.`
      )
    }
    if (!cookie.includes('SID') && !cookie.includes('SAPISID')) {
      throw new MusicError(
        'That does not look like a YouTube cookie. Copy the full Cookie request header from music.youtube.com in DevTools > Network.'
      )
    }
    try {
      await saveMusicCookie(cookie)
      const yt = await getAuthedInnertube()
      if (yt) {
        try {
          const lib = await readLibrary(yt)
          return { success: true, tracks: lib.tracks.length, playlists: lib.playlists.length }
        } catch {
          // ignore
        }
      }
      return { success: true, tracks: 0, playlists: 0 }
    } catch (err) {
      logger.error({ err }, '[music] cookie sign-in failed')
      throw new MusicError('Cookie rejected by YouTube Music.', 'UNAUTHORIZED')
    }
  },

  authSignOut: async () => {
    await clearMusicCookie()
    return { success: true }
  },

  search: async (input) => {
    const q = str(input, 'q').trim()
    if (!q) return { tracks: [] as MusicTrack[] }
    const key = `music-search-${q.toLowerCase()}`
    const cached = cacheGet<MusicTrack[]>(key)
    if (cached) return { tracks: cached }
    try {
      const authed = await getAuthedInnertube().catch(() => null)
      const yt = authed ?? (await getInnertube())
      const result = await yt.music.search(q, { type: 'song' })
      const tracks: MusicTrack[] = []
      for (const section of (result as YtPanel).contents ?? []) {
        const items = (section as YtPanel).contents ?? [section]
        for (const item of items) {
          const track = toTrack(item)
          if (track) tracks.push(track)
          if (tracks.length >= 25) break
        }
        if (tracks.length >= 25) break
      }
      if (tracks.length > 0) cacheSet(key, tracks, 300)
      return { tracks }
    } catch (err) {
      logger.error({ err }, '[music] search failed')
      return { tracks: [] as MusicTrack[] }
    }
  },

  playlist: async (input) => {
    const id = requireId(input)
    const yt = await getAuthedInnertube().catch(() => null)
    if (!yt) throw new MusicError('MUSIC_AUTH_REQUIRED', 'UNAUTHORIZED')
    try {
      return { tracks: await fetchPlaylistTracks(yt, id) }
    } catch (err) {
      logger.warn({ err }, '[music] playlist failed, retrying with a fresh session')
      const fresh = await refreshAuthedInnertube()
      if (!fresh) return { tracks: [] as MusicTrack[] }
      try {
        return { tracks: await fetchPlaylistTracks(fresh, id) }
      } catch (retryErr) {
        logger.warn({ err: retryErr }, '[music] playlist retry failed, returning empty')
        return { tracks: [] as MusicTrack[] }
      }
    }
  },

  library: async () => {
    const yt = await getAuthedInnertube().catch(() => null)
    if (!yt) throw new MusicError('MUSIC_AUTH_REQUIRED', 'UNAUTHORIZED')
    try {
      const first = await readLibrary(yt)
      if (first.tracks.length > 0 || first.playlists.length > 0) return first
      logger.warn('[music] library came back empty, retrying with a fresh session')
    } catch (err) {
      logger.warn({ err }, '[music] library failed, retrying with a fresh session')
    }
    const fresh = await refreshAuthedInnertube()
    if (!fresh) return { tracks: [] as MusicTrack[], playlists: [] as MusicPlaylist[] }
    try {
      return await readLibrary(fresh)
    } catch (err) {
      logger.warn({ err }, '[music] library retry failed, returning empty')
      return { tracks: [] as MusicTrack[], playlists: [] as MusicPlaylist[] }
    }
  },

  upnext: async (input) => {
    const id = requireId(input)
    const authed = await getAuthedInnertube().catch(() => null)
    if (!authed) {
      const key = `music-upnext-${id.toLowerCase()}`
      const cached = cacheGet<{ tracks: MusicTrack[]; playlistId: string | null }>(key)
      if (cached) return cached
      try {
        const yt = await getInnertube()
        const payload = parseUpnext(await yt.music.getUpNext(id), false)
        cacheSet(key, payload, 300)
        return payload
      } catch (err) {
        logger.error({ err }, '[music] upnext failed')
        return { tracks: [] as MusicTrack[], playlistId: null as string | null }
      }
    }
    try {
      return parseUpnext(await authed.music.getUpNext(id), true)
    } catch (err) {
      logger.warn({ err }, '[music] authed upnext failed, retrying with a fresh session')
    }
    const fresh = await refreshAuthedInnertube()
    if (fresh) {
      try {
        return parseUpnext(await fresh.music.getUpNext(id), true)
      } catch (retryErr) {
        logger.warn({ err: retryErr }, '[music] upnext retry failed, falling back to public')
      }
    }
    try {
      const yt = await getInnertube()
      return parseUpnext(await yt.music.getUpNext(id), false)
    } catch (err) {
      logger.error({ err }, '[music] upnext failed')
      return { tracks: [] as MusicTrack[], playlistId: null as string | null }
    }
  },

  likes: async () => {
    const yt = await getAuthedInnertube().catch(() => null)
    if (!yt) throw new MusicError('MUSIC_AUTH_REQUIRED', 'UNAUTHORIZED')
    const key = 'music-liked-ids'
    const cached = cacheGet<string[]>(key)
    if (cached) return { likedIds: cached }
    const fetchLikedIds = async (session: Tube): Promise<string[]> =>
      (await fetchPlaylistTracks(session, 'LM')).map((t) => t.id)
    try {
      const likedIds = await fetchLikedIds(yt)
      cacheSet(key, likedIds, 120)
      return { likedIds }
    } catch (err) {
      logger.warn({ err }, '[music] liked ids failed, retrying with a fresh session')
      const fresh = await refreshAuthedInnertube()
      if (!fresh) return { likedIds: [] as string[] }
      try {
        const likedIds = await fetchLikedIds(fresh)
        cacheSet(key, likedIds, 120)
        return { likedIds }
      } catch (retryErr) {
        logger.warn({ err: retryErr }, '[music] liked ids retry failed, returning empty')
        return { likedIds: [] as string[] }
      }
    }
  },

  like: async (input) => {
    const id = str(input, 'id').trim()
    const like = input['like'] === true || input['like'] === 'true'
    if (!id) throw new MusicError('id is required')
    const yt = await getAuthedInnertube().catch(() => null)
    if (!yt) throw new MusicError('MUSIC_AUTH_REQUIRED', 'UNAUTHORIZED')
    if (!(await verifyMusicSession())) throw new MusicError('MUSIC_AUTH_REQUIRED', 'UNAUTHORIZED')

    const attempt = async (session: Tube): Promise<void> => {
      const shaped = session as YtSessionActions
      const actions = shaped.actions ?? shaped.session?.actions
      if (!actions) throw new Error('Actions unavailable')
      let endpoint: MenuEndpoint | null = null
      let signedOut = false
      for (const item of ((await session.music.getUpNext(id)) as YtPanel).contents ?? []) {
        const toggle = findLikeToggle(item, id)
        const picked = like ? toggle.like : toggle.unlike
        if (isSignInPrompt(picked)) {
          signedOut = true
          continue
        }
        if (picked) {
          endpoint = picked
          break
        }
      }
      if (signedOut && !endpoint) throw new Error('MUSIC_SESSION_EXPIRED')
      if (!endpoint) throw new Error('Like toggle not found for track')
      await endpoint.call(actions)
    }

    try {
      await attempt(yt)
    } catch (err) {
      if ((err as Error).message === 'MUSIC_SESSION_EXPIRED') {
        throw new MusicError('MUSIC_AUTH_REQUIRED', 'UNAUTHORIZED')
      }
      logger.warn({ err }, '[music] rate failed, retrying with a fresh session')
      const fresh = await refreshAuthedInnertube()
      if (!fresh) throw new MusicError('Like action failed', 'INTERNAL_SERVER_ERROR')
      try {
        await attempt(fresh)
      } catch (retryErr) {
        if ((retryErr as Error).message === 'MUSIC_SESSION_EXPIRED') {
          throw new MusicError('MUSIC_AUTH_REQUIRED', 'UNAUTHORIZED')
        }
        logger.error({ err: retryErr }, '[music] rate retry failed')
        throw new MusicError('Like action failed', 'INTERNAL_SERVER_ERROR')
      }
    }
    cache.delete('music-liked-ids')
    logger.info(`[music] rate id=${id} liked=${like} via=toggle`)
    return { success: true, liked: like }
  },
}
