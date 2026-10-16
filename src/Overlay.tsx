import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from './components/Icon'
import {
  useMusicAuthStatus,
  useMusicLibrary,
  useMusicLikedIds,
  useMusicPlaylist,
  useMusicRate,
  useMusicSaveCookie,
  useMusicSearch,
  useMusicUpNext,
} from './hooks/useMusic'
import type { MusicPlaylist, MusicTrack } from './hooks/useMusic'
import {
  songArtist,
  songArt,
  useListenMoe,
  useRadioSearch,
  useRadioStations,
} from './hooks/useRadio'
import type { RadioStation } from './hooks/useRadio'
import { DANGO_SERVER, dangoUrl } from './lib/api'
import { clearDiscordPresence } from './lib/beacon'
import { rpcOnce, useServerStatus } from './lib/rpc'
import { musicCoverUrl } from './lib/thumbs'
import './Overlay.css'

declare global {
  interface Window {
    dangoOverlay?: {
      hide: () => void
      compact: (on: boolean) => void
      reset: () => void
      quit: () => void
      onVisible: (cb: (visible: boolean) => void) => void
    }
  }
}

type Source = 'radio' | 'music'
type Tab = 'search' | 'library' | 'context'
type Action = 'prev' | 'playpause' | 'next' | 'volumeup' | 'volumedown'

type Binding =
  | { kind: 'key'; code: string }
  | { kind: 'button'; index: number }
  | { kind: 'axis'; index: number }

const ACTIONS: Action[] = ['prev', 'playpause', 'next', 'volumeup', 'volumedown']
const ACTION_LABELS: Record<Action, string> = {
  prev: 'Previous',
  playpause: 'Play / Pause',
  next: 'Next',
  volumeup: 'Volume Up',
  volumedown: 'Volume Down',
}
const CAPTURE_MS = 4000

interface PadSnapshot {
  buttons: boolean[]
  axes: number[]
}

function loadBindings(): Partial<Record<Action, Binding>> {
  try {
    return JSON.parse(localStorage.getItem('musicBindings') || '{}')
  } catch {
    return {}
  }
}

function describeBinding(binding?: Binding): string {
  if (!binding) return 'not set'
  if (binding.kind === 'key') return binding.code
  return `${binding.kind} ${binding.index}`
}

function snapshotPads(): PadSnapshot[] {
  return [...(navigator.getGamepads?.() ?? [])]
    .filter((pad): pad is Gamepad => !!pad)
    .map((pad) => ({ buttons: pad.buttons.map((b) => b.pressed), axes: [...pad.axes] }))
}

function firstHit(prev: PadSnapshot[], next: PadSnapshot[]): Binding | null {
  for (let p = 0; p < next.length; p++) {
    const before = prev[p]
    const after = next[p]
    for (let i = 0; i < after.buttons.length; i++) {
      if (after.buttons[i] && !before?.buttons[i]) return { kind: 'button', index: i }
    }
    for (let i = 0; i < after.axes.length; i++) {
      if (Math.abs(before?.axes[i] ?? 0) < 0.35 && Math.abs(after.axes[i]) > 0.6)
        return { kind: 'axis', index: i }
    }
  }
  return null
}

function pressedFlags(): boolean[] {
  return [...(navigator.getGamepads?.() ?? [])]
    .filter((pad): pad is Gamepad => !!pad)
    .flatMap((pad) => pad.buttons.map((b) => b.pressed))
}

const BARS = [0, 1, 2, 3, 4]

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

function shuffled(list: MusicTrack[], from: number): MusicTrack {
  const pool = list.filter((_, i) => i !== from)
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : list[from]
}

