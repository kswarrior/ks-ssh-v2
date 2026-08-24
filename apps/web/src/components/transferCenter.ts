import { useSyncExternalStore } from 'react'

// TransferCenter: registry of active uploads/downloads with cancel support.
// Retry = re-run; server resumes from .part checkpoint automatically.
export interface Trk {
  id: string
  name: string
  pct: number
  status: 'active' | 'done' | 'error' | 'canceled'
  note?: string
  cancel?: () => void
}

const listeners = new Set<() => void>()
const items = new Map<string, Trk>()

function emit() {
  listeners.forEach(fn => fn())
}

export const transfers = {
  upsert(t: Trk) {
    items.set(t.id, t)
    emit()
  },
  remove(id: string) {
    items.delete(id)
    emit()
  },
  all(): Trk[] {
    return [...items.values()]
  },
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  snapshot(): Trk[] {
    return [...items.values()].sort((a, b) => a.id.localeCompare(b.id))
  },
}

export function useTransferList(): Trk[] {
  return useSyncExternalStore(transfers.subscribe, transfers.snapshot, transfers.snapshot)
}
