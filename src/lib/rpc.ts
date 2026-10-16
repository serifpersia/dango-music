import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Query } from '@tanstack/react-query'
import { dangoUrl } from './api'

interface Envelope<T> {
  result?: { data: T }
  error?: { json?: { message?: string } }
}

async function rpc<T>(path: string, input: unknown, signal?: AbortSignal): Promise<T> {
  const query = `batch=1&input=${encodeURIComponent(JSON.stringify({ 0: input ?? {} }))}`
  const res = await fetch(dangoUrl(`/api/trpc/${path}?${query}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  const body = (await res.json()) as Envelope<T>[] | Envelope<T>
  const envelope = Array.isArray(body) ? body[0] : body
  if (envelope?.error) throw new Error(envelope.error.json?.message || `${path} failed`)
  return envelope?.result?.data as T
}

const routerOf = (path: string) => path.split('.')[0]

type Interval<T> = number | false | ((query: Query<T, Error>) => number | false)

export function useRpc<T>(
  path: string,
  input: unknown = {},
  opts: {
    enabled?: boolean
    staleTime?: number
    refetchInterval?: Interval<T>
  } = {}
) {
  return useQuery({
    queryKey: [routerOf(path), path, input],
    queryFn: ({ signal }) => rpc<T>(path, input, signal),
    enabled: opts.enabled,
    staleTime: opts.staleTime,
    refetchInterval: opts.refetchInterval,
    retry: 1,
  })
}

export function useRpcMutation<TData, TVars>(
  path: string,
  onSuccess?: (data: TData, vars: TVars) => void
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: TVars) => rpc<TData>(path, vars),
    onSuccess: (data, vars) => {
      onSuccess?.(data, vars)
      void qc.invalidateQueries({ queryKey: [routerOf(path)] })
    },
  })
}

export function rpcOnce<T>(path: string, input: unknown = {}): Promise<T> {
  return rpc<T>(path, input)
}

export function useServerStatus() {
  return useQuery({
    queryKey: ['app-status'],
    queryFn: async ({ signal }) => {
      const res = await fetch(dangoUrl('/api/auth/app-status'), { signal })
      if (!res.ok) throw new Error(String(res.status))
      return true
    },
    retry: false,
    staleTime: 5000,
    refetchInterval: 10_000,
  })
}
