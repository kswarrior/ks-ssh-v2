import { installRelayShim } from './relay-shim.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './App.css'
import App from './App.tsx'

// Relay Visit mode (CF `/v/TOKEN` iframe or srcDoc): tunnel /api/* + /v1/shell
// over WSS to the CLI agent. Local `--port` mode: no token → no-op.
try {
  installRelayShim()
} catch {
  // Native fetch/WebSocket stay in place — local UI unaffected.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
