import { useEffect, useState } from 'react'
import { useApp, type Host } from '../stores/appStore'
import { api } from '../lib/api'
import { Confirm, Modal, Field, Dropdown } from './ui'

function HostForm(props: {
  initial?: Host | null
  onClose: () => void
}) {
  const { loadHosts, notify } = useApp()
  const [f, setF] = useState({
    name: props.initial?.name ?? '',
    hostname: props.initial?.hostname ?? '',
    port: String(props.initial?.port ?? 22),
    username: props.initial?.username ?? 'root',
    authType: (props.initial?.authType ?? 'password') as Host['authType'],
    password: '',
    privateKey: '',
    passphrase: '',
    labels: (props.initial?.labels ?? []).join(','),
    color: props.initial?.color ?? '#3b82f6',
    jumpHostId: props.initial?.jumpHostId ? String(props.initial.jumpHostId) : '',
    maxSessions: String(props.initial?.maxSessions ?? 10),
    previewEnabled: props.initial?.previewEnabled ?? false,
  })
  const [busy, setBusy] = useState(false)
  const hosts = useApp(s => s.hosts)

  const body = () => ({
    name: f.name,
    hostname: f.hostname,
    port: Number(f.port) || 22,
    username: f.username,
    authType: f.authType,
    ...(f.password ? { password: f.password } : {}),
    ...(f.privateKey ? { privateKey: f.privateKey } : {}),
    ...(f.passphrase ? { passphrase: f.passphrase } : {}),
    labels: f.labels.split(',').map(s => s.trim()).filter(Boolean),
    color: f.color,
    jumpHostId: f.jumpHostId ? Number(f.jumpHostId) : null,
    maxSessions: Number(f.maxSessions) || 10,
    previewEnabled: f.previewEnabled,
  })

  async function test() {
    setBusy(true)
    try {
      const r = await api<any>('/api/hosts/test', { method: 'POST', body: body() })
      if (r.ok) {
        notify({ level: 'info', title: 'connection OK', body: `${r.latencyMs} ms` })
      } else if (r.code === 'unknown_host') {
        notify({
          level: 'warn', title: 'unknown host key',
          body: `fingerprint ${r.fingerprint} — save & connect to accept it`,
        })
      } else if (r.code === 'key_mismatch') {
        notify({
          level: 'error', title: 'HOST KEY MISMATCH',
          body: `stored ${r.storedFingerprint}, got ${r.fingerprint}. Remove old key in Settings → known hosts.`,
        })
      } else {
        notify({ level: 'error', title: 'test failed', body: r.error })
      }
    } catch (e: any) {
      notify({ level: 'error', title: 'test failed', body: e.message })
    }
    setBusy(false)
  }

  async function save() {
    setBusy(true)
    try {
      if (props.initial) {
        await api(`/api/hosts/${props.initial.id}`, { method: 'PUT', body: body() })
      } else {
        await api('/api/hosts', { method: 'POST', body: body() })
      }
      await loadHosts()
      props.onClose()
    } catch (e: any) {
      notify({ level: 'error', title: 'save failed', body: e.message })
    }
    setBusy(false)
  }

  return (
    <Modal title={props.initial ? `Edit ${props.initial.name}` : 'Add host'}
      onClose={props.onClose}
      footer={
        <>
          <button onClick={props.onClose}>Cancel</button>
          <button disabled={busy} onClick={test}>Test connection</button>
          <button className="primary" disabled={busy || !f.name || !f.hostname} onClick={save}>
            Save host
          </button>
        </>
      }>
      <div className="form-grid">
        <Field label="Name">
          <input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} autoFocus />
        </Field>
        <div className="row">
          <Field label="Hostname" >
            <input style={{ width: 210 }} value={f.hostname}
              onChange={e => setF({ ...f, hostname: e.target.value })} />
          </Field>
          <Field label="Port">
            <input style={{ width: 70 }} value={f.port}
              onChange={e => setF({ ...f, port: e.target.value })} />
          </Field>
        </div>
        <div className="row">
          <Field label="Username">
            <input value={f.username} onChange={e => setF({ ...f, username: e.target.value })} />
          </Field>
          <Field label="Auth">
            <select value={f.authType} onChange={e => setF({ ...f, authType: e.target.value as any })}>
              <option value="password">password</option>
              <option value="key">private key</option>
              <option value="key_passphrase">private key + passphrase</option>
              <option value="agent">SSH agent</option>
            </select>
          </Field>
        </div>
        {f.authType === 'password' && (
          <Field label="Password (stored AES-256-GCM encrypted)">
            <input type="password" value={f.password}
              onChange={e => setF({ ...f, password: e.target.value })} />
          </Field>
        )}
        {(f.authType === 'key' || f.authType === 'key_passphrase') && (
          <Field label="Private key (OpenSSH format, encrypted at rest)">
            <textarea rows={4} value={f.privateKey}
              onChange={e => setF({ ...f, privateKey: e.target.value })}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          </Field>
        )}
        {f.authType === 'key_passphrase' && (
          <Field label="Key passphrase">
            <input type="password" value={f.passphrase}
              onChange={e => setF({ ...f, passphrase: e.target.value })} />
          </Field>
        )}
        <div className="row">
          <Field label="Jump host (bastion)">
            <select value={f.jumpHostId}
              onChange={e => setF({ ...f, jumpHostId: e.target.value })}>
              <option value="">— none —</option>
              {hosts.filter(h => h.id !== props.initial?.id).map(h => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Max sessions">
            <input style={{ width: 64 }} value={f.maxSessions}
              onChange={e => setF({ ...f, maxSessions: e.target.value })} />
          </Field>
        </div>
        <div className="row">
          <Field label="Labels (comma-separated)">
            <input value={f.labels} onChange={e => setF({ ...f, labels: e.target.value })} />
          </Field>
          <Field label="Color">
            <input type="color" style={{ width: 44, height: 30, padding: 2 }}
              value={f.color} onChange={e => setF({ ...f, color: e.target.value })} />
          </Field>
        </div>
        <label className="row small muted" style={{ gap: 6 }}>
          <input type="checkbox" checked={f.previewEnabled}
            onChange={e => setF({ ...f, previewEnabled: e.target.checked })} />
          Enable port preview proxy for this host (off by default)
        </label>
      </div>
    </Modal>
  )
}

export default function Sidebar() {
  const { hosts, statuses, activeHostId, setActiveHost, notify, loadHosts } = useApp()
  const [adding, setAdding] = useState<Host | null | undefined>(undefined) // undefined = closed
  const [confirmDel, setConfirmDel] = useState<Host | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    loadHosts()
  }, [loadHosts])

  async function connect(h: Host) {
    setActiveHost(h.id)
    try {
      await api(`/api/hosts/${h.id}/connect`, { method: 'POST' })
      useApp.getState().pollStatuses()
    } catch (e: any) {
      notify({ level: 'error', title: `connect ${h.name}`, body: e.message })
    }
  }

  const visible = hosts.filter(
    h =>
      !filter ||
      h.name.toLowerCase().includes(filter.toLowerCase()) ||
      h.hostname.toLowerCase().includes(filter.toLowerCase()) ||
      h.labels.some(l => l.toLowerCase().includes(filter.toLowerCase()))
  )

  const closeDrawer = () => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      useApp.getState().setDrawerOpen(false)
    }
  }

  return (
    <aside className="sidebar">
      <input placeholder="search…" value={filter} onChange={e => setFilter(e.target.value)} />
      <h3>Hosts</h3>
      {visible.map(h => {
        const st = statuses[h.id]
        return (
          <div
            key={h.id}
            className={`host-row ${h.id === activeHostId ? 'active' : ''}`}
            onClick={() => { setActiveHost(h.id); closeDrawer() }}
            onDoubleClick={() => st?.connected || connect(h)}
          >
            <span className="host-dot" style={{
              background: st?.connected ? 'var(--ok)' : h.color || '#3b82f6',
            }} />
            <span className="host-name">{h.name}</span>
            <Dropdown align="right" button={<button className="ghost icon-btn" style={{ width: 22, height: 22 }}>⋮</button>}
              items={[
                { label: st?.connected ? 'Disconnect' : 'Connect', onClick: () =>
                    st?.connected
                      ? api(`/api/hosts/${h.id}/disconnect`, { method: 'POST' }).then(() => useApp.getState().pollStatuses())
                      : connect(h) },
                { label: 'New terminal', onClick: async () => {
                    await connect(h)
                  } },
                { label: 'Edit…', onClick: () => setAdding(h) },
                { label: 'Delete…', danger: true, onClick: () => setConfirmDel(h) },
              ]} />
          </div>
        )
      })}
      <button className="ghost small" onClick={() => setAdding(null)}>＋ add host</button>
      <button className="ghost small muted" onClick={async () => {
        try {
          const r = await api<any>('/api/hosts/import-ssh-config', { method: 'POST', body: {} })
          notify({ level: 'info', title: `imported ${r.created.length} hosts`, body: `${r.skipped} skipped` })
          loadHosts()
        } catch (e: any) {
          notify({ level: 'error', title: 'import failed', body: e.message })
        }
      }}>⤓ import ~/.ssh/config</button>

      <h3>Tools</h3>
      {(['files', 'ports', 'tunnels', 'ops', 'snippets', 'audit'] as const).map(t => (
        <SidebarNav key={t} tab={t} />
      ))}

      <h3 className="only-mobile">Quick toggles</h3>
      <div className="only-mobile" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <ToggleRow label="🌙 dark / ☀️ light"
          on={useApp.getState().settings.theme !== 'light'}
          onChange={v => useApp.getState().saveSettings({ theme: v ? 'dark' : 'light' })} />
        <ToggleRow label="Zen mode"
          on={useApp.getState().settings.zenMode === '1'}
          onChange={v => useApp.getState().saveSettings({ zenMode: v ? '1' : '0' })} />
        <ToggleRow label="Hide right panel"
          on={useApp.getState().settings.hideRightbar === '1'}
          onChange={v => useApp.getState().saveSettings({ hideRightbar: v ? '1' : '0' })} />
        <ToggleRow label="Key bar by default"
          on={(useApp.getState().settings.keyBarDefault ?? 'true') === 'true'}
          onChange={v => useApp.getState().saveSettings({ keyBarDefault: String(v) })} />
      </div>

      {adding !== undefined && (
        <HostForm initial={adding} onClose={() => setAdding(undefined)} />
      )}
      {confirmDel && (
        <Confirm
          title={`Delete ${confirmDel.name}?`}
          body={`This removes ${confirmDel.username}@${confirmDel.hostname}:${confirmDel.port} and its stored credentials. Sessions will be closed.`}
          danger
          onYes={async () => {
            await api(`/api/hosts/${confirmDel.id}`, { method: 'DELETE' }).catch(e =>
              notify({ level: 'error', title: 'delete failed', body: e.message })
            )
            loadHosts()
          }}
          onClose={() => setConfirmDel(null)}
        />
      )}
    </aside>
  )
}

function SidebarNav({ tab }: { tab: string }) {
  const { rightTab, activeHostId, statuses } = useApp()
  const connected = activeHostId ? !!statuses[activeHostId]?.connected : false
  return (
    <div className={`host-row ${rightTab === tab ? 'active' : ''}`}
      onClick={() => useApp.getState().toggleMobilePanel(tab as any)}>
      <span className="host-dot"
        style={{ background: rightTab === tab ? (connected ? 'var(--ok)' : 'var(--warn)') : 'var(--bg-3)' }} />
      <span className="host-name" style={{ textTransform: 'capitalize' }}>{tab}</span>
    </div>
  )
}

function ToggleRow({ label, on, onChange }: {
  label: string
  on: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="row small" style={{ gap: 8, padding: '2px 8px', cursor: 'pointer' }}>
      <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
