import React, { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'

export function Modal(props: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  width?: number
}) {
  return (
    <div className="overlay-bg" onMouseDown={e => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" style={props.width ? { minWidth: props.width } : undefined}>
        <div className="modal-hd">
          <span>{props.title}</span>
          <button className="ghost" onClick={props.onClose}>✕</button>
        </div>
        <div className="modal-bd">{props.children}</div>
        {props.footer && <div className="modal-ft">{props.footer}</div>}
      </div>
    </div>
  )
}

export function Dropdown({
  button,
  items,
  align = 'left',
}: {
  button: React.ReactNode
  items: Array<{ label: string; onClick: () => void; danger?: boolean } | 'sep'>
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <span onClick={() => setOpen(o => !o)}>{button}</span>
      {open && (
        <div className="dropdown" style={align === 'right' ? { right: 0 } : { left: 0 }}>
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={i} className="dd-sep" />
            ) : (
              <button
                key={i}
                className="dd-item"
                style={it.danger ? { color: 'var(--err)' } : undefined}
                onClick={() => {
                  setOpen(false)
                  it.onClick()
                }}
              >
                {it.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}

export function Confirm(props: {
  title: string
  body: string
  danger?: boolean
  onYes: () => void
  onClose: () => void
}) {
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button onClick={props.onClose}>Cancel</button>
          <button
            className={props.danger ? 'danger' : 'primary'}
            onClick={() => {
              props.onYes()
              props.onClose()
            }}
          >
            Confirm
          </button>
        </>
      }
    >
      <div className="prewrap">{props.body}</div>
    </Modal>
  )
}

export function Field(props: {
  label: string
  children: React.ReactNode
}) {
  return <label>{props.label}{props.children}</label>
}

export async function tryApi<T>(
  fn: () => Promise<T>,
  notify: (n: { level?: 'info' | 'warn' | 'error'; title: string; body?: string }) => void,
  okTitle?: string
): Promise<T | null> {
  try {
    const r = await fn()
    if (okTitle) notify({ level: 'info', title: okTitle })
    return r
  } catch (e: any) {
    notify({ level: 'error', title: 'request failed', body: String(e?.message ?? e) })
    return null
  }
}

export { api }
