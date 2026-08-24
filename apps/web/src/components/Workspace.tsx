import { useCallback, useEffect, useRef } from 'react'
import { useApp } from '../stores/appStore'
import { useTerm, type PaneKind, type TermTab } from '../stores/termStore'
import TerminalPane from './TerminalPane'
import { api } from '../lib/api'

export default function Workspace() {
  const { activeHostId, notify, statuses, setRightTab } = useApp()
  const term = useTerm()

  // hot-exit: rebuild tabs from persisted layout, then re-attach live
  // server-side sessions (plan §2.11 session restore).
  useEffect(() => {
    if (!activeHostId) return
    term.restoreLayout(activeHostId)
    if (term.hostTabs(activeHostId).length === 0) {
      const pid = term.openTab(activeHostId)
      void pid
      return
    }
    api<any[]>(`/api/hosts/${activeHostId}/sessions`)
      .then(list => {
        const ids = list.map(s => s.sessionId as string)
        if (ids.length) term.restoreForHost(activeHostId, ids)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHostId])

  if (!activeHostId) {
    return (
      <main className="workspace" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="muted">add a host and double-click to connect</div>
      </main>
    )
  }

  const connected = !!statuses[activeHostId]?.connected
  const tabs = term.hostTabs(activeHostId)
  const active = tabs.find(t => t.id === term.activeTabId) ?? tabs[0] ?? null

  function openNew(kind: PaneKind) {
    if (kind !== 'term' && !connected) {
      notify({ level: 'warn', title: 'host offline', body: 'connect first' })
      setRightTab('files')
      return
    }
    term.openTab(activeHostId!, undefined, kind)
  }

  return (
    <main className="workspace">
      <div className="ws-tabs">
        {tabs.map(t => (
          <div key={t.id}
            className={`tab ${t.id === active?.id ? 'active' : ''}`}
            onClick={() => term.setActive(t.id)}
            onDoubleClick={() => {
              const title = prompt('rename tab', t.title)
              if (title) term.renameActive(activeHostId, title)
            }}>
            <span>{iconFor(t)} {t.title}</span>
            <span className="x"
              onClick={e => {
                e.stopPropagation()
                t.panes.forEach(p => term.closePane(activeHostId, p))
              }}>✕</span>
          </div>
        ))}
        <span className="row" style={{ gap: 2 }}>
          <button className="ghost" title="new terminal tab"
            onClick={() => openNew('term')}>＋⌨</button>
          <button className="ghost" title="file manager tab" disabled={!connected}
            onClick={() => openNew('files')}>＋📁</button>
          <button className="ghost" title="ports tab" disabled={!connected}
            onClick={() => openNew('ports')}>＋🔌</button>
        </span>
      </div>
      <div className={`ws-body ${useApp.getState().settings.zenMode === '1' ? 'zen' : ''}`}>
        {active && <SplitHost hostId={activeHostId} tab={active} />}
      </div>
    </main>
  )
}

function iconFor(t: TermTab): string {
  const st = useTerm.getState()
  const kinds = t.panes.map(p => st.panes[p]?.kind ?? 'term')
  if (kinds.every(k => k === 'term')) return '⌨'
  return '▦'
}

function SplitHost({ hostId, tab }: { hostId: number; tab: TermTab }) {
  const term = useTerm()
  const dragRef = useRef<HTMLDivElement>(null)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const parent = dragRef.current?.parentElement as HTMLElement
      const rect = parent.getBoundingClientRect()
      const move = (ev: MouseEvent) => {
        const ratio =
          tab.split?.dir === 'down'
            ? (ev.clientY - rect.top) / rect.height
            : (ev.clientX - rect.left) / rect.width
        term.setRatio(tab.id, Math.min(0.85, Math.max(0.15, ratio)))
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [tab.id, tab.split?.dir, term]
  )

  const renderPane = (paneId: string) => {
    const kind = term.panes[paneId]?.kind ?? 'term'
    switch (kind) {
      case 'files':
        return <CenterFiles hostId={hostId} />
      case 'ports':
        return <CenterPorts hostId={hostId} />
      default:
        return <TerminalPane hostId={hostId} paneId={paneId} key={paneId} />
    }
  }

  if (tab.split && tab.panes.length === 2) {
    const dir = tab.split.dir
    const r = Math.round(tab.split.ratio * 10000) / 100
    return (
      <div className={dir === 'right' ? 'split-h' : 'split-v'}>
        <div style={{ flexBasis: `${r}%`, display: 'flex' }}>{renderPane(tab.panes[0])}</div>
        <div ref={dragRef} className={dir === 'right' ? 'divider-h' : 'divider-v'}
          onMouseDown={onMouseDown} />
        <div style={{ flex: 1, display: 'flex' }}>{renderPane(tab.panes[1])}</div>
      </div>
    )
  }
  return renderPane(tab.panes[0])
}

function CenterFiles({ hostId }: { hostId: number }) {
  const { LazyFiles } = useLazyPanels()
  return (
    <Suspense fallback={<Loading />}>
      {LazyFiles ? <LazyFiles hostId={hostId} compact /> : <Loading />}
    </Suspense>
  )
}

function CenterPorts({ hostId }: { hostId: number }) {
  const { LazyPorts } = useLazyPanels()
  return (
    <Suspense fallback={<Loading />}>
      {LazyPorts ? <LazyPorts hostId={hostId} /> : <Loading />}
    </Suspense>
  )
}

function Loading() {
  return <div style={{ padding: 16 }} className="muted">loading…</div>
}

import { lazy, Suspense, useState } from 'react'

function useLazyPanels() {
  const [LazyFiles] = useState(() => lazy(() => import('./FilesPanel')))
  const [LazyPorts] = useState(() => lazy(() => import('./PortsPanel')))
  return { LazyFiles, LazyPorts }
}

// split controls exposed for the palette
export function splitActive(dir: 'right' | 'down', kind?: PaneKind) {
  const st = useTerm.getState()
  const active = st.activeTab()
  if (!active || active.split) return
  const app = useApp.getState()
  if (!app.activeHostId) return
  if (kind && kind !== 'term' && !app.statuses[app.activeHostId]?.connected) {
    app.notify({ level: 'warn', title: 'host offline', body: 'connect first' })
    return
  }
  st.splitPane(app.activeHostId, active.panes[0], dir, kind)
}
