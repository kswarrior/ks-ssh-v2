import { useEffect, useRef, useState } from 'react'

export default function LoginPage({ onLoggedIn }: { onLoggedIn: (user: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [needTotp, setNeedTotp] = useState(false)
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [ssoEnabled, setSsoEnabled] = useState(false)

  // SSO is optional behind --oidc-issuer/--oidc-client-id; only show the
  // button when the backend reports it enabled.
  useEffect(() => {
    let alive = true
    fetch('/api/auth/status', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive && d && typeof d.oidc_enabled !== 'undefined') {
          setSsoEnabled(!!d.oidc_enabled)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busyRef.current) return
    busyRef.current = true
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({
          username: username.trim(),
          password,
          // 6-digit TOTP code or a single-use recovery code (optional —
          // the backend asks for it with need_totp when 2FA is enabled).
          ...(totp.trim() ? { totp: totp.trim() } : {}),
        }),
      })
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean
        user?: string
        error?: string
        need_totp?: boolean
      } | null
      if (res.ok && data?.ok) {
        onLoggedIn(data.user ?? username.trim())
      } else if (res.status === 401 && data?.need_totp) {
        setNeedTotp(true)
        setError('Two-factor code required — enter the 6-digit code from your authenticator app (or a recovery code).')
      } else if (res.status === 429) {
        setError(data?.error || 'Too many attempts — locked for 5 minutes.')
      } else {
        setError(data?.error || 'Invalid username or password')
      }
    } catch {
      setError('Cannot reach the server — is it still running?')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <div className="app-shell">
      <div className="app-main">
        <header className="app-header">
          <span className="header-brand" aria-label="KS SSH">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <defs>
                <linearGradient id="ks-logo-g-login" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" style={{ stopColor: 'var(--accent-hi)' }} />
                  <stop offset="0.6" style={{ stopColor: 'var(--accent-lo)' }} />
                  <stop offset="1" style={{ stopColor: 'var(--accent-glow)' }} />
                </linearGradient>
              </defs>
              <rect
                x="1"
                y="1"
                width="30"
                height="30"
                rx="8"
                fill="url(#ks-logo-g-login)"
                stroke="rgba(255,255,255,0.25)"
              />
              <path
                d="M10 12l5 4-5 4M17 20h6"
                stroke="#fff"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
            <span className="header-brand-text" aria-hidden="true">
              KS SSH
            </span>
          </span>
        </header>

        <main className="content login-content" id="main">
          <section className="card login-card" aria-labelledby="login-title">
            <div className="login-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                <path d="M12 15v2" />
              </svg>
            </div>
            <h1 id="login-title">Log in</h1>
            <p className="lead">This server is protected — sign in to continue.</p>
            <form className="form login-form" onSubmit={submit}>
              <label className="field">
                Username
                <input
                  type="text"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Username"
                />
              </label>
              <label className="field">
                Password
                <input
                  type={showPass ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password"
                />
              </label>
              <label className="field checkbox-row">
                <input
                  type="checkbox"
                  checked={showPass}
                  onChange={(e) => setShowPass(e.target.checked)}
                />
                Show password
              </label>
              {(needTotp || totp) && (
                <label className="field">
                  Two-factor code
                  <input
                    type="text"
                    name="totp"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    autoFocus={needTotp}
                    required={needTotp}
                    value={totp}
                    onChange={(e) => setTotp(e.target.value)}
                    placeholder="6-digit code or recovery code"
                  />
                </label>
              )}
              {error && (
                <p className="login-error" role="alert">
                  {error}
                </p>
              )}
              <div className="row-actions">
                <button type="submit" className="btn btn-primary login-submit" disabled={busy}>
                  {busy ? 'Signing in…' : 'Log in'}
                </button>
              </div>
              {!needTotp && !totp && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setNeedTotp(true)}
                  title="My account has two-factor authentication enabled"
                >
                  I have a 2FA code
                </button>
              )}
            </form>
            {ssoEnabled && (
              <div className="login-sso">
                <div className="login-sso-sep" aria-hidden="true">
                  or
                </div>
                <a className="btn btn-primary" href="/api/auth/oidc/login">
                  Continue with SSO
                </a>
                <p className="lead">Single sign-on via your identity provider (new accounts start as viewer).</p>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  )
}
