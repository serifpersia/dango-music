import { render } from 'preact'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Overlay from './Overlay'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
})

const root = document.getElementById('root')
if (root) {
  render(
    <QueryClientProvider client={queryClient}>
      <Overlay />
    </QueryClientProvider>,
    root
  )
}
