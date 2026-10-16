import http from 'node:http'
import logger from './lib/logger.js'
import { musicHandlers } from './lib/music.js'
import { radioHandlers } from './lib/radio.js'
import { discordHandlers } from './lib/discord.js'
import { streamAudio } from './lib/audio.js'

type Handler = (input: Record<string, unknown>) => Promise<unknown>

const ROUTES: Record<string, Record<string, Handler>> = {
  music: musicHandlers,
  radio: radioHandlers,
  discord: discordHandlers,
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readInput(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const raw = url.searchParams.get('input')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return (parsed['0'] as Record<string, unknown>) ?? {}
  } catch {
    return {}
  }
}

export function startServer(port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    void handle(req, res)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      logger.info(`[server] listening on ${describe(server)}`)
      resolve(server)
    })
  })
}

export function describe(server: http.Server): string {
  const address = server.address()
  return typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : 'unknown'
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  if (url.pathname === '/api/music/audio') {
    const videoId = (url.searchParams.get('videoId') || url.searchParams.get('id') || '').trim()
    if (!videoId) {
      sendJson(res, 400, { error: 'videoId is required' })
      return
    }
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    const result = await streamAudio({
      videoId,
      range: req.headers.range ?? null,
      signal: controller.signal,
    })
    res.writeHead(result.status, { ...CORS, ...result.headers })
    res.end(result.body ?? undefined)
    return
  }

  if (url.pathname.startsWith('/api/trpc/')) {
    const path = url.pathname.slice('/api/trpc/'.length)
    const dot = path.indexOf('.')
    const router = dot === -1 ? '' : path.slice(0, dot)
    const name = dot === -1 ? path : path.slice(dot + 1)
    const handler = ROUTES[router]?.[name]
    if (!handler) {
      sendJson(res, 404, [{ error: { json: { message: `No procedure "${path}"` } } }])
      return
    }
    try {
      const data = await handler(await readInput(req))
      sendJson(res, 200, [{ result: { data: data ?? null } }])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ err }, `[server] ${path} failed`)
      sendJson(res, 200, [{ error: { json: { message, code: -32603 } } }])
    }
    return
  }

  if (url.pathname === '/api/auth/app-status') {
    sendJson(res, 200, { hasPassword: false, isAuthenticated: true, port: null })
    return
  }

  sendJson(res, 404, { error: 'Not found' })
}
