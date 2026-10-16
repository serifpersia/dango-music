import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dev = argv.includes('dev')
const portArg = argv.find((a) => a.startsWith('--port='))

if (portArg) process.env.DANGO_MUSIC_PORT = portArg.slice('--port='.length)

const kids = []

const run = (entry, args) => {
  const child = spawn(process.execPath, [path.join(root, entry), ...args], {
    cwd: root,
    stdio: 'inherit',
  })
  kids.push(child)
  child.on('exit', (code) => stop(code ?? 0))
  return child
}

const done = (entry, args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, entry), ...args], {
      cwd: root,
      stdio: 'inherit',
    })
    child.on('exit', resolve)
  })

function stop(code = 0) {
  for (const child of kids) child.kill()
  process.exit(code)
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())

const esbuildArgs = [
  'electron/main.ts',
  '--bundle',
  '--platform=node',
  '--target=node22',
  '--format=esm',
  '--packages=external',
  '--external:electron',
  '--outfile=dist-electron/main.js',
]

if (dev) {
  run('node_modules/vite/bin/vite.js', [])
  run('node_modules/electron/cli.js', ['.', '--dev'])
} else {
  if (!existsSync(path.join(root, 'dist-electron', 'main.js'))) {
    const code = await done('node_modules/esbuild/bin/esbuild', esbuildArgs)
    if (code) stop(code)
  }
  if (!existsSync(path.join(root, 'dist', 'index.html'))) {
    const code = await done('node_modules/vite/bin/vite.js', ['build'])
    if (code) stop(code)
  }
  run('node_modules/electron/cli.js', ['.'])
}
