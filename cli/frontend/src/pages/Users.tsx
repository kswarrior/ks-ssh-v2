import { useCallback, useEffect, useState } from 'react'

type Role = 'admin' | 'operator' | 'viewer'

type UserInfo = {
  username: string
  is_owner: boolean
  created_at?: number | null
  role: Role
  totp_enabled: boolean
  oidc: boolean
  locked: boolean
  sessions: number
}

type MeInfo = {
  user: string
  role: Role
  is_owner: boolean
  totp_enabled: boolean
  oidc_enabled: boolean
}

type SessionInfo = {
  id_suffix: string
  created_at: number
  last_seen: number
  age_secs: number
  idle_secs: number
}

type ApiError = Error & { status?: number }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', ...init })
  if (res.status === 401) {
    // Session died — send App back to the login page.
    window.dispatchEvent(
      new CustomEvent('ks-ssh:auth', { detail: { protected: true, authenticated: false } }),
    )
    throw Object.assign(new Error('Session expired — please log in again.'), { status: 401 })
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) {
    const msg =
      (data as { error?: string } | null)?.error || `Request failed (${res.status})`
    throw Object.assign(new Error(msg), { status: res.status })
  }
  return data as T
}

function fmtDate(secs?: number | null): string {
  if (!secs) return ''
  try {
    return new Date(secs * 1000).toLocaleString()
  } catch {
    return ''
  }
}

