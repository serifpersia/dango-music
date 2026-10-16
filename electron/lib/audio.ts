import logger from './logger.js'
import { parseUmpResponse, type UmpCarry } from './ump.js'
import { mintPoToken, resetPoTokens } from './potoken.js'
import {
  getInnertube,
  getAuthedInnertube,
  getMusicCookie,
  refreshAuthedInnertube,
  type YtPlayerSession,
  type YtStreamingData,
} from './ytmusic.js'

interface DecipheredAudio {
  url: string
  mimeType?: string
  fetchedAt: number
}

const UPSTREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0'
const audioCache = new Map<string, DecipheredAudio>()
const AUDIO_CACHE_MS = 5 * 60 * 1000

const FIRST_CHUNK = 16384
const AUDIO_CHUNK = 262144
const UMP_CVER = '1.20260920.16.00'

const audioTotalCache = new Map<string, number>()

interface UmpSession {
  cpn: string
  rn: number
  carry: UmpCarry | null
}

const umpSessions = new Map<string, UmpSession>()

function randomCpn(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function getUmpSession(videoId: string): UmpSession {
  let session = umpSessions.get(videoId)
  if (!session) {
    session = { cpn: randomCpn(), rn: 0, carry: null }
    umpSessions.set(videoId, session)
  }
  return session
}

function boundWindow(clientRange: string | null, videoId: string): [number, number] {
  const total = audioTotalCache.get(videoId)
  const clamp = (start: number, end: number): [number, number] => {
    if (total !== undefined) end = Math.min(end, total - 1)
    return [start, Math.max(end, start)]
  }
  const m = /^bytes=(\d+)-(\d*)$/.exec((clientRange ?? '').trim())
  if (m && m[2] !== '') {
    const s = Number(m[1])
    const e = Number(m[2])
    if (e - s + 1 <= AUDIO_CHUNK) return [s, e]
    return clamp(s, s + AUDIO_CHUNK - 1)
  }
  const start = m ? Number(m[1]) : 0
  return clamp(start, start + (start === 0 ? FIRST_CHUNK : AUDIO_CHUNK) - 1)
}

type Tube = Awaited<ReturnType<typeof getInnertube>>

async function decipherWith(yt: Tube, videoId: string): Promise<DecipheredAudio> {
  const info = await yt.music.getInfo(videoId)
  const formats = (info as YtStreamingData).streaming_data?.adaptive_formats ?? []
  const sorted = [...formats]
    .filter((f) => f.has_audio && !f.has_video)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
  const player = (yt.session as YtPlayerSession).player
  for (const fmt of sorted) {
    try {
      const url = await fmt.decipher(player)
      if (url && url.startsWith('http')) {
        const entry: DecipheredAudio = { url, mimeType: fmt.mime_type, fetchedAt: Date.now() }
        audioCache.set(videoId, entry)
        return entry
      }
    } catch {
      // ignore
    }
  }
  throw new Error('No stream available')
}

async function decipherAudio(videoId: string): Promise<DecipheredAudio> {
  const cached = audioCache.get(videoId)
  if (cached && Date.now() - cached.fetchedAt < AUDIO_CACHE_MS) return cached
  const authed = await getAuthedInnertube().catch(() => null)
  if (authed) {
    try {
      return await decipherWith(authed, videoId)
    } catch (err) {
      logger.warn({ err }, '[music] authed stream lookup failed, retrying with a fresh session')
      const fresh = await refreshAuthedInnertube()
      if (fresh) {
        try {
          return await decipherWith(fresh, videoId)
        } catch (retryErr) {
          logger.warn({ err: retryErr }, '[music] refreshed stream lookup failed, using public')
        }
      }
    }
  }
  return decipherWith(await getInnertube(), videoId)
}

export interface AudioRequest {
  videoId: string
  range: string | null
  signal: AbortSignal
}

export type AudioResponse = {
  status: number
  headers: Record<string, string>
  body: Buffer | null
}

export async function streamAudio(req: AudioRequest): Promise<AudioResponse> {
  const { videoId, range, signal } = req
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(30000)])

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt === 1) umpSessions.delete(videoId)
    if (attempt === 2) {
      audioCache.delete(videoId)
      umpSessions.delete(videoId)
      resetPoTokens(videoId)
    }

    let entry: DecipheredAudio
    try {
      entry = await decipherAudio(videoId)
    } catch {
      return json(502, { error: 'No stream available' })
    }

    const clen = /[?&]clen=(\d+)/.exec(entry.url)?.[1]
    if (clen && !audioTotalCache.has(videoId)) audioTotalCache.set(videoId, Number(clen))

    const [rangeStart, rangeEnd] = boundWindow(range, videoId)
    const session = getUmpSession(videoId)
    let pot = ''
    try {
      pot = await mintPoToken(videoId)
    } catch (err) {
      logger.warn({ err }, '[music] PoToken mint failed, trying without attestation')
    }

    const upstreamUrl =
      `${entry.url}&cpn=${session.cpn}&cver=${UMP_CVER}` +
      `&range=${rangeStart}-${rangeEnd}&rn=${session.rn}&rbuf=0` +
      (pot ? `&pot=${encodeURIComponent(pot)}` : '') +
      `&ump=1&srfvp=1`
    session.rn += 1

    let raw: Buffer
    try {
      const cookie = getMusicCookie()
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'User-Agent': UPSTREAM_UA,
          Referer: 'https://music.youtube.com/',
          Origin: 'https://music.youtube.com/',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: 'x\x00',
        signal: timeout,
      })
      if (upstream.status !== 200) {
        try {
          await upstream.body?.cancel()
        } catch {
          // ignore
        }
        continue
      }
      raw = Buffer.from(await upstream.arrayBuffer())
    } catch (err) {
      if (signal.aborted) return { status: 499, headers: {}, body: null }
      logger.error({ err }, '[music] audio upstream failed')
      continue
    }

    const parsed = parseUmpResponse(raw, session.carry)
    session.carry = parsed.carry
    if (parsed.status === 3) {
      logger.warn({ videoId }, '[music] stream protection blocked, refreshing token')
      resetPoTokens(videoId)
      umpSessions.delete(videoId)
      continue
    }
    if (parsed.media.length === 0) continue

    const total = audioTotalCache.get(videoId)
    const headers: Record<string, string> = {
      'Content-Type': entry.mimeType || 'audio/webm',
      'Content-Length': String(parsed.media.length),
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    }
    if (total) {
      headers['Content-Range'] =
        `bytes ${rangeStart}-${rangeStart + parsed.media.length - 1}/${total}`
    }
    return { status: 206, headers, body: parsed.media }
  }

  logger.warn({ videoId }, '[music] audio upstream gave no media after retries')
  return json(502, { error: 'Upstream error' })
}

function json(status: number, body: unknown): AudioResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify(body)),
  }
}
