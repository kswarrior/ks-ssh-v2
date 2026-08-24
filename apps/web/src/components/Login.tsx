import { useState } from 'react'
import { api } from '../lib/api'
import { useApp, type User } from '../stores/appStore'

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="5" fill="var(--bg-3)" />
      <path d="M7 10l6 6-6 6M15 22h10" stroke="currentColor" strokeWidth="2.6" fill="none"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export { Logo }

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [needsTotp, setNeedsTotp] = useState(false)
  const [err, setErr] = useState('')
  const [mode, setMode] = useState<'login' | 'bootstrap'>('login')
  const setAuth = useApp(s => s.setAuth)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    try {
      if (mode === 'bootstrap') {
        await api('/api/auth/bootstrap', {
          method: 'POST',
          body: { username, password },
        })
        setMode('login')
        return
      }
      const r = await api<{ user?: User; needsTotp?: boolean }>('/api/auth/login', {
        method: 'POST',
        body: { username, password, ...(needsTotp ? { totp } : {}) },
      })
      if (r.needsTotp) {
        setNeedsTotp(true)
        return
      }
      if (r.user) setAuth(r.user)
    } catch (e: any) {
      setErr(String(e?.message ?? e))
      // first run? offer bootstrap when no users exist yet
      if (String(e?.message).includes('invalid credentials')) {
        try {
          const h = await api('/api/healthz')
          void h
        } catch { /* ignore */ }
      }
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1><Logo /> KS SSH</h1>
        <div className="muted small">Your servers. One link away.</div>
        <input
          placeholder="username" autoFocus value={username}
          onChange={e => setUsername(e.target.value)}
        />
        <input
          placeholder="password" type="password" value={password}
          onChange={e => setPassword(e.target.value)}
        />
        {needsTotp && (
          <input
            placeholder="2FA code (TOTP)" inputMode="numeric" value={totp}
            onChange={e => setTotp(e.target.value)}
          />
        )}
        <div className="err-text">{err}</div>
        <button className="primary" type="submit">
          {mode === 'bootstrap' ? 'Create admin account' : needsTotp ? 'Verify & sign in' : 'Sign in'}
        </button>
        {mode === 'login' && err.includes('invalid') && (
          <button type="button" className="ghost small muted" onClick={() => setMode('bootstrap')}>
            First run? Create the admin account →
          </button>
        )}
      </form>
    </div>
  )
}
