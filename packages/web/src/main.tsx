import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import './styles.css'
import { App } from './App'
import { LocaleProvider } from './i18n'

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <App />
  </LocaleProvider>,
)
