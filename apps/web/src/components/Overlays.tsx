import { useEffect, useRef, useState } from 'react'
import { useApp } from '../stores/appStore'
import { api } from '../lib/api'
import { Modal } from './ui'
import { MonitorOverlay, SystemInfoModal } from './MonitorOverlay'

export default function Overlays() {
  const { overlay, setOverlay, activeHostId } = useApp()
  if (!overlay) return null

  return (
    <>
      {overlay === 'monitor' && activeHostId && (
        <MonitorOverlay hostId={activeHostId} onClose={() => setOverlay(null)} />
      )}
      {overlay === 'sysinfo' && activeHostId && (
        <SystemInfoModal hostId={activeHostId} onClose={() => setOverlay(null)} />
      )}
      {overlay === 'settings' && <SettingsPage onClose={() => setOverlay(null)} />}
      {overlay === 'search' && <GlobalSearchModal onClose={() => setOverlay(null)} />}
    </>
  )
}

// ---- Settings ----

function SettingsPage({ onClose }: { onClose: () => void }) {
  const { settings, saveSettings, notify } = useApp()
  const [draft, setDraft] = useState<Record<string, string>>({ ...useApp.getState().settings })
  const [users, setUsers] = useState<any[]>([])
  const [knownHosts, setKnownHosts] = useState<any[]>([])

  useEffect(() => {
    api<any[]>('/api/users').then(setUsers).catch(() => {})
    api<any[]>('/api/known-hosts').then(setKnownHosts).catch(() => {})
  }, [])

  async function save() {
    await saveSettings(draft)
    notify({ level: 'info', title: 'settings saved' })
  }

  async function setup2FA() {
    try {
      const r = await api<{ secret: string; uri: string }>('/api/auth/2fa/setup', { method: 'POST' })
      const code = prompt(
        `Add this secret to your authenticator app:\n${r.secret}\n\n${r.uri}\n\nEnter the 6-digit code to enable:`)
      if (!code) return
      await api('/api/auth/2fa/enable', { method: 'POST', body: { code } })
      notify({ level: 'info', title: '2FA enabled' })
      const me = await api<{ user: any }>('/api/auth/me')
      useApp.getState().setAuth(me.user)
    } catch (e: any) {
      notify({ level: 'error', title: '2FA', body: e.message })
    }
  }

  return (
    <Modal title="Settings" onClose={onClose} width={640}
      footer={<>
        <button onClick={onClose}>Close</button>
        <button className="primary" onClick={save}>Save</button>
      </>}>
      <div className="form-grid">
        <h4 style={{ margin: 0 }}>Appearance</h4>
        <div className="row">
          <label className="row small">theme
            <select value={draft.theme ?? 'dark'}
              onChange={e => setDraft({ ...draft, theme: e.target.value })}>
              <option value="dark">dark</option>
              <option value="light">light</option>
            </select></label>
          <label className="row small">accent
            <input type="color" style={{ width: 40, height: 28 }}
              value={draft.accentColor ?? '#3b82f6'}
              onChange={e => setDraft({ ...draft, accentColor: e.target.value })} /></label>
          <label className="row small">font size
            <input type="number" min={9} max={24} style={{ width: 56 }}
              value={draft.fontSize ?? '14'}
              onChange={e => setDraft({ ...draft, fontSize: e.target.value })} /></label>
        </div>

        <h4 style={{ margin: 0 }}>Behaviour</h4>
        <label className="row small">
          <input type="checkbox" checked={(draft.keyBarDefault ?? 'true') === 'true'}
            onChange={e => setDraft({ ...draft, keyBarDefault: String(e.target.checked) })} />
          key bar visible by default on new terminals
        </label>
        <label className="row small">
          <input type="checkbox" checked={(draft.autoSaveEditor ?? 'false') === 'true'}
            onChange={e => setDraft({ ...draft, autoSaveEditor: String(e.target.checked) })} />
          editor auto-save
        </label>
        <label className="row small">
          <input type="checkbox" checked={(draft.recordingEnabled ?? 'false') === 'true'}
            onChange={e => setDraft({ ...draft, recordingEnabled: String(e.target.checked) })} />
          record terminal sessions (asciicast)
        </label>
        <label className="row small">editor backups kept per file:
          <input type="number" min={1} max={100} style={{ width: 56 }}
            value={draft.keepBackupVersions ?? '10'}
            onChange={e => setDraft({ ...draft, keepBackupVersions: e.target.value })} />
        </label>

        <h4 style={{ margin: 0 }}>Security — account & teams</h4>
        <div className="row">
          <button className="small" onClick={setup2FA}>Set up / enable 2FA (TOTP)</button>
          <span className="muted small">
            {useApp.getState().user?.totpEnabled ? '✓ enabled' : 'disabled'}
          </span>
        </div>
        <table className="data">
          <thead><tr><th>user</th><th>role</th><th>2FA</th><th /></tr></thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>
                  <select defaultValue={u.role} disabled={u.username === useApp.getState().user?.username}
                    onChange={e => api(`/api/users/${u.id}`, {
                      method: 'PATCH', body: { role: e.target.value },
                    }).then(() => notify({ level: 'info', title: 'role updated' }))}>
                    <option value="admin">admin</option>
                    <option value="operator">operator</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
                <td>{u.totpEnabled ? '✓' : '—'}</td>
                <td><button className="ghost danger small" onClick={() => {
                  if (confirm(`delete user ${u.username}?`))
                    api(`/api/users/${u.id}`, { method: 'DELETE' }).then(() =>
                      api<any[]>('/api/users').then(setUsers))
                }}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="small" onClick={async () => {
          const un = prompt('new username:')
          if (!un) return
          const pw = prompt('password (≥8 chars):')
          if (!pw) return
          try {
            await api('/api/users', { method: 'POST', body: { username: un, password: pw, role: 'viewer' } })
            api<any[]>('/api/users').then(setUsers)
          } catch (e: any) { notify({ level: 'error', title: 'create user', body: e.message }) }
        }}>＋ add user</button>

        <h4 style={{ margin: 0 }}>Known hosts</h4>
        <table className="data">
          <thead><tr><th>host</th><th>key type</th><th>fingerprint</th><th /></tr></thead>
          <tbody>
            {knownHosts.map((k: any) => (
              <tr key={`${k.hostname}-${k.port}-${k.keyType}`}>
                <td>{k.hostname}:{k.port}</td>
                <td>{k.keyType}</td>
                <td className="mono prewrap">{String(k.fingerprint).slice(0, 44)}</td>
                <td><button className="ghost danger small" onClick={() => {
                  if (confirm(`remove known-host entry for ${k.hostname}:${k.port}?`)) {
                    api(`/api/known-hosts/${encodeURIComponent(k.hostname)}/${k.port}`,
                      { method: 'DELETE' }).then(() => api('/api/known-hosts').then(setKnownHosts as any))
                  }
                }}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}

// ---- Global search & replace across remote project (server-side grep) ----

function GlobalSearchModal({ onClose }: { onClose: () => void }) {
  const [root, setRoot] = useState('/')
  const [query, setQuery] = useState('')
  const [replace, setReplace] = useState('')
  const [caseSensitive, setCase] = useState(false)
  const [hits, setHits] = useState<Array<{ path: string; line: number; text: string }>>([])
  const [busy, setBusy] = useState(false)
  const hostId = useApp(s => s.activeHostId)
  const { notify } = useApp()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  async function run(doReplace: boolean) {
    if (!hostId || !query.trim()) return
    if (doReplace &&
      !window.confirm(`Replace "${query}" with "${replace}" under ${root}?`)) return
    setBusy(true)
    try {
      if (doReplace) {
        const r = await api<{ filesChanged: number }>('/api/search', {
          method: 'POST',
          body: { hostId, root, query, replace, doReplace: true, caseSensitive },
        })
        notify({ level: 'info', title: `replaced in ${r.filesChanged} files` })
      }
      setHits(await api<any[]>('/api/search', {
        method: 'POST',
        body: { hostId, root, query, caseSensitive },
      }))
    } catch (e: any) {
      notify({ level: 'error', title: 'search failed', body: e.message })
    }
    setBusy(false)
  }

  return (
    <Modal title="Global search & replace" onClose={onClose} width={760}>
      <div className="form-grid">
        <div className="row">
          <span className="muted small">in</span>
          <input style={{ width: 200 }} value={root}
            onChange={e => setRoot(e.target.value)} placeholder="/srv/project" />
          <input ref={inputRef} style={{ flex: 1 }} value={query}
            onKeyDown={e => e.key === 'Enter' && run(false)}
            onChange={e => setQuery(e.target.value)} placeholder="regex…" autoFocus />
          <label className="row small"><input type="checkbox"
            checked={caseSensitive} onChange={e => setCase(e.target.checked)} />aA</label>
          <button className="primary small" disabled={busy} onClick={() => run(false)}>Find</button>
        </div>
        <div className="row">
          <span className="muted small">replace with</span>
          <input style={{ flex: 1 }} value={replace} onChange={e => setReplace(e.target.value)} />
          <button className="danger small" disabled={busy || !hits.length}
            onClick={() => run(true)}>Replace all</button>
        </div>
        <div className="scroll-y" style={{ maxHeight: 320 }}>
          {hits.length > 0 && (
            <table className="data">
              <tbody>
                {hits.map(h => (
                  <tr key={`${h.path}:${h.line}`}>
                    <td className="muted mono">{h.path}:{h.line}</td>
                    <td className="prewrap">{h.text.slice(0, 160)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!hits.length && !busy && (
            <div className="muted small">results appear here — grep runs server-side over SSH</div>
          )}
        </div>
      </div>
    </Modal>
  )
}
