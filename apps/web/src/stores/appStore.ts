import { create } from 'zustand'
import { api } from '../lib/api'

export interface User {
  id: number
  username: string
  role: string
  totpEnabled: boolean
}

export interface Host {
  id: number
  name: string
  hostname: string
  port: number
  username: string
  authType: 'password' | 'key' | 'key_passphrase' | 'agent'
  groupId: number | null
  labels: string[]
  color: string
  jumpHostId: number | null
  maxSessions: number
  previewEnabled: boolean
  lastUsedAt: string | null
}

export interface HostStatus {
  connected: boolean
  rttMs: number
  ptyCount: number
}

export interface Notice {
  id: string
  level: 'info' | 'warn' | 'error'
  title: string
  body?: string
  at: number
  read: boolean
}

interface AppState {
  user: User | null
  authChecked: boolean
  hosts: Host[]
  statuses: Record<number, HostStatus>
  activeHostId: number | null
  settings: Record<string, string>
  notices: Notice[]
  paletteOpen: boolean
  overlay: null | 'monitor' | 'sysinfo' | 'settings' | 'audit' | 'search' | 'snippets'
  rightTab: 'files' | 'ports' | 'tunnels' | 'ops' | 'snippets' | 'audit'
  drawerOpen: boolean   // mobile: left drawer (hosts/tools)
  rightOpen: boolean    // mobile: right panel overlay

  setDrawerOpen: (open: boolean) => void
  setRightOpen: (open: boolean) => void
  toggleMobilePanel: (t: AppState['rightTab']) => void

  setAuth: (u: User | null) => void
  loadHosts: () => Promise<void>
  pollStatuses: () => Promise<void>
  setActiveHost: (id: number | null) => void
  loadSettings: () => Promise<void>
  saveSettings: (s: Record<string, string>) => Promise<void>
  notify: (n: Omit<Notice, 'id' | 'at' | 'read'>) => void
  markAllRead: () => void
  removeNotice: (id: string) => void
  setPaletteOpen: (open: boolean) => void
  setOverlay: (o: AppState['overlay']) => void
  setRightTab: (t: AppState['rightTab']) => void
  logout: () => Promise<void>
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export const useApp = create<AppState>((set, get) => ({
  user: null,
  authChecked: false,
  hosts: [],
  statuses: {},
  activeHostId: null,
  settings: {
    theme: 'dark',
    accentColor: '#3b82f6',
    fontSize: '14',
    keyBarDefault: 'true',
    autoSaveEditor: 'false',
    terminalTheme: 'ks-dark',
  },
  notices: [],
  paletteOpen: false,
  overlay: null,
  rightTab: 'files',
  drawerOpen: false,
  rightOpen: false,

  setDrawerOpen(open) {
    set({ drawerOpen: open })
  },

  setRightOpen(open) {
    set({ rightOpen: open })
  },

  // on phones the tools live in the slide-in right panel;
  // on desktop this is a plain tab switch
  toggleMobilePanel(t) {
    const st = get()
    const mobile =
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 900px)').matches
    if (!mobile) {
      set({ rightTab: t })
      return
    }
    if (st.rightOpen && st.rightTab === t) {
      set({ rightOpen: false })
      return
    }
    set({ rightTab: t, rightOpen: true, drawerOpen: false })
  },

  async setAuth(u) {
    set({ user: u, authChecked: true })
    if (u) {
      await get().loadHosts()
      get().loadSettings().catch(() => {})
      get().pollStatuses().catch(() => {})
    }
  },

  async loadHosts() {
    try {
      const hosts = await api<Host[]>('/api/hosts')
      set(state => ({
        hosts,
        activeHostId:
          state.activeHostId && hosts.some(h => h.id === state.activeHostId)
            ? state.activeHostId
            : hosts[0]?.id ?? null,
      }))
    } catch {
      /* handled by caller */
    }
  },

  async pollStatuses() {
    if (!get().user) return
    try {
      const statuses = await api<Record<number, HostStatus>>('/api/hosts/status')
      set({ statuses })
    } catch {
      /* transient */
    }
  },

  setActiveHost(id) {
    set({ activeHostId: id })
  },

  async loadSettings() {
    const s = await api<Record<string, string>>('/api/settings')
    set({ settings: s })
    document.documentElement.dataset.theme = s.theme === 'light' ? 'light' : 'dark'
    document.documentElement.style.setProperty('--accent', s.accentColor || '#3b82f6')
  },

  async saveSettings(s) {
    set({ settings: { ...get().settings, ...s } })
    document.documentElement.dataset.theme = s.theme === 'light' ? 'light' : undefined
    if (s.accentColor) document.documentElement.style.setProperty('--accent', s.accentColor)
    await api('/api/settings', { method: 'PUT', body: s })
  },

  notify(n) {
    const notice: Notice = { ...n, id: uid(), at: Date.now(), read: false }
    set(st => ({ notices: [notice, ...st.notices].slice(0, 100) }))
    if (notice.level === 'error') console.warn('[KS SSH]', notice.title, notice.body)
  },

  markAllRead() {
    set(st => ({ notices: st.notices.map(n => ({ ...n, read: true })) }))
  },

  removeNotice(id) {
    set(st => ({ notices: st.notices.filter(n => n.id !== id) }))
  },

  setPaletteOpen(open) {
    set({ paletteOpen: open })
  },
  setOverlay(o) {
    set({ overlay: o })
  },
  setRightTab(t) {
    set({ rightTab: t })
  },

  async logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' })
    } catch {
      /* ignore */
    }
    set({ user: null, hosts: [], statuses: {}, activeHostId: null, notices: [] })
  },
}))