function fmtDur(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '—'
  if (secs < 60) return `${Math.floor(secs)}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  return `${Math.floor(secs / 86400)}d`
}

/** Client-side mirror of the backend policy (min 12); enforcement is server-side. */
function passwordStrength(pw: string): { score: number; label: string } {
  let score = 0
  if (pw.length >= 12) score += 1
  if (pw.length >= 16) score += 1
  const classes = [
    /[a-z]/.test(pw),
    /[A-Z]/.test(pw),
    /[0-9]/.test(pw),
    /[^A-Za-z0-9]/.test(pw),
  ].filter(Boolean).length
  if (classes >= 3) score += 1
  if (classes >= 4 && pw.length >= 14) score += 1
  score = Math.min(4, score)
  const labels = ['Too weak', 'Weak', 'Okay', 'Good', 'Strong']
  return { score, label: labels[score] ?? '' }
}

function StrengthMeter({ pw }: { pw: string }) {
  if (!pw) return null
  const { score, label } = passwordStrength(pw)
  return (
    <div
      className="pw-meter"
      role="status"
      aria-label={`Password strength: ${label} (${pw.length < 12 ? 'needs 12+ characters' : `${score} of 4`})`}
    >
      <div className="pw-meter-bars" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < score ? 'on' : undefined} data-level={score} />
        ))}
      </div>
      <span className="pw-meter-label">
        {label}
        {pw.length > 0 && pw.length < 12 ? ` — needs ${12 - pw.length} more character(s), min 12` : ''}
      </span>
    </div>
  )
}

const ROLE_HELP: Record<Role, string> = {
  admin: 'Full access: files, kill, chmod, users, audit, recordings.',
  operator: 'Shell + upload/mkdir/edit. No kill, delete, chmod, or user management.',
  viewer: 'Read-only: browse files, watch terminals, play recordings.',
}

export default function UsersPage() {
  const [me, setMe] = useState<MeInfo | null>(null)
  const [users, setUsers] = useState<UserInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [disabled, setDisabled] = useState(false)
  const [forbidden, setForbidden] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [showAdd, setShowAdd] = useState(false)

  const [name, setName] = useState('')
  const [pass, setPass] = useState('')
  const [newRole, setNewRole] = useState<Role>('operator')
  const [show, setShow] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [editing, setEditing] = useState<UserInfo | null>(null)
  const [editName, setEditName] = useState('')
  const [editPass, setEditPass] = useState('')
  const [editRole, setEditRole] = useState<Role>('operator')
  const [editOwnerPass, setEditOwnerPass] = useState('')
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const [deleting, setDeleting] = useState<UserInfo | null>(null)
  const [delOwnerPass, setDelOwnerPass] = useState('')
  const [deletingBusy, setDeletingBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Self-service: change password.
  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState<string | null>(null)

  // Self-service: TOTP.
  const [totpBusy, setTotpBusy] = useState(false)
  const [totpMsg, setTotpMsg] = useState<string | null>(null)
  const [enroll, setEnroll] = useState<{ otpauth_uri: string; secret: string; recovery_codes: string[] } | null>(null)
  const [verifyCode, setVerifyCode] = useState('')
  const [disablePw, setDisablePw] = useState('')

  // Self-service: own sessions.
  const [mySessions, setMySessions] = useState<SessionInfo[] | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    setDisabled(false)
    setForbidden(false)
    try {
      const m = await request<MeInfo>('/api/auth/me', { cache: 'no-store' })
      setMe(m)
    } catch (e) {
      const err = e as ApiError
      if (err.status === 404) {
        setDisabled(true)
        setUsers([])
        return
      }
      if (err.status !== 401) setLoadError(err.message)
      return
    }
    try {
      const s = await request<{ sessions: SessionInfo[] }>('/api/auth/sessions/mine', {
        cache: 'no-store',
      })
      setMySessions(s.sessions ?? [])
    } catch {
      setMySessions(null)
    }
    try {
      const data = await request<{ users: UserInfo[] }>('/api/auth/users', {
        cache: 'no-store',
      })
      setUsers(data.users ?? [])
    } catch (e) {
      const err = e as ApiError
      if (err.status === 404) {
        setDisabled(true)
        setUsers([])
      } else if (err.status === 403) {
        // Non-admin (operator/viewer): user list is admin-only.
        setForbidden(true)
        setUsers([])
      } else if (err.status !== 401) {
        setLoadError(err.message)
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const flash = (msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 5000)
  }

  const openAdd = () => {
    setName('')
    setPass('')
    setNewRole('operator')
    setShow(false)
    setCreateError(null)
    setShowAdd(true)
  }

  const create = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (creating) return
    setCreateError(null)
    setCreating(true)
    try {
      await request('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name.trim(), password: pass, role: newRole }),
      })
      setName('')
      setPass('')
      setShowAdd(false)
      await load()
      flash('User created.')
    } catch (e) {
      setCreateError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const openEdit = (u: UserInfo) => {
    setEditing(u)
    setEditName(u.username)
    setEditPass('')
    setEditRole(u.role)
    setEditOwnerPass('')
    setEditError(null)
  }

  const canSave =
    !!editing &&
    editOwnerPass.length > 0 &&
    (editPass.length > 0 ||
      (!editing.is_owner && editName.trim() !== '' && editName.trim() !== editing.username) ||
      (!editing.is_owner && editRole !== editing.role))

  const saveEdit = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!editing || saving || !canSave) return
    setEditError(null)
    setSaving(true)
    try {
      const body: Record<string, string> = { owner_pass: editOwnerPass }
      if (!editing.is_owner && editName.trim() && editName.trim() !== editing.username) {
        body.new_username = editName.trim()
      }
      if (editPass) body.new_password = editPass
      if (!editing.is_owner && editRole !== editing.role) body.role = editRole
      await request(`/api/auth/users/${encodeURIComponent(editing.username)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setEditing(null)
      await load()
      flash('User updated — their other sessions were revoked.')
    } catch (e) {
      setEditError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const openDelete = (u: UserInfo) => {
    setDeleting(u)
    setDelOwnerPass('')
    setDeleteError(null)
  }

  const confirmDelete = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (!deleting || deletingBusy || !delOwnerPass) return
    setDeleteError(null)
    setDeletingBusy(true)
    try {
      await request(`/api/auth/users/${encodeURIComponent(deleting.username)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner_pass: delOwnerPass }),
      })
      setDeleting(null)
      await load()
      flash('User deleted.')
    } catch (e) {
      setDeleteError((e as Error).message)
    } finally {
      setDeletingBusy(false)
    }
  }

  const unlock = async (u: UserInfo) => {
    try {
      const r = await request<{ cleared: boolean }>(
        `/api/auth/users/${encodeURIComponent(u.username)}/unlock`,
        { method: 'POST' },
      )
      await load()
      flash(r.cleared ? `Lockout cleared for ${u.username}.` : `${u.username} was not locked.`)
    } catch (e) {
      flash((e as Error).message)
    }
  }

  const revoke = async (u: UserInfo) => {
    try {
      const r = await request<{ revoked: number }>(
        `/api/auth/users/${encodeURIComponent(u.username)}/revoke-sessions`,
        { method: 'POST' },
      )
      await load()
      flash(`Revoked ${r.revoked} session(s) for ${u.username}.`)
    } catch (e) {
      flash((e as Error).message)
    }
  }

  const changePassword = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (pwBusy) return
    setPwMsg(null)
    setPwBusy(true)
    try {
      await request('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: curPw, new_password: newPw }),
      })
      setCurPw('')
      setNewPw('')
      setPwMsg('Password changed — your other sessions were logged out.')
    } catch (e) {
      setPwMsg((e as Error).message)
    } finally {
      setPwBusy(false)
    }
  }

  const totpEnroll = async () => {
    if (totpBusy) return
    setTotpMsg(null)
    setTotpBusy(true)
    try {
      const r = await request<{ otpauth_uri: string; secret: string; recovery_codes: string[] }>(
        '/api/auth/totp/enroll',
        { method: 'POST' },
      )
      setEnroll(r)
      setVerifyCode('')
    } catch (e) {
      setTotpMsg((e as Error).message)
    } finally {
      setTotpBusy(false)
    }
  }

  const totpConfirm = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (totpBusy || !verifyCode.trim()) return
    setTotpMsg(null)
    setTotpBusy(true)
    try {
      await request('/api/auth/totp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: verifyCode.trim() }),
      })
      setEnroll(null)
      setVerifyCode('')
      await load()
      setTotpMsg('Two-factor authentication enabled.')
    } catch (e) {
      setTotpMsg((e as Error).message)
    } finally {
      setTotpBusy(false)
    }
  }

  const totpDisable = async (ev: React.FormEvent) => {
    ev.preventDefault()
    if (totpBusy || !disablePw) return
    setTotpMsg(null)
    setTotpBusy(true)
    try {
      await request('/api/auth/totp/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: disablePw }),
      })
      setDisablePw('')
      await load()
      setTotpMsg('Two-factor authentication disabled.')
    } catch (e) {
      setTotpMsg((e as Error).message)
    } finally {
      setTotpBusy(false)
    }
  }

  const closeOnEscape = (close: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }

  return (
    <section className="page settings-page" aria-label="Users">
      <div className="page-head">
        <a className="btn btn-sm" href="#/more">
          ← More
        </a>
        <span style={{ flex: 1 }} />
        {!disabled && !forbidden && (
          <button type="button" className="btn btn-sm btn-primary" onClick={openAdd}>
            + Add
          </button>
        )}
      </div>

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      {disabled ? (
        <div className="card">
          <h2>Login disabled</h2>
          <p className="lead">
            User accounts need the login gate. Restart the server with{' '}
            <code>--user</code> and <code>--pass</code> to manage users here.
          </p>
        </div>
      ) : (
        <>
          {me && (
            <div className="card">
              <h2>
                Signed in as {me.user}{' '}
                <span className="tag">{me.role}</span>
                {me.totp_enabled && <span className="tag tag-main">2FA on</span>}
              </h2>
              <p className="lead">
                {me.is_owner
                  ? 'Main account (from the --user flag, always admin).'
                  : ROLE_HELP[me.role] ?? ''}
              </p>

              <h3>Change my password</h3>
              <p className="lead">Self-service — no main-password gate. Min 12 characters.</p>
              <form className="dialog-form" onSubmit={changePassword}>
                <label className="field">
                  Current password
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={curPw}
                    onChange={(e) => setCurPw(e.target.value)}
                  />
                </label>
                <label className="field">
                  New password
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    placeholder="At least 12 characters"
                  />
                </label>
                <StrengthMeter pw={newPw} />
                <div className="dialog-actions">
                  <button type="submit" className="btn btn-primary" disabled={pwBusy || newPw.length < 12 || !curPw}>
                    {pwBusy ? 'Saving…' : 'Change password'}
                  </button>
                </div>
                {pwMsg && (
                  <p className="login-error" role="status">
                    {pwMsg}
                  </p>
                )}
              </form>

              <h3>Two-factor authentication</h3>
              {me.totp_enabled && !enroll ? (
                <>
                  <p className="lead">2FA is enabled on your account.</p>
                  <form className="dialog-form" onSubmit={totpDisable}>
                    <label className="field">
                      Confirm with your password to disable
                      <input
                        type="password"
                        autoComplete="current-password"
                        required
                        value={disablePw}
                        onChange={(e) => setDisablePw(e.target.value)}
                      />
                    </label>
                    <div className="dialog-actions">
                      <button type="submit" className="btn btn-danger" disabled={totpBusy || !disablePw}>
                        {totpBusy ? 'Working…' : 'Disable 2FA'}
                      </button>
                    </div>
                  </form>
                </>
              ) : (
                <>
                  <p className="lead">
                    Scan the secret below in your authenticator app, then confirm with a
                    current 6-digit code. Save the recovery codes somewhere safe —
                    each works once.
                  </p>
                  {!enroll ? (
                    <div className="dialog-actions">
                      <button type="button" className="btn" onClick={() => void totpEnroll()} disabled={totpBusy}>
                        {totpBusy ? 'Working…' : 'Enroll 2FA'}
                      </button>
                    </div>
                  ) : (
                    <>
                      <p className="lead">
                        Secret: <code>{enroll.secret}</code>
                      </p>
                      <p className="lead">
                        otpauth URI (paste into your app):{' '}
                        <code className="wrap-anywhere">{enroll.otpauth_uri}</code>
                      </p>
                      <p className="lead">
                        Recovery codes (each single-use):{' '}
                        {enroll.recovery_codes.map((c) => (
                          <code key={c} style={{ marginRight: 6 }}>
                            {c}
                          </code>
                        ))}
                      </p>
                      <form className="dialog-form" onSubmit={totpConfirm}>
                        <label className="field">
                          Current 6-digit code
                          <input
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            required
                            autoFocus
                            value={verifyCode}
                            onChange={(e) => setVerifyCode(e.target.value)}
                            placeholder="123456"
                          />
                        </label>
                        <div className="dialog-actions">
                          <button type="submit" className="btn btn-primary" disabled={totpBusy || !verifyCode.trim()}>
                            {totpBusy ? 'Verifying…' : 'Verify & enable'}
                          </button>
                        </div>
                      </form>
                    </>
                  )}
                </>
              )}
              {totpMsg && (
                <p className="login-error" role="status">
                  {totpMsg}
                </p>
              )}

              <h3>My sessions</h3>
              {mySessions === null ? (
                <p className="lead">Loading…</p>
              ) : mySessions.length === 0 ? (
                <p className="lead">No live sessions.</p>
              ) : (
                <ul className="server-list">
                  {mySessions.map((s) => (
                    <li key={s.id_suffix} className="server-row">
                      <div className="server-info">
                        <div className="server-name">…{s.id_suffix}</div>
                        <div className="users-created">
                          age {fmtDur(s.age_secs)} · idle {fmtDur(s.idle_secs)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="card">
            <h2>Accounts{users ? ` (${users.length})` : ''}</h2>
            {forbidden && (
              <p className="lead">
                User management is admin-only — your role ({me?.role}) can use the
                self-service section above. Ask an admin to change roles.
              </p>
            )}
            {loadError && (
              <p className="login-error" role="alert">
                {loadError}{' '}
                <button type="button" className="btn btn-sm" onClick={() => void load()}>
                  Retry
                </button>
              </p>
            )}
            {users === null && !loadError && <p className="lead">Loading…</p>}
            {users && users.length > 0 && (
              <ul className="server-list">
                {users.map((u) => (
                  <li key={u.username} className="server-row">
                    <div className="server-info">
                      <div className="server-name">
                        {u.username}{' '}
                        {u.is_owner && <span className="tag tag-main">Main</span>}
                        <span className="tag">{u.role}</span>
                        {u.totp_enabled && <span className="tag">2FA</span>}
                        {u.oidc && <span className="tag">SSO</span>}
                        {u.locked && <span className="tag offline">Locked</span>}
                      </div>
                      <div className="users-created">
                        {u.is_owner
                          ? 'main account (from the --user flag, always admin)'
                          : u.created_at
                            ? `added ${fmtDate(u.created_at)}`
                            : ''}
                        {u.sessions > 0 ? ` · ${u.sessions} session(s)` : ''}
                        {' · '}
                        {ROLE_HELP[u.role] ?? u.role}
                      </div>
                    </div>
                    <div className="row-actions">
                      <button type="button" className="btn btn-sm" onClick={() => openEdit(u)}>
                        {u.is_owner ? 'Change password' : 'Edit'}
                      </button>
                      {!u.is_owner && (
                        <>
                          {u.locked && (
                            <button type="button" className="btn btn-sm" onClick={() => void unlock(u)}>
                              Unlock
                            </button>
                          )}
                          <button type="button" className="btn btn-sm" onClick={() => void revoke(u)}>
                            Revoke sessions
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => openDelete(u)}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {showAdd && (
        <div
          className="dialog-overlay"
          onClick={() => setShowAdd(false)}
          onKeyDown={closeOnEscape(() => setShowAdd(false))}
        >
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="users-add-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="users-add-title">Add user</h2>
            <p className="lead">
              Admin-only. New accounts default to <code>operator</code>; least
              privilege — pick <code>viewer</code> when read-only is enough.
              Editing or deleting an account needs the main password.
            </p>
            <form className="dialog-form" onSubmit={create}>
              <label className="field">
                Username
                <input
                  type="text"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={32}
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. friend"
                />
              </label>
              <label className="field">
                Password
                <input
                  type={show ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  minLength={12}
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder="At least 12 characters"
                />
              </label>
              <StrengthMeter pw={pass} />
              <label className="field">
                Role
                <select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
                  <option value="viewer">viewer — read-only</option>
                  <option value="operator">operator — shell + upload</option>
                  <option value="admin">admin — everything</option>
                </select>
              </label>
              <p className="lead">{ROLE_HELP[newRole]}</p>
              <label className="field checkbox-row">
                <input
                  type="checkbox"
                  checked={show}
                  onChange={(e) => setShow(e.target.checked)}
                />
                Show password
              </label>
              {createError && (
                <p className="login-error" role="alert">
                  {createError}
                </p>
              )}
              <div className="dialog-actions">
                <button type="button" className="btn" onClick={() => setShowAdd(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating || pass.length < 12}>
                  {creating ? 'Adding…' : 'Add user'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editing && (
        <div
          className="dialog-overlay"
          onClick={() => setEditing(null)}
          onKeyDown={closeOnEscape(() => setEditing(null))}
        >
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="users-edit-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="users-edit-title">
              {editing.is_owner ? 'Change main password' : `Edit ${editing.username}`}
            </h2>
            <p className="lead">
              {editing.is_owner
                ? 'Applies immediately, until restart — update your --pass flag to keep it. Other sessions are logged out. The main account is always admin.'
                : 'Rename, new password (min 12), and/or role. Password/role changes log out their other sessions.'}
            </p>
            <form className="dialog-form" onSubmit={saveEdit}>
              {!editing.is_owner && (
                <>
                  <label className="field">
                    Username
                    <input
                      type="text"
                      required
                      minLength={3}
                      maxLength={32}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    Role
                    <select value={editRole} onChange={(e) => setEditRole(e.target.value as Role)}>
                      <option value="viewer">viewer — read-only</option>
                      <option value="operator">operator — shell + upload</option>
                      <option value="admin">admin — everything</option>
                    </select>
                  </label>
                  <p className="lead">{ROLE_HELP[editRole]}</p>
                </>
              )}
              <label className="field">
                New password
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={editPass}
                  onChange={(e) => setEditPass(e.target.value)}
                  placeholder={editing.is_owner ? 'New main password (min 12)' : 'Blank = keep current (min 12)'}
                />
              </label>
              {editPass && <StrengthMeter pw={editPass} />}
              <label className="field">
                Main password (required)
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                  value={editOwnerPass}
                  onChange={(e) => setEditOwnerPass(e.target.value)}
                  placeholder="Confirm with the main password"
                />
              </label>
              {editError && (
                <p className="login-error" role="alert">
                  {editError}
                </p>
              )}
              <div className="dialog-actions">
                <button type="button" className="btn" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || !canSave || (!!editPass && editPass.length < 12)}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleting && (
        <div
          className="dialog-overlay"
          onClick={() => setDeleting(null)}
          onKeyDown={closeOnEscape(() => setDeleting(null))}
        >
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="users-delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="users-delete-title">Delete {deleting.username}?</h2>
            <p className="lead">
              This account will lose access immediately. This cannot be undone.
            </p>
            <form className="dialog-form" onSubmit={confirmDelete}>
              <label className="field">
                Main password (required)
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                  value={delOwnerPass}
                  onChange={(e) => setDelOwnerPass(e.target.value)}
                  placeholder="Confirm with the main password"
                />
              </label>
              {deleteError && (
                <p className="login-error" role="alert">
                  {deleteError}
                </p>
              )}
              <div className="dialog-actions">
                <button type="button" className="btn" onClick={() => setDeleting(null)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-danger"
                  disabled={deletingBusy || !delOwnerPass}
                >
                  {deletingBusy ? 'Deleting…' : 'Delete user'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  )
}
