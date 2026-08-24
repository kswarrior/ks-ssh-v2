import { useEffect, useState } from 'react'
import { useApp } from '../stores/appStore'
import { api, humanSize } from '../lib/api'
import { Dropdown, Modal } from './ui'
import FilesPanel from './FilesPanel'
import EditorPane from './EditorPane'
import PortsPanel from './PortsPanel'
import TunnelsPanel from './TunnelsPanel'
import OpsPanels from './OpsPanels'
import SnippetsPanel from './SnippetsPanel'
import AuditPanel from './AuditPanel'
import { useTransferList } from './transferCenter'

function TransferPop() {
  const [show, setShow] = useState(false)
  const items = useTransferList()
  useEffect(() => {
    if (items.some(i => i.status === 'active')) setShow(true)
  }, [items])
  return show && items.length ? (
    <div className="transfer-pop">
      <div className="row small muted" style={{ marginBottom: 4, justifyContent: 'space-between' }}>
        <span>transfers</span>
        <button className="ghost" onClick={() => setShow(false)}>✕</button>
      </div>
      {items.map(it => (
        <div key={it.id} className="tr-row">
          <div className="row small" style={{ justifyContent: 'space-between' }}>
            <span>{it.name}</span>
            <span className="muted">{it.note ?? it.status}</span>
            {it.status === 'active' && it.cancel && (
              <button className="ghost danger" title="abort"
                onClick={() => it.cancel!()}>■</button>
            )}
          </div>
          <div className="bar-track"><div className={`bar-fill ${it.status === 'error' ? 'err' : ''}`}
            style={{ width: `${it.pct}%` }} /></div>
        </div>
      ))}
    </div>
  ) : null
}

export default function RightBar() {
  const { rightTab, setRightTab, activeHostId, hosts } = useApp()
  const [editorBridge] = useState(() => ({ openRef: { current: null } }))
  const host = hosts.find(h => h.id === activeHostId)

  const tabs = [
    ['files', 'FILES'],
    ['ports', 'PORTS'],
    ['tunnels', 'TUNNELS'],
    ['ops', 'OPS'],
    ['snippets', 'SNIPPETS'],
    ['audit', 'AUDIT'],
  ] as const

  return (
    <aside className="rightbar">
      <div className="rightbar-tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={rightTab === id ? 'active' : ''}
            onClick={() => setRightTab(id as any)}>{label}</button>
        ))}
        <button className="ghost only-mobile" title="close panel"
          onClick={() => useApp.getState().setRightOpen(false)}>✕</button>
      </div>
      <div className="rightbar-body">
        {!activeHostId && <div style={{ padding: 14 }} className="muted">select a host</div>}
        {activeHostId && rightTab === 'files' && (
          <>
            <div className="row small muted" style={{ padding: '6px 8px', justifyContent: 'space-between' }}>
              <span>{host?.name}</span>
              <Dropdown align="right" button={<button className="ghost icon-btn" style={{ width: 20, height: 20 }}>⧉</button>}
                items={[{ label: 'Open editor pane', onClick: () =>
                  window.dispatchEvent(new CustomEvent('ks-open-editor')) }]} />
            </div>
            <FilesPanelWithEditor hostId={activeHostId} bridge={editorBridge} />
          </>
        )}
        {activeHostId && rightTab === 'ports' && <PortsPanel hostId={activeHostId} />}
        {activeHostId && rightTab === 'tunnels' && <TunnelsPanel hostId={activeHostId} />}
        {activeHostId && rightTab === 'ops' && <OpsPanels hostId={activeHostId} />}
        {activeHostId && rightTab === 'snippets' && <SnippetsPanel hostId={activeHostId} />}
        {rightTab === 'audit' && <AuditPanel />}
      </div>
      <TransferPop />
    </aside>
  )
}

// Files panel + hidden editor workspace toggled from OPS tab or event.
function FilesPanelWithEditor({ hostId, bridge }: {
  hostId: number
  bridge: { openRef: React.MutableRefObject<((p: string) => void) | null> }
}) {
  const [editorOn, setEditorOn] = useState(false)
  useEffect(() => {
    const onOpen = () => setEditorOn(true)
    const h = (e: Event) => { onOpen(); void e }
    window.addEventListener('ks-open-editor', h)
    return () => window.removeEventListener('ks-open-editor', h)
  }, [])
  return (
    <>
      {editorOn ? (
        <EditorPane hostId={hostId} bridge={bridge} />
      ) : (
        <FilesPanel hostId={hostId} onOpenInEditor={p => {
          bridge.openRef.current?.(p)
          setEditorOn(true)
        }} />
      )}
    </>
  )
}

export { humanSize }
