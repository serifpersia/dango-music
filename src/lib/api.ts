const fromQuery = new URLSearchParams(location.search).get('server')

export const DANGO_SERVER = (
  fromQuery ??
  import.meta.env.VITE_DANGO_SERVER ??
  'http://localhost:3000'
).replace(/\/+$/, '')

export function dangoUrl(path: string): string {
  return `${DANGO_SERVER}${path}`
}
