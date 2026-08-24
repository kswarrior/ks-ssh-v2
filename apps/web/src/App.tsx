import { useEffect } from 'react'
import { useApp } from './stores/appStore'
import Login from './components/Login'
import Header from './components/Header'
import Sidebar from './components/Sidebar'
import Workspace from './components/Workspace'
import RightBar from './components/RightBar'
import CommandPalette from './components/CommandPalette'
import Overlays from './components/Overlays'
import { api } from './lib/api'
import type { User } from './stores/appStore'

export default function App() {
  const { user, authChecked, setAuth, pollStatuses, paletteOpen } = useApp()

  useEffect(() => {
    api<{ user: User }>('/api/auth/me')
      .then(r => setAuth(r.user))
      .catch(() => setAuth(null))
  }, [setAuth])

  useEffect(() => {
    if (!user) return
    const t = setInterval(() => pollStatuses(), 5000)
    return () => clearInterval(t)
  }, [user, pollStatuses])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        useApp.getState().setPaletteOpen(!paletteOpen)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        useApp.getState().setOverlay('search')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [paletteOpen])

  // zen mode + collapsible sidebars (plan §2.11)
  useEffect(() => {
    const apply = () => {
      const s = useApp.getState().settings
      document.documentElement.classList.toggle('zen-mode', s.zenMode === '1')
      document.documentElement.classList.toggle('hide-sidebar', s.hideSidebar === '1')
      document.documentElement.classList.toggle('hide-rightbar', s.hideRightbar === '1')
    }
    apply()
    const unsub = useApp.subscribe(apply)
    return unsub
  }, [])

  if (!authChecked) {
    return <div className="login-wrap"><div className="muted">connecting…</div></div>
  }

  if (!user) {
    return <Login />
  }

  const s = useApp.getState().settings
  const cls = [
    'app',
    s.zenMode === '1' ? 'zen-mode' : '',
    s.hideSidebar === '1' ? 'hide-sidebar' : '',
    s.hideRightbar === '1' ? 'hide-rightbar' : '',
    useApp.getState().drawerOpen ? 'drawer-open' : '',
    useApp.getState().rightOpen ? 'right-open' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cls}>
      <Header />
      <div className="main">
        <Sidebar />
        <Workspace />
        <RightBar />
      </div>
      {(useApp.getState().drawerOpen || useApp.getState().rightOpen) && (
        <div className="mobile-backdrop only-mobile"
          onClick={() => {
            useApp.getState().setDrawerOpen(false)
            useApp.getState().setRightOpen(false)
          }} />
      )}
      <CommandPalette />
      <Overlays />
    </div>
  )
}
