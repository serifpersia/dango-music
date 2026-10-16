const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

const upgrade = (url: string) =>
  /googleusercontent\.com/.test(url)
    ? url.replace(/=w\d+-h\d+(?:-l\d+)?(?:-rj)?$/, '=w544-h544-l90-rj')
    : url

export function musicCoverUrl(id: string | undefined, thumbnails?: { url: string }[]): string {
  const first = thumbnails?.[0]?.url
  if (first) return upgrade(first)
  if (id && VIDEO_ID.test(id)) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
  return ''
}
