import { useCallback, useEffect, useState } from 'react'

type UserInfo = { username: string; is_owner: boolean; created_at?: number | null }

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

export default function UsersPage() {
  const [users, setUsers] = useState<UserInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [disabled, setDisabled] = useState(false)

  const [showAdd, setShowAdd] = useState(false)

  const [name, setName] = useState('')
  const [pass, setPass] = useState('')
  const [show, setShow] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [editing, setEditing] = useState<UserInfo | null>(null)
  const [editName, setEditName] = useState('')
  const [editPass, setEditPass] = useState('')
  const [editOwnerPass, setEditOwnerPass] = useState('')
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const [deleting, setDeleting] = useState<UserInfo | null>(null)
  const [delOwnerPass, setDelOwnerPass] = useState('')
  const [deletingBusy, setDeletingBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    setDisabled(false)
    try {
      const data = await request<{ users: UserInfo[] }>('/api/auth/users', {
        cache: 'no-store',
      })
      setUsers(data.users ?? [])
    } catch (e) {
      const err = e as ApiError
      if (err.status === 404) {
        // Backend runs without --user/--pass.
        setDisabled(true)
        setUsers([])
      } else if (err.status !== 401) {
        setLoadError(err.message)
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openAdd = () => {
    setName('')
    setPass('')
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
        body: JSON.stringify({ username: name.trim(), password: pass }),
      })
      setName('')
      setPass('')
      setShowAdd(false)
      await load()
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
    setEditOwnerPass('')
    setEditError(null)
  }

  const canSave =
    !!editing &&
    editOwnerPass.length > 0 &&
    (editPass.length > 0 ||
      (!editing.is_owner && editName.trim() !== '' && editName.trim() !== editing.username))

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
      await request(`/api/auth/users/${encodeURIComponent(editing.username)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setEditing(null)
      await load()
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
    } catch (e) {
      setDeleteError((e as Error).message)
    } finally {
      setDeletingBusy(false)
    }
  }

  const closeOnEscape = (close: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }

  return (
    <section className="page settings-page" aria-label="Users">
      <div className="page-head">
        <a className="btn btn-sm" href="#/settings">
          ← Settings
        </a>
        <span style={{ flex: 1 }} />
        {!disabled && (
          <button type="button" className="btn btn-sm btn-primary" onClick={openAdd}>
            + Add
          </button>
        )}
      </div>

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
          <div className="card">
            <h2>Accounts{users ? ` (${users.length})` : ''}</h2>
            {loadError && (
              <p className="login-error" role="alert">
                {loadError}{' '}
                <button type="button" className="btn btn-sm" onClick={() => void load()}>
                  Retry
                </button>
              </p>
            )}
            {users === null && !loadError && <p className="lead">Loading…</p>}
            {users && (
              <ul className="server-list">
                {users.map((u) => (
                  <li key={u.username} className="server-row">
                    <div className="server-info">
                      <div className="server-name">
                        {u.username}{' '}
                        {u.is_owner && <span className="tag tag-main">Main</span>}
                      </div>
                      <div className="users-created">
                        {u.is_owner
                          ? 'main account (from the --user flag)'
                          : u.created_at
                            ? `added ${fmtDate(u.created_at)}`
                            : ''}
                      </div>
                    </div>
                    <div className="row-actions">
                      <button type="button" className="btn btn-sm" onClick={() => openEdit(u)}>
                        {u.is_owner ? 'Change password' : 'Edit'}
                      </button>
                      {!u.is_owner && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => openDelete(u)}
                        >
                          Delete
                        </button>
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
              Extra logins for the web UI. Anyone logged in can create users;
              editing or deleting an account needs the main password.
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
                  minLength={4}
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder="At least 4 characters"
                />
              </label>
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
                <button type="submit" className="btn btn-primary" disabled={creating}>
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
                ? 'Applies immediately, until restart — update your --pass flag to keep it. Other sessions are logged out.'
                : 'Rename and/or set a new password. Other sessions of this account are logged out.'}
            </p>
            <form className="dialog-form" onSubmit={saveEdit}>
              {!editing.is_owner && (
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
              )}
              <label className="field">
                New password
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={4}
                  value={editPass}
                  onChange={(e) => setEditPass(e.target.value)}
                  placeholder={editing.is_owner ? 'New main password' : 'Blank = keep current'}
                />
              </label>
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
                  disabled={saving || !canSave}
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
