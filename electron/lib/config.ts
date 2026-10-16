import os from 'node:os'
import path from 'node:path'
import dotenv from 'dotenv'

const ROOT = process.env.DANGO_MUSIC_DATA || path.join(os.homedir(), '.dango-music')

dotenv.config({ path: path.join(ROOT, '.env'), override: true })
dotenv.config({ path: path.join(process.cwd(), '.env'), override: false })

export const CONFIG = {
  ROOT,
  ENV_PATH: path.join(ROOT, '.env'),
  PORT: Number(process.env.DANGO_MUSIC_PORT) || 3000,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || '1560716118350499930',
}
