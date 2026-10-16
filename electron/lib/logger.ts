type Level = 'info' | 'warn' | 'error' | 'debug'

function show(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message
  if (value === null || typeof value !== 'object') return String(value)
  try {
    return JSON.stringify(value, (_key, val) => (val instanceof Error ? val.message : val))
  } catch {
    return '[unserializable]'
  }
}

const emit =
  (level: Level) =>
  (...args: unknown[]): void => {
    const line = `[${level}] ${args.map(show).join(' ')}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

const base = {
  info: emit('info'),
  warn: emit('warn'),
  error: emit('error'),
  debug: emit('debug'),
}

export default { ...base, child: (_bindings?: Record<string, unknown>) => base }
