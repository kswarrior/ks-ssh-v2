import { create } from 'zustand'

// Terminal workspace state: unlimited tabs, VS Code-style splits,
// layout persisted per host (localStorage + server-side PTY sessions).

export type SplitDir = 'right' | 'down'
export type PaneKind = 'term' | 'files' | 'ports'

export interface Pane {
  id: string // term panes: id === server-side session token
  hostId: number
  title: string
  kind: PaneKind
}

export interface TermTab {
  id: string
  hostId: number
  title: string
  panes: string[]            // pane ids rendered by this tab
  split?: { dir: SplitDir; ratio: number }
}

interface TermState {
  tabs: TermTab[]
  activeTabId: string | null
  panes: Record<string, Pane>

  openTab: (hostId: number, title?: string, kind?: PaneKind) => string
  newPaneId: () => string
  registerPane: (hostId: number, paneId: string, title?: string, kind?: PaneKind) => void
  closePane: (hostId: number, paneId: string) => void
  renameActive: (hostId: number, title: string) => void
  setActive: (tabId: string) => void
  activeTab: () => TermTab | null
  hostTabs: (hostId: number) => TermTab[]
  splitPane: (hostId: number, paneId: string, dir: SplitDir, kind?: PaneKind) => void
  setRatio: (tabId: string, ratio: number) => void
  restoreForHost: (hostId: number, sessionIds: string[]) => void
  restoreLayout: (hostId: number) => void
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`
}

function persist(hostId: number, st: TermState) {
  try {
    const layout = st.hostTabs(hostId).map(t => ({
      id: t.id,
      title: t.title,
      panes: t.panes,
      split: t.split,
      active: t.id === st.activeTabId,
    }))
    localStorage.setItem(`ks-ssh-layout-${hostId}`, JSON.stringify(layout))
  } catch {
    /* private mode */
  }
}

export const useTerm = create<TermState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  panes: {},

  newPaneId() {
    return uid('term')
  },

  registerPane(hostId, paneId, title, kind = 'term') {
    const st = get()
    if (st.tabs.some(t => t.panes.includes(paneId))) return
    const tab: TermTab = {
      id: uid('tab'),
      hostId,
      title: title ?? 'ssh',
      panes: [paneId],
    }
    set(st2 => ({
      panes: { ...st2.panes, [paneId]: { id: paneId, hostId, title: tab.title, kind } },
      tabs: [...st2.tabs, tab],
      activeTabId: tab.id,
    }))
    persist(hostId, get())
  },

  openTab(hostId, title, kind = 'term') {
    const paneId = get().newPaneId()
    const n = get().hostTabs(hostId).length + 1
    const tab: TermTab = {
      id: uid('tab'),
      hostId,
      title: title ?? `${n}: ${kind === 'term' ? 'ssh' : kind}`,
      panes: [paneId],
    }
    set(st => ({
      panes: { ...st.panes, [paneId]: { id: paneId, hostId, title: tab.title, kind } },
      tabs: [...st.tabs, tab],
      activeTabId: tab.id,
    }))
    persist(hostId, get())
    return paneId
  },

  closePane(hostId, paneId) {
    set(st => {
      let tabs = st.tabs
        .map((t): TermTab | null => {
          if (!t.panes.includes(paneId)) return t
          const rest = t.panes.filter(p => p !== paneId)
          return rest.length > 0 ? { ...t, panes: rest, split: undefined } : null
        })
        .filter((t): t is TermTab => t !== null)
      let activeTabId = st.activeTabId
      if (activeTabId && !tabs.some(t => t.id === activeTabId)) {
        activeTabId = tabs.find(t => t.hostId === hostId)?.id ?? tabs[0]?.id ?? null
      }
      return { tabs, activeTabId }
    })
    persist(hostId, get())
  },

  renameActive(hostId, title) {
    set(st => ({
      tabs: st.tabs.map(t => (t.id === st.activeTabId ? { ...t, title } : t)),
    }))
    persist(hostId, get())
  },

  setActive(tabId) {
    set({ activeTabId: tabId })
  },

  activeTab() {
    const st = get()
    return st.tabs.find(t => t.id === st.activeTabId) ?? null
  },

  hostTabs(hostId) {
    return get().tabs.filter(t => t.hostId === hostId)
  },

  splitPane(hostId, paneId, dir, kind = 'term') {
    const newPaneId = get().newPaneId()
    set(st => {
      const tab = st.tabs.find(t => t.id === st.activeTabId)
      const title = kind === 'term' ? 'split' : kind
      return {
        panes: { ...st.panes, [newPaneId]: { id: newPaneId, hostId, title, kind } },
        tabs: st.tabs.map(t =>
          t.id === st.activeTabId && !t.split && t.panes.length === 1 && t.panes[0] === paneId
            ? { ...t, panes: [paneId, newPaneId], split: { dir, ratio: 0.5 } }
            : t
        ),
      }
    })
    persist(hostId, get())
  },

  setRatio(tabId, ratio) {
    set(st => ({
      tabs: st.tabs.map(t =>
        t.id === tabId && t.split ? { ...t, split: { ...t.split, ratio } } : t
      ),
    }))
  },

  restoreForHost(hostId, sessionIds) {
    for (const sid of sessionIds) {
      if (get().tabs.some(t => t.panes.includes(sid))) continue
      const tab: TermTab = {
        id: uid('tab'),
        hostId,
        title: `restored ${sid.slice(-4)}`,
        panes: [sid],
      }
      set(st => ({
        panes: { ...st.panes, [sid]: { id: sid, hostId, title: tab.title, kind: 'term' } },
        tabs: [...st.tabs, tab],
        activeTabId: tab.id,
      }))
    }
    persist(hostId, get())
  },

  // restoreLayout rebuilds tabs from localStorage (hot exit, plan §2.11).
  restoreLayout(hostId) {
    try {
      const raw = localStorage.getItem(`ks-ssh-layout-${hostId}`)
      if (!raw) return
      const layout = JSON.parse(raw) as Array<{
        id: string; title: string; panes: string[]
        split?: { dir: SplitDir; ratio: number }; active?: boolean
      }>
      if (!Array.isArray(layout) || layout.length === 0) return
      set(st => {
        const panes = { ...st.panes }
        const existing = new Set(st.tabs.map(t => t.id))
        for (const lt of layout) {
          if (existing.has(lt.id)) continue
          for (const pid of lt.panes) {
            if (!panes[pid]) {
              panes[pid] = { id: pid, hostId, title: lt.title, kind: 'term' }
            }
          }
          st.tabs.push({ id: lt.id, hostId, title: lt.title, panes: lt.panes, split: lt.split })
        }
        return { panes, tabs: [...st.tabs], activeTabId: undefined as any }
      })
      const act = layout.find(l => l.active)
      if (act) set({ activeTabId: act.id })
    } catch {
      /* corrupt layout — start fresh */
    }
  },
}))
