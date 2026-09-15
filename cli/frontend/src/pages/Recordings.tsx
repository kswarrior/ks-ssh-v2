import { useCallback, useEffect, useState } from 'react'
import RecordingPlayer from '../components/RecordingPlayer'
import { navToRoute } from '../hash-route.ts'

type TermEntry = {
  id: string
  alive: boolean
  idle_secs: number
  bytes: number
  rec_frames: number
  rec_bytes: number
  recording: boolean
}

const REPLAY_HANDOFF = 'ks-ssh:replay-sid'

/** Read (+ clear) a Terminal → Recordings handoff (per-tab Replay button). */
export function takeReplayHandoff(): string | null {
  try {
    const sid = localStorage.getItem(REPLAY_HANDOFF)
    if (sid) localStorage.removeItem(REPLAY_HANDOFF)
    return sid || null
  } catch {
    return null
  }
}

export function requestReplay(sid: string): void {
  try {
    localStorage.setItem(REPLAY_HANDOFF, sid)
  } catch {
    // Storage unavailable — Recordings page just won't preselect.
  }
  navToRoute('#/recordings')
}

/**
 * Session recordings: timestamped input+output frames per shell session
 * (cap --record-max-mb each, default 10). Viewer+ may play back; only
 * admins may delete. Recording is ON by default when auth is on
 * (--record default on when auth on, --no-record disables) and the
 * Terminal page shows a consent banner while it is on.
 */
export default function RecordingsPage() {
  const [terms, setTerms] = useState<TermEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [recordingOn, setRecordingOn] = useState<boolean | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [tRes, rRes] = await Promise.all([
        fetch('/api/terms', { cache: 'no-store', credentials: 'same-origin' }),
        fetch('/api/record/status', { cache: 'no-store', credentials: 'same-origin' }),
      ])
      if (tRes.status === 401) {
        window.dispatchEvent(
          new CustomEvent('ks-ssh:auth', { detail: { protected: true, authenticated: false } }),
        )
        throw new Error('Session expired — please log in again.')
      }
      if (!tRes.ok) throw new Error(`Request failed (${tRes.status})`)
      const data = (await tRes.json()) as { sessions?: TermEntry[] }
      const list = Array.isArray(data.sessions) ? data.sessions : []
      setTerms(list)
      if (rRes.ok) {
        const rs = (await rRes.json()) as { recording?: boolean }
        setRecordingOn(!!rs.recording)
      }
      setSelected((prev) => {
        if (prev && list.some((t) => t.id === prev)) return prev
        const handoff = takeReplayHandoff()
        if (handoff && list.some((t) => t.id === handoff)) return handoff
        return list.length > 0 ? (list[0]?.id ?? null) : null
      })
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const fmtBytes = (n: number): string => {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }

  return (
    <section className="page settings-page" aria-label="Session recordings">
      <div className="page-head">
        <a className="btn btn-sm" href="#/more">
          ← More
        </a>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-sm" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <div className="card">
        <h2>Session recordings</h2>
        <p className="lead">
          {recordingOn === false
            ? 'Recording is currently OFF (--no-record). Existing frames are still playable below.'
            : 'Sessions are recorded (input + output with timestamps) while recording is on. Playback is read-only.'}{' '}
          Cap per session: <code>--record-max-mb</code> (default 10, oldest frames drop first).
        </p>
        {error && (
          <p className="login-error" role="alert">
            {error}{' '}
            <button type="button" className="btn btn-sm" onClick={() => void load()}>
              Retry
            </button>
          </p>
        )}
        {terms === null && !error && <p className="lead">Loading…</p>}
        {terms !== null && terms.length === 0 && <p className="lead">No sessions yet — open a terminal first.</p>}
        {terms !== null && terms.length > 0 && (
          <ul className="server-list">
            {terms.map((t) => (
              <li key={t.id} className="server-row">
                <div className="server-info">
                  <div className="server-name">
                    <code title={t.id}>{t.id.slice(0, 8)}</code>{' '}
                    <span className={t.alive ? 'tag' : 'tag offline'}>{t.alive ? 'live' : 'ended'}</span>
                  </div>
                  <div className="users-created">
                    {t.rec_frames} frame(s) · {fmtBytes(t.rec_bytes)}
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className={`btn btn-sm${selected === t.id ? ' btn-primary' : ''}`}
                    onClick={() => setSelected(t.id)}
                  >
                    {selected === t.id ? 'Selected' : 'Replay'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <div className="card">
          <h2>
            Replay <code title={selected}>{selected.slice(0, 8)}</code>
          </h2>
          <RecordingPlayer key={selected} sid={selected} onDelete={() => void load()} />
        </div>
      )}
    </section>
  )
}
