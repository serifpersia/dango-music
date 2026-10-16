import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
} from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer, describe } from './server.js'
import { discordRPCService } from './lib/discord-rpc.js'
import { CONFIG } from './lib/config.js'
import logger from './lib/logger.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEV = process.argv.includes('--dev')
const DEV_URL = 'http://localhost:5173'
const WIDTH = 460
const FULL = 520
const COMPACT = 220
const TOP = 24
const FADE_MS = 60
const RETRY_MS = 1000
const MAX_RETRIES = 30

let win: BrowserWindow | null = null
let tray: Tray | null = null
let fade: NodeJS.Timeout | null = null
let revealed = false
let retries = 0
let apiBase = ''

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

function loadPage(): void {
  if (!win) return
  if (DEV) win.loadURL(`${DEV_URL}?server=${apiBase}`)
  else win.loadFile(path.join(here, '..', 'dist', 'index.html'), { search: `server=${apiBase}` })
}

function syncTray(): void {
  if (!tray || !win) return
  const visible = win.getOpacity() >= 0.5
  tray.setToolTip(
    visible ? 'Dango Music — click to hide (Ctrl+R)' : 'Dango Music hidden — click to show (Ctrl+R)'
  )
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show', click: () => setOpacity(1) },
      { label: 'Hide', click: () => setOpacity(0) },
      { type: 'separator' },
      { label: 'Quit Dango Music', click: () => app.quit() },
    ])
  )
}

function setOpacity(target: number): void {
  if (!win) return
  if (fade) clearInterval(fade)
  const from = win.getOpacity()
  if (target > 0) win.setIgnoreMouseEvents(false)
  let step = 0
  const steps = Math.max(1, Math.round(FADE_MS / 16))
  fade = setInterval(() => {
    step += 1
    win?.setOpacity(from + (target - from) * (step / steps))
    if (step < steps) return
    if (fade) clearInterval(fade)
    fade = null
    win?.setOpacity(target)
    if (target === 0) win?.setIgnoreMouseEvents(true)
    win?.webContents.send('overlay:visible', target > 0)
  }, 16)
  syncTray()
}

function place(height: number): void {
  win?.setContentSize(WIDTH, height)
}

function recenter(): void {
  if (!win) return
  const { width } = screen.getPrimaryDisplay().workAreaSize
  win.setPosition(Math.round((width - WIDTH) / 2), TOP)
}

async function listen(): Promise<string> {
  for (let port = CONFIG.PORT; port < CONFIG.PORT + 20; port++) {
    try {
      return describe(await startServer(port))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    }
  }
  throw new Error(`no free port in ${CONFIG.PORT}..${CONFIG.PORT + 19}`)
}

async function boot(): Promise<void> {
  Menu.setApplicationMenu(null)

  apiBase = await listen()
  logger.info(`[main] renderer will talk to ${apiBase}`)

  await discordRPCService.setEnabled(true)
  logger.info(
    `[main] discord clientId=${CONFIG.DISCORD_CLIENT_ID ? 'set' : 'MISSING'} enabled=${discordRPCService.isServiceEnabled}`
  )

  const icon = nativeImage
    .createFromPath(path.join(here, '..', 'public', 'icon.ico'))
    .resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.on('click', () => setOpacity(win && win.getOpacity() < 0.5 ? 1 : 0))
  syncTray()

  win = new BrowserWindow({
    width: WIDTH,
    height: FULL,
    show: true,
    transparent: true,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(here, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setOpacity(0)
  win.setIgnoreMouseEvents(true)
  place(FULL)
  recenter()

  loadPage()
  win.webContents.on('did-finish-load', () => {
    if (!revealed) {
      revealed = true
      setOpacity(1)
    }
  })
  win.webContents.on('console-message', (_e, level, message) =>
    console.log(`[overlay:${level}] ${message}`)
  )
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[overlay] load failed ${code} ${desc}`)
    if (DEV && ++retries <= MAX_RETRIES) setTimeout(loadPage, RETRY_MS)
  })
  win.webContents.on('render-process-gone', (_e, details) =>
    console.error(`[overlay] renderer gone: ${details.reason}`)
  )

  globalShortcut.register('CommandOrControl+R', () =>
    setOpacity(win && win.getOpacity() < 0.5 ? 1 : 0)
  )
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit())
}

app
  .whenReady()
  .then(boot)
  .catch((err) => {
    logger.error({ err }, '[main] boot failed')
  })

app.on('second-instance', () => setOpacity(1))
app.on('window-all-closed', () => app.quit())

ipcMain.on('overlay:hide', () => setOpacity(0))
ipcMain.on('overlay:compact', (_e, on) => place(on ? COMPACT : FULL))
ipcMain.on('overlay:reset', recenter)
ipcMain.on('overlay:quit', () => app.quit())
