import { useEffect, useRef, useState } from 'react'
import { useApp } from '../stores/appStore'
import { Logo } from './Login'
import { api } from '../lib/api'

function PingIndicator() {
  const { activeHostId, statuses, setOverlay } = useApp()
  const st = activeHostId ? statuses[activeHostId] : undefined
  const [history, setHistory] = useState<number[]>([])
  const [showSpark, setShowSpark] = useState(false)
  const rtt = st?.connected ? st.rttMs : null

  useEffect(() => {
    if (rtt != null) setHistory(h => [...h.slice(-59), rtt])
  }, [rtt])

  const cls = rtt == null ? 'bad' : rtt < 100 ? 'ok' : rtt <= 300 ? 'mid' : 'bad'
  return (
    <div className={`ping ${cls}`} title={rtt == null ? 'not connected' : `RTT ${rtt} ms`}
      onClick={() => setShowSpark(s => !s)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 12.55a11 11 0 0 1 14.08 0M8.53 16.11a6 6 0 0 1 6.95 0" />
        <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
        <path d="M1.42 9a16 16 0 0 1 21.16 0" opacity={st?.connected ? 1 : 0.25} />
      </svg>
      <span className="ms">{rtt == null ? '—' : `${rtt}ms`}</span>
      {showSpark && history.length > 1 && (
        <svg className="spark" style={{ position: 'fixed', top: 48, left: 90, width: 160, height: 40 }}
          viewBox="0 0 100 30" preserveAspectRatio="none">
          <polyline
            fill="none" stroke="currentColor" strokeWidth="1.4"
            points={history.map((v, i) =>
              `${(i / Math.max(history.length - 1, 1)) * 100},${28 - Math.min(v, 500) / 500 * 26}`
            ).join(' ')}
          />
        </svg>
      )}
    </div>
  )
}

function HostSelector() {
  const { hosts, statuses, activeHostId, setActiveHost } = useApp()
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const cur = hosts.find(h => h.id === activeHostId)
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{ minWidth: 150 }}>
        {cur ? `${cur.name} · ${cur.username}@${cur.hostname}` : 'select host'} ▾
      </button>
      {open && (
        <div className="dropdown" style={{ right: 0, top: '110%', minWidth: 240 }}>
          {hosts.map(h => {
            const st = statuses[h.id]
            return (
              <button key={h.id} className="dd-item row"
                style={{ justifyContent: 'space-between' }}
                onClick={async () => {
                  setActiveHost(h.id)
                  setOpen(false)
                  if (!st?.connected) {
                    try {
                      await api(`/api/hosts/${h.id}/connect`, { method: 'POST' })
                    } catch (e: any) {
                      useApp.getState().notify({
                        level: 'error', title: `connect ${h.name}`, body: e.message,
                      })
                    }
                  }
                }}>
                <span className="row" style={{ gap: 7 }}>
                  <span className="host-dot"
                    style={{ background: h.color || '#3b82f6' }} />
                  <span>{h.name}</span>
                </span>
                <span className={`badge ${st?.connected ? 'ok' : ''}`}>
                  {st?.connected ? '● up' : '○ down'}
                </span>
              </button>
            )
          })}
          {hosts.length === 0 && <div className="dd-item muted">no hosts yet</div>}
        </div>
      )}
    </div>
  )
}

export default function Header() {
  const { user, overlay, setOverlay, notices, markAllRead } = useApp()
  const unread = notices.filter(n => !n.read).length
  const [notifOpen, setNotifOpen] = useState(false)

  return (
    <header className="hdr">
      <button
        className="icon-btn ghost only-mobile"
        title="menu"
        aria-label="menu"
        onClick={() => {
          const st = useApp.getState()
          st.setDrawerOpen(!st.drawerOpen)
          if (!st.drawerOpen) st.setRightOpen(false)
        }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>
      <div className="brand">
        <Logo />
        <div className="titles">
          <div className="title">KS SSH</div>
          <div className="subtitle">KS Warrior</div>
        </div>
      </div>
      <PingIndicator />
      <HostSelector />
      <div className="spacer" />
      <button
        className="icon-btn ghost" title="System info (ⓘ)" disabled={!useApp.getState().activeHostId}
        onClick={() => setOverlay(overlay === 'sysinfo' ? null : 'sysinfo')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      </button>
      <button
        className="icon-btn ghost" title="Resource monitor (📊)" disabled={!useApp.getState().activeHostId}
        onClick={() => setOverlay(overlay === 'monitor' ? null : 'monitor')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 3v18h18" />
          <path d="M7 15l4-6 3 3 5-8" />
        </svg>
      </button>
      <div style={{ position: 'relative' }}>
        <button className="icon-btn ghost" title="Notifications"
          onClick={() => {
            setNotifOpen(o => !o)
            if (!notifOpen) markAllRead()
          }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          {unread > 0 && (
            <span style={{
              position: 'absolute', top: -3, right: -3,
              background: 'var(--err)', color: '#fff',
              borderRadius: 999, fontSize: 9, padding: '1px 4px',
            }}>{unread}</span>
          )}
        </button>
        {notifOpen && (
          <div className="notif-pop" onMouseLeave={() => setNotifOpen(false)}>
            {useApp.getState().notices.length === 0 && (
              <div className="muted small" style={{ padding: 10 }}>no notifications</div>
            )}
            {useApp.getState().notices.slice(0, 20).map(n => (
              <div key={n.id} className={`notif ${n.level}`}>
                <div className="t">{n.title}</div>
                {n.body && <div className="b">{n.body}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
      <button className="icon-btn ghost" title="Settings (⚙)"
        onClick={() => setOverlay(overlay === 'settings' ? null : 'settings')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      <button className="ghost small muted only-desktop" onClick={() => useApp.getState().logout()}>
        {user?.username} ⎋
      </button>
      <button className="icon-btn ghost only-mobile" title="sign out"
        onClick={() => useApp.getState().logout()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
        </svg>
      </button>
    </header>
  )
}
