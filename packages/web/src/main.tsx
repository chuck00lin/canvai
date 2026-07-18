import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles.css'
import { App } from './App'
import { LocaleProvider } from './i18n'

// forward uncaught browser errors to the hub's telemetry sink (no-op unless the
// hub was started with --report-url). Rate-limited so a render loop can't flood.
const TOKEN = new URLSearchParams(window.location.search).get('token')
let reported = 0
function reportClientError(message: string, stack: string | undefined, where: string) {
  if (reported >= 20) return // early-testing budget; a loop shouldn't spam
  reported += 1
  void fetch('/api/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ message, stack, where }),
  }).catch(() => {})
}
window.addEventListener('error', (e) => reportClientError(e.message, e.error?.stack, 'window.error'))
window.addEventListener('unhandledrejection', (e) =>
  reportClientError(String(e.reason?.message ?? e.reason), e.reason?.stack, 'unhandledrejection'),
)

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <App />
  </LocaleProvider>,
)