function useWheelVolume(adjust: (delta: number) => void, axisIndex?: number, invert = false) {
  const last = useRef(0)
  const invertRef = useRef(invert ? -1 : 1)
  invertRef.current = invert ? -1 : 1
  useEffect(() => {
    let raf = 0
    const tick = () => {
      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad) continue
        let value = 0
        if (axisIndex !== undefined) {
          value = pad.axes[axisIndex] ?? 0
          if (Math.abs(value) < 0.15) {
            last.current = 0
            continue
          }
        } else {
          let peak = 0
          pad.axes.forEach((axis) => {
            if (Math.abs(axis) > peak) {
              peak = Math.abs(axis)
              value = axis
            }
          })
          if (peak < 0.15) {
            last.current = 0
            continue
          }
        }
        const delta = value - last.current
        last.current = value
        if (delta !== 0) adjust(invertRef.current * delta * 0.3)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [adjust, axisIndex])
}

function useGamepadDump(open: boolean) {
  const [pads, setPads] = useState<Gamepad[]>([])
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => {
      setPads([...(navigator.getGamepads?.() ?? [])].filter((pad): pad is Gamepad => !!pad))
    }, 100)
    return () => window.clearInterval(id)
  }, [open])
  return pads
}

export default function Overlay() {
  const [source, setSource] = useState<Source>('radio')
  const [listOpen, setListOpen] = useState(true)
  const [volume, setVolume] = useState(() => {
    const saved = parseFloat(localStorage.getItem('radioVolume') || '')
    return Number.isFinite(saved) ? clamp(saved) : 0.8
  })
  const [playing, setPlaying] = useState(false)
  const [controlsOpen, setControlsOpen] = useState(false)
  const [bindings, setBindings] = useState(loadBindings)
  const [capturing, setCapturing] = useState<Action | null>(null)
  const [shown, setShown] = useState(false)
  const pads = useGamepadDump(controlsOpen)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const sliderRef = useRef<HTMLDivElement | null>(null)
  const lastVolumeRef = useRef(volume)
  const listRef = useRef<HTMLUListElement | null>(null)
  const sessionIdRef = useRef('')
  if (!sessionIdRef.current) {
    sessionIdRef.current =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `music-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  const [station, setStation] = useState<RadioStation | null>(null)
  const [radioQuery, setRadioQuery] = useState('')
  const [radioInput, setRadioInput] = useState('')
  const [radioElapsed, setRadioElapsed] = useState(0)
  const { data: featuredData, isLoading: featuredLoading } = useRadioStations()
  const { data: radioSearchData, isLoading: radioSearching } = useRadioSearch(radioQuery)
  const { nowPlaying } = useListenMoe(station?.gateway)
  const { data: serverUp, isPending: serverPending } = useServerStatus()
  const serverDown = !serverPending && serverUp !== true

  const [track, setTrack] = useState<MusicTrack | null>(null)
  const [queue, setQueue] = useState<MusicTrack[]>([])
  const [tab, setTab] = useState<Tab>('search')
  const [context, setContext] = useState<{
    label: string
    playlist: MusicPlaylist | null
  } | null>(null)
  const [musicQuery, setMusicQuery] = useState('')
  const [musicInput, setMusicInput] = useState('')
  const [cookie, setCookie] = useState('')
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [likeOverride, setLikeOverride] = useState<Record<string, boolean>>({})
  const [shuffle, setShuffle] = useState(() => localStorage.getItem('musicShuffle') === 'true')
  const [autoplay, setAutoplay] = useState(() => localStorage.getItem('musicAutoplay') !== 'false')
  const [invertDial, setInvertDial] = useState(
    () => localStorage.getItem('musicInvertDial') === 'true'
  )

  const { data: auth } = useMusicAuthStatus()
  const saveCookie = useMusicSaveCookie()
  const { data: musicSearchData, isLoading: musicSearching } = useMusicSearch(musicQuery)
  const { data: libraryData, isLoading: libraryLoading } = useMusicLibrary(
    auth?.authenticated === true
  )
  const { data: playlistData, isLoading: playlistLoading } = useMusicPlaylist(
    tab === 'context' && context?.playlist ? context.playlist.id : null
  )
  const { data: upnextData, isLoading: upnextLoading } = useMusicUpNext(track?.id ?? null)
  const { data: likesData } = useMusicLikedIds(auth?.authenticated === true)
  const rate = useMusicRate()

  const radioList = useMemo(
    () => (radioQuery ? radioSearchData?.stations || [] : featuredData?.stations || []),
    [radioQuery, radioSearchData, featuredData]
  )
  const musicResults = useMemo(() => musicSearchData?.tracks || [], [musicSearchData])
  const playlists = useMemo(() => libraryData?.playlists || [], [libraryData])
  const upnextTracks = useMemo(() => upnextData?.tracks || [], [upnextData])
  const liked = useMemo(() => likesData?.likedIds || [], [likesData])
  const isLiked = !!track && (likeOverride[track.id] ?? liked.includes(track.id))

  const onEndedRef = useRef<() => void>(() => {})

  useEffect(() => {
    const audio = new Audio()
    audioRef.current = audio
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onTime = () => setPosition(audio.currentTime)
    const onMeta = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    const onEnd = () => onEndedRef.current()
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('ended', onEnd)
    return () => {
      audio.pause()
      audio.removeAttribute('src')
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('ended', onEnd)
    }
  }, [])

  useEffect(() => {
    window.dangoOverlay?.onVisible(setShown)
  }, [])

  useEffect(() => {
    window.dangoOverlay?.compact(!listOpen)
  }, [listOpen])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  const adjust = useCallback((delta: number) => {
    setVolume((v) => {
      const next = clamp(v + delta)
      localStorage.setItem('radioVolume', String(next))
      return next
    })
  }, [])

  const seekVolume = useCallback(
    (clientX: number) => {
      const box = sliderRef.current?.getBoundingClientRect()
      if (!box) return
      adjust((clientX - box.left) / box.width - volume)
    },
    [adjust, volume]
  )

  const toggleMute = useCallback(() => {
    if (volume > 0) {
      lastVolumeRef.current = volume
      adjust(-volume)
    } else {
      adjust(lastVolumeRef.current - volume)
    }
  }, [volume, adjust])

  useEffect(() => {
    if (!nowPlaying.startTime) {
      setRadioElapsed(0)
      return
    }
    const tick = () =>
      setRadioElapsed(
        Math.max(0, Math.floor((Date.now() - new Date(nowPlaying.startTime!).getTime()) / 1000))
      )
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [nowPlaying.startTime])

  const playUrl = useCallback((url: string) => {
    const audio = audioRef.current
    if (!audio) return
    audio.src = url
    audio.play().catch(() => setPlaying(false))
  }, [])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio?.src) return
    if (audio.paused) audio.play().catch(() => setPlaying(false))
    else audio.pause()
  }, [])

  const playStation = useCallback(
    (next: RadioStation) => {
      setStation(next)
      setRadioElapsed(0)
      playUrl(next.streamUrl)
    },
    [playUrl]
  )

  const stepStation = useCallback(
    (delta: number) => {
      if (!radioList.length) return
      const idx = station ? radioList.findIndex((s) => s.id === station.id) : -1
      playStation(radioList[(idx + delta + radioList.length) % radioList.length])
    },
    [radioList, station, playStation]
  )

  const playTrack = useCallback(
    (
      next: MusicTrack,
      from: MusicTrack[],
      origin?: { label: string; playlist: MusicPlaylist | null }
    ) => {
      setTrack(next)
      setQueue(from.length ? from : [next])
      if (origin) {
        setContext({ label: origin.label, playlist: origin.playlist })
        setTab('context')
      }
      setPosition(0)
      setDuration(0)
      playUrl(dangoUrl(`/api/music/audio?videoId=${encodeURIComponent(next.id)}`))
    },
    [playUrl]
  )

  const extendQueue = useCallback(async () => {
    const anchor = queue[queue.length - 1] ?? track
    if (!anchor) return
    try {
      const data = await rpcOnce<{ tracks: MusicTrack[] }>('music.upnext', { id: anchor.id })
      const known = new Set(queue.map((t) => t.id))
      const fresh = (data.tracks || []).filter((t) => !known.has(t.id))
      if (!fresh.length) return
      const next = [...queue, ...fresh]
      setQueue(next)
      playTrack(fresh[0], next)
    } catch {
      // ignore
    }
  }, [queue, track, playTrack])

  const stepTrack = useCallback(
    (delta: number) => {
      if (!track || !queue.length) return
      const idx = queue.findIndex((t) => t.id === track.id)
      if (delta > 0 && idx >= queue.length - 1) {
        void extendQueue()
        return
      }
      const next =
        shuffle && queue.length > 1
          ? shuffled(queue, idx)
          : queue[(idx + delta + queue.length) % queue.length]
      playTrack(next, queue)
    },
    [track, queue, shuffle, playTrack, extendQueue]
  )
  const runAction = useCallback(
    (action: Action) => {
      if (action === 'volumeup') return adjust(0.05)
      if (action === 'volumedown') return adjust(-0.05)
      if (action === 'prev') {
        if (source === 'music') stepTrack(-1)
        else stepStation(-1)
        return
      }
      if (action === 'next') {
        if (source === 'music') stepTrack(1)
        else stepStation(1)
        return
      }
      toggle()
    },
    [source, toggle, adjust, stepTrack, stepStation]
  )

  const saveBinding = useCallback((action: Action, binding: Binding) => {
    setBindings((prev) => {
      const next = { ...prev, [action]: binding }
      localStorage.setItem('musicBindings', JSON.stringify(next))
      return next
    })
  }, [])

  useWheelVolume(
    adjust,
    bindings.volumeup?.kind === 'axis' ? bindings.volumeup.index : undefined,
    invertDial
  )

  useEffect(() => {
    if (!capturing) return
    let prev = snapshotPads()
    const started = Date.now()
    const id = window.setInterval(() => {
      const next = snapshotPads()
      const hit = firstHit(prev, next)
      prev = next
      if (hit) {
        saveBinding(capturing, hit)
        setCapturing(null)
      } else if (Date.now() - started > CAPTURE_MS) {
        setCapturing(null)
      }
    }, 30)
    return () => window.clearInterval(id)
  }, [capturing, saveBinding])

  useEffect(() => {
    if (!capturing) return
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturing(null)
        return
      }
      saveBinding(capturing, { kind: 'key', code: event.code })
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, saveBinding])

  const hasButtonBindings = ACTIONS.some((action) => bindings[action]?.kind === 'button')
  useEffect(() => {
    if (capturing || !hasButtonBindings) return
    let prev = pressedFlags()
    let raf = 0
    const tick = () => {
      const now = pressedFlags()
      for (const action of ACTIONS) {
        const binding = bindings[action]
        if (binding?.kind !== 'button') continue
        if (now[binding.index] && !prev[binding.index]) runAction(action)
      }
      prev = now
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [bindings, capturing, runAction, adjust, hasButtonBindings])

  const toggleLike = useCallback(() => {
    if (!track || auth?.authenticated !== true) return
    const like = !isLiked
    setLikeOverride((prev) => ({ ...prev, [track.id]: like }))
    rate.mutate(
      { id: track.id, like },
      {
        onError: () =>
          setLikeOverride((prev) => {
            const next = { ...prev }
            delete next[track.id]
            return next
          }),
      }
    )
  }, [track, isLiked, auth, rate])

  onEndedRef.current = () => {
    if (!autoplay || !track) return
    const idx = queue.findIndex((t) => t.id === track.id)
    if (idx >= queue.length - 1) void extendQueue()
    else stepTrack(1)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!shown) return
      if (event.key === 'Escape') {
        window.dangoOverlay?.hide()
        return
      }
      const el = event.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      const mapped = ACTIONS.find(
        (action) =>
          bindings[action]?.kind === 'key' &&
          (bindings[action] as { kind: 'key'; code: string }).code === event.code
      )
      if (mapped) {
        event.preventDefault()
        runAction(mapped)
        return
      }
      if (event.key === ' ') {
        event.preventDefault()
        toggle()
      } else if (event.key === 'ArrowUp') adjust(0.05)
      else if (event.key === 'ArrowDown') adjust(-0.05)
      else if (event.key === 'ArrowRight') {
        if (source === 'music') stepTrack(1)
        else stepStation(1)
      } else if (event.key === 'ArrowLeft') {
        if (source === 'music') stepTrack(-1)
        else stepStation(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [source, toggle, adjust, stepTrack, stepStation, bindings, runAction, shown])

  const song = nowPlaying.song
  const isMusic = source === 'music'
  const title = isMusic
    ? (track?.title ?? 'Nothing playing')
    : (song?.title ?? station?.name ?? 'Nothing playing')
  const byline = isMusic ? (track?.artists ?? '') : song ? songArtist(song) : (station?.tags ?? '')
  const art = isMusic
    ? musicCoverUrl(track?.id, track?.thumbnails) || null
    : (songArt(song) ?? station?.favicon ?? null)
  const total = isMusic ? duration : (song?.duration ?? 0) / 1000
  const at = isMusic ? position : radioElapsed
  const signedIn = auth?.authenticated === true

  const sendPresence = useCallback(
    (isPlaying: boolean) => {
      const sessionId = sessionIdRef.current
      void rpcOnce('discord.heartbeat', { sessionId }).catch(() => {})
      if (isMusic) {
        if (!track) return
        void rpcOnce('discord.musicPresence', {
          title: track.title,
          artistLabel: track.artists,
          isPlaying,
          thumbnail: art || '',
          currentTime: at,
          duration: total,
          sessionId,
        }).catch(() => {})
        return
      }
      if (!station) return
      void rpcOnce('discord.radioPresence', {
        title: song?.title || station.name,
        stationLabel: station.name,
        isPlaying,
        thumbnail: art || '',
        currentTime: radioElapsed,
        sessionId,
      }).catch(() => {})
    },
    [isMusic, track, station, song, art, at, total, radioElapsed]
  )

  const sendPresenceRef = useRef(sendPresence)
  sendPresenceRef.current = sendPresence

  useEffect(() => {
    sendPresenceRef.current(playing)
  }, [playing, isMusic, track?.id, station?.id, title, byline, art])

  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => sendPresenceRef.current(true), 15000)
    return () => window.clearInterval(id)
  }, [playing])

  useEffect(() => {
    const sid = sessionIdRef.current
    const clear = () => clearDiscordPresence(sid)
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') clear()
    }
    window.addEventListener('pagehide', clear)
    window.addEventListener('beforeunload', clear)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', clear)
      window.removeEventListener('beforeunload', clear)
      document.removeEventListener('visibilitychange', onVisibility)
      clear()
    }
  }, [])

  const contextTracks = context?.playlist ? (playlistData?.tracks ?? []) : queue
  const contextLabel = context?.playlist ? context.label : 'Up Next'

  const stopAll = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    setPlaying(false)
    setTrack(null)
    setQueue([])
    setStation(null)
    setContext(null)
    setTab('search')
    setPosition(0)
    setDuration(0)
  }, [])

  const findSimilar = useCallback(() => {
    if (!track) return
    const seen = new Set(queue.map((t) => t.id))
    const fresh = upnextTracks.filter((t) => !seen.has(t.id))
    if (!fresh.length) return
    const next = [track, ...fresh]
    setQueue(next)
    setContext({ label: 'Up Next', playlist: null })
    setTab('context')
    playTrack(fresh[0], next)
  }, [track, queue, upnextTracks, playTrack])

  const list: {
    key: string
    active: boolean
    onClick: () => void
    text: string
    art?: string
  }[] = []

  if (isMusic) {
    if (!signedIn) {
      list.push({
        key: 'hint',
        active: false,
        onClick: () => {},
        text: 'Paste your YouTube Music cookie below to load your library.',
      })
    } else if (tab === 'search') {
      for (const t of musicResults)
        list.push({
          key: t.id,
          active: t.id === track?.id,
          onClick: () => playTrack(t, musicResults, { label: t.title, playlist: null }),
          text: `${t.title} — ${t.artists}`,
          art: musicCoverUrl(t.id, t.thumbnails),
        })
    } else if (tab === 'library') {
      for (const p of playlists)
        list.push({
          key: `p-${p.id}`,
          active: context?.playlist?.id === p.id,
          onClick: () => {
            setContext({ label: p.title, playlist: p })
            setTab('context')
          },
          text: p.subtitle ? `${p.title} — ${p.subtitle}` : p.title,
          art: musicCoverUrl(undefined, p.thumbnails),
        })
    } else {
      for (const t of contextTracks)
        list.push({
          key: `c-${t.id}`,
          active: t.id === track?.id,
          onClick: () =>
            playTrack(t, contextTracks, {
              label: contextLabel,
              playlist: context?.playlist ?? null,
            }),
          text: `${t.title} — ${t.artists}`,
          art: musicCoverUrl(t.id, t.thumbnails),
        })
    }
  } else {
    for (const s of radioList)
      list.push({
        key: s.id,
        active: s.id === station?.id,
        onClick: () => playStation(s),
        text: s.tags ? `${s.name} — ${s.tags}` : s.name,
        art: s.favicon,
      })
  }

  const busy = isMusic
    ? tab === 'search'
      ? musicSearching
      : tab === 'library'
        ? libraryLoading
        : context?.playlist
          ? playlistLoading
          : upnextLoading
    : radioQuery
      ? radioSearching
      : featuredLoading

  useEffect(() => {
    if (!listOpen) return
    listRef.current?.querySelector('.music-station.on')?.scrollIntoView({ block: 'nearest' })
  }, [track?.id, station?.id, listOpen, tab, context, list.length])

  return (
    <div className="music">
      {serverDown && (
        <p className="music-warn" role="status">
          dango is not answering on {DANGO_SERVER || 'this origin'} — start it, then this refreshes.
        </p>
      )}
      <header className="music-head">
        <nav className="music-tabs">
          <button
            className={`music-tab${source === 'radio' ? ' on' : ''}`}
            onClick={() => setSource('radio')}
          >
            Radio
          </button>
          <button
            className={`music-tab${source === 'music' ? ' on' : ''}`}
            onClick={() => setSource('music')}
          >
            YT Music
          </button>
        </nav>
        <div className="music-head-right">
          <button
            className={`music-ghost${controlsOpen ? ' on' : ''}`}
            onClick={() => setControlsOpen(!controlsOpen)}
            title="Controls"
            aria-pressed={controlsOpen}
            aria-label="Controls"
          >
            <Icon name="keyboard" />
          </button>
          {isMusic && (
            <button
              className="music-ghost"
              onClick={findSimilar}
              disabled={!track || upnextTracks.length === 0}
              title="Find similar songs and drop the current queue"
              aria-label="Find similar songs"
            >
              <Icon name="broadcast-tower" />
            </button>
          )}
          {isMusic && (
            <button
              className={`music-ghost${autoplay ? ' on' : ''}`}
              onClick={() =>
                setAutoplay((v) => {
                  localStorage.setItem('musicAutoplay', String(!v))
                  return !v
                })
              }
              aria-pressed={autoplay}
              title="Autoplay next track"
              aria-label="Autoplay"
            >
              <Icon name="redo" />
            </button>
          )}
          {isMusic && (
            <button
              className={`music-ghost${shuffle ? ' on' : ''}`}
              onClick={() =>
                setShuffle((v) => {
                  localStorage.setItem('musicShuffle', String(!v))
                  return !v
                })
              }
              aria-pressed={shuffle}
              title="Shuffle"
              aria-label="Shuffle"
            >
              <Icon name="shuffle" />
            </button>
          )}
          {isMusic && (
            <button
              className={`music-ghost${isLiked ? ' on' : ''}`}
              onClick={toggleLike}
              disabled={!track || !signedIn}
              aria-pressed={isLiked}
              title={isLiked ? 'Remove from Liked Music' : 'Add to Liked Music'}
              aria-label="Like"
            >
              <Icon name="heart" />
            </button>
          )}
          <button
            className="music-ghost"
            onClick={stopAll}
            disabled={!(isMusic ? track : station)}
            title="Stop and clear the queue"
            aria-label="Stop and clear"
          >
            <Icon name="trash" />
          </button>
          <button
            className="music-ghost"
            onClick={() => setListOpen(!listOpen)}
            title={listOpen ? 'Collapse list' : 'Expand list'}
            aria-expanded={listOpen}
            aria-label="Toggle list"
          >
            <Icon name={listOpen ? 'chevron-up' : 'chevron-down'} />
          </button>
          <button
            className="music-ghost"
            onClick={() => window.dangoOverlay?.reset()}
            title="Recentre the overlay"
            aria-label="Recentre overlay"
          >
            <Icon name="home" />
          </button>
          <button
            className="music-ghost"
            onClick={() => window.dangoOverlay?.hide()}
            title="Hide the overlay (Ctrl+R or Esc)"
            aria-label="Hide overlay"
          >
            <Icon name="compress" />
          </button>
          <button
            className="music-ghost"
            onClick={() => window.dangoOverlay?.quit()}
            title="Quit (Ctrl+Shift+Q)"
            aria-label="Quit"
          >
            <Icon name="times" />
          </button>
        </div>
      </header>

      {controlsOpen && (
        <div className="music-pad">
          <div className="music-pad-head">
            <span>Controls</span>
            <button
              className="music-ghost"
              onClick={() => {
                setControlsOpen(false)
                setCapturing(null)
              }}
              aria-label="Close controls"
            >
              <Icon name="times" />
            </button>
          </div>

          {ACTIONS.map((action) => (
            <div key={action} className="music-bind">
              <span className="music-bind-name">{ACTION_LABELS[action]}</span>
              <button
                className={`music-bind-btn${capturing === action ? ' capturing' : ''}`}
                onClick={() => setCapturing(capturing === action ? null : action)}
              >
                {capturing === action ? 'press anything...' : describeBinding(bindings[action])}
              </button>
            </div>
          ))}

          <div className="music-bind">
            <span className="music-bind-name">Invert dial</span>
            <button
              className={`music-bind-btn${invertDial ? ' on' : ''}`}
              onClick={() =>
                setInvertDial((v) => {
                  localStorage.setItem('musicInvertDial', String(!v))
                  return !v
                })
              }
              aria-pressed={invertDial}
            >
              {invertDial ? 'on' : 'off'}
            </button>
          </div>

          <p className="music-pad-note">
            Click a control, then press a wheel button, move an axis, or hit a key. Saved
            automatically.
          </p>

          {pads.length === 0 ? (
            <p className="music-pad-note">
              No gamepad detected. Chromium only lists a device after it sends input - press a
              button on the wheel. The overlay also has to be focused.
            </p>
          ) : (
            pads.map((pad) => (
              <div key={pad.index} className="music-pad-row">
                <p className="music-pad-id">
                  {pad.index}: {pad.id} [{pad.mapping || 'no mapping'}]
                </p>
                <p>
                  axes{' '}
                  {pad.axes.length === 0
                    ? 'none'
                    : pad.axes.map((axis, i) => `${i}=${axis.toFixed(2)}`).join('  ')}
                </p>
                <p>
                  buttons{' '}
                  {pad.buttons.length === 0
                    ? 'none'
                    : pad.buttons.map((b, i) => `${i}${b.pressed ? '*' : ''}`).join(' ')}
                </p>
              </div>
            ))
          )}
        </div>
      )}

      <div className={`music-now${playing ? ' live' : ''}`}>
        {art ? (
          <img className="music-art" src={art} alt="" draggable={false} />
        ) : (
          <span className="music-art music-art-empty">
            <Icon name={isMusic ? 'headphones' : 'broadcast-tower'} />
          </span>
        )}
        <div className="music-now-text">
          <p className="music-track">{title}</p>
          <p className="music-meta">
            {byline}
            {total > 0 && ` · ${formatTime(at)} / ${formatTime(total)}`}
          </p>
          <div
            className={`music-progress${isMusic ? ' seek' : ''}`}
            onClick={
              isMusic
                ? (event) => {
                    const box = event.currentTarget.getBoundingClientRect()
                    const audio = audioRef.current
                    if (audio && duration)
                      audio.currentTime = ((event.clientX - box.left) / box.width) * duration
                  }
                : undefined
            }
            role={isMusic ? 'slider' : undefined}
            aria-label={isMusic ? 'Seek' : undefined}
          >
            <span
              className="music-progress-fill"
              style={{ width: `${total ? (at / total) * 100 : 0}%` }}
            />
            <div className={`music-bars${playing ? ' on' : ''}`} aria-hidden="true">
              {BARS.map((i) => (
                <span key={i} style={{ animationDelay: `${i * 0.11}s` }} />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="music-transport">
        <button
          className="music-btn"
          onClick={() => (isMusic ? stepTrack(-1) : stepStation(-1))}
          disabled={!(isMusic ? track : station)}
        >
          <Icon name="step-backward" />
        </button>
        <button
          className="music-btn music-btn-play"
          onClick={toggle}
          disabled={!(isMusic ? track : station)}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button
          className="music-btn"
          onClick={() => (isMusic ? stepTrack(1) : stepStation(1))}
          disabled={isMusic ? !track : !radioList.length}
        >
          <Icon name="step-forward" />
        </button>
      </div>

      <div className="music-volume">
        <button
          className="music-ghost"
          onClick={toggleMute}
          aria-label={volume === 0 ? 'Unmute' : 'Mute'}
        >
          <Icon name={volume === 0 ? 'volume-mute' : 'volume-down'} />
        </button>
        <div
          className="music-slider"
          ref={sliderRef}
          role="slider"
          tabIndex={0}
          aria-label="Volume"
          aria-valuenow={Math.round(volume * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            seekVolume(event.clientX)
          }}
          onPointerMove={(event) => {
            if (event.buttons === 1) seekVolume(event.clientX)
          }}
        >
          <span className="music-slider-fill" style={{ width: `${volume * 100}%` }} />
          <span className="music-slider-thumb" style={{ left: `${volume * 100}%` }} />
        </div>
      </div>

      {isMusic && (
        <div className="music-views">
          <button
            className={`music-view${tab === 'search' ? ' on' : ''}`}
            onClick={() => setTab('search')}
          >
            Search
          </button>
          <button
            className={`music-view${tab === 'library' ? ' on' : ''}`}
            onClick={() => setTab('library')}
            disabled={!signedIn}
          >
            Library
          </button>
          {context && (
            <span className={`music-view tab${tab === 'context' ? ' on' : ''}`}>
              <button className="music-view-label" onClick={() => setTab('context')}>
                {contextLabel}
              </button>
              <button
                className="music-view-x"
                aria-label="Close tab"
                onClick={() => {
                  setContext(null)
                  setTab('search')
                }}
              >
                <Icon name="times" />
              </button>
            </span>
          )}
        </div>
      )}

      <form
        className="music-search"
        onSubmit={(event) => {
          event.preventDefault()
          if (isMusic) {
            const query = musicInput.trim()
            if (/^[A-Za-z0-9_-]{11}$/.test(query)) {
              void rpcOnce<{ tracks: MusicTrack[] }>('music.trackById', { id: query })
                .then(({ tracks }) => {
                  const directTrack = tracks?.[0]
                  if (directTrack) {
                    setMusicQuery('')
                    playTrack(directTrack, [directTrack], {
                      label: directTrack.title,
                      playlist: null,
                    })
                  } else {
                    setMusicQuery(query)
                  }
                })
                .catch(() => setMusicQuery(query))
            } else {
              setMusicQuery(query)
            }
          } else setRadioQuery(radioInput.trim())
        }}
      >
        <Icon name="search" />
        <input
          value={isMusic ? musicInput : radioInput}
          onChange={(event) =>
            isMusic
              ? setMusicInput(event.currentTarget.value)
              : setRadioInput(event.currentTarget.value)
          }
          placeholder={isMusic ? 'Search YouTube Music' : 'Search stations'}
          aria-label={isMusic ? 'Search YouTube Music' : 'Search radio stations'}
        />
        {(isMusic ? musicQuery : radioQuery) && (
          <button
            type="button"
            className="music-ghost"
            onClick={() => (isMusic ? setMusicQuery('') : setRadioQuery(''))}
          >
            <Icon name="times" />
          </button>
        )}
      </form>

      {!signedIn && isMusic && (
        <form
          className="music-cookie"
          onSubmit={(event) => {
            event.preventDefault()
            saveCookie.mutate({ cookie })
          }}
        >
          <input
            value={cookie}
            onChange={(event) => setCookie(event.currentTarget.value)}
            placeholder="Paste your YouTube Music cookie"
            aria-label="YouTube Music cookie"
          />
          <button type="submit" disabled={!cookie.trim() || saveCookie.isPending}>
            {saveCookie.isPending ? '...' : 'Save'}
          </button>
        </form>
      )}

      {listOpen && (
        <ul className="music-list" ref={listRef}>
          {busy && !list.length && (
            <li className="music-empty">
              <Icon name="spinner" className="music-spin" />
            </li>
          )}
          {!busy && !list.length && <li className="music-empty">Nothing here.</li>}
          {list.map((item) => (
            <li key={item.key}>
              <button className={`music-station${item.active ? ' on' : ''}`} onClick={item.onClick}>
                {item.art ? (
                  <img className="music-thumb" src={item.art} alt="" loading="lazy" />
                ) : (
                  <span className="music-thumb music-thumb-empty">
                    <Icon name={isMusic ? 'headphones' : 'broadcast-tower'} />
                  </span>
                )}
                <span className="music-station-meta">
                  <span className="music-station-name">{item.text}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
