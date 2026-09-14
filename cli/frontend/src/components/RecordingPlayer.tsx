import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type RecFrame = {
  seq: number
  ts_ms: number
  kind: 'in' | 'out'
  data: string // base64 (standard)
}

function b64ToText(b64: string): string {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

/**
 * Read-only session replay: play/pause/speed/scrub over timestamped
 * input+output frames from GET /api/terms/:id/recording.
 * Playback respects RBAC server-side (viewer+ may play, admin may delete);
 * this component never sends input back to the shell.
 */
export default function RecordingPlayer({ sid, onDelete }: { sid: string; onDelete?: () => void }) {
  const [frames, setFrames] = useState<RecFrame[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [head, setHead] = useState(0) // frames shown: [0, head)
  const [showInput, setShowInput] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)
  const preRef = useRef<HTMLPreElement | null>(null)

  const load = useCallback(async () => {
    setError(null)
    setFrames(null)
    setHead(0)
    setPlaying(false)
    try {
      const res = await fetch(
        `/api/terms/${encodeURIComponent(sid)}/recording?from=0&limit=2000`,
        { cache: 'no-store', credentials: 'same-origin' },
      )
      if (res.status === 401) {
        window.dispatchEvent(
          new CustomEvent('ks-ssh:auth', { detail: { protected: true, authenticated: false } }),
        )
        throw new Error('Session expired — please log in again.')
      }
      const data = (await res.json().catch(() => null)) as {
        frames?: RecFrame[]
        error?: string
      } | null
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
      setFrames(Array.isArray(data?.frames) ? data.frames : [])
    } catch (e) {
      setError((e as Error).message)
    }
  }, [sid])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    }
  }, [])

  const total = frames?.length ?? 0

  // Relative timeline: ms since the first frame (for the scrub readout).
  const relMs = useCallback(
    (idx: number): number => {
      if (!frames || frames.length === 0) return 0
      const t0 = frames[0].ts_ms
      const f = frames[Math.min(idx, frames.length - 1)]
      return Math.max(0, (f?.ts_ms ?? t0) - t0)
    },
    [frames],
  )

  // Advance the playhead honoring inter-frame gaps / speed.
  useEffect(() => {
    if (!playing || !frames || head >= frames.length) {
      if (frames && head >= frames.length) setPlaying(false)
      return
    }
    const cur = frames[head]
    const nxt = frames[head + 1]
    const gap = nxt ? Math.max(0, nxt.ts_ms - cur.ts_ms) : 500
    // Cap idle gaps at 2s so long pauses don't stall the replay.
    const wait = Math.min(gap, 2000) / speed
    timerRef.current = window.setTimeout(() => setHead((h) => h + 1), Math.max(16, wait))
    return () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
    }
  }, [playing, head, frames, speed])

  const transcript = useMemo(() => {
    if (!frames) return ''
    let out = ''
    for (let i = 0; i < head && i < frames.length; i++) {
      const f = frames[i]
      if (f.kind === 'in') {
        if (showInput) out += b64ToText(f.data)
      } else {
        out += b64ToText(f.data)
      }
    }
    // Keep the DOM bounded for huge sessions.
    if (out.length > 200_000) out = out.slice(-200_000)
    return out
  }, [frames, head, showInput])

  useEffect(() => {
    // Follow the tail while playing.
    if (playing && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [transcript, playing])

  const remove = async () => {
    if (deleting || !onDelete) return
    if (!window.confirm(`Delete the recording for session ${sid.slice(0, 8)}? The live shell is unaffected.`)) {
      return
    }
    setDeleting(true)
    try {
      const res = await fetch(`/api/terms/${encodeURIComponent(sid)}/recording`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      if (res.status === 403) throw new Error('Only admins can delete recordings.')
      if (!res.ok) throw new Error(`Delete failed (${res.status})`)
      setFrames([])
      setHead(0)
      setPlaying(false)
      onDelete()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const fmtClock = (ms: number): string => {
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    return `${m}:${String(s % 60).padStart(2, '0')}`
  }

  return (
    <div className="rec-player" aria-label={`Recording replay for session ${sid.slice(0, 8)}`}>
      <div className="rec-player-bar">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!frames || total === 0}
          onClick={() => {
            if (head >= total) setHead(0)
            setPlaying((p) => !p)
          }}
        >
          {playing ? 'Pause' : head >= total && total > 0 ? 'Replay' : 'Play'}
        </button>
        <label className="rec-speed">
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Replay speed">
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
        </label>
        <label className="field checkbox-row rec-input-toggle">
          <input type="checkbox" checked={showInput} onChange={(e) => setShowInput(e.target.checked)} />
          Show keystrokes
        </label>
        {onDelete && (
          <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete (admin)'}
          </button>
        )}
      </div>
      {frames === null && !error && <p className="lead">Loading recording…</p>}
      {error && (
        <p className="login-error" role="alert">
          {error}{' '}
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      {frames && frames.length === 0 && !error && (
        <p className="lead">No recording frames for this session yet (recording may be off — see --no-record).</p>
      )}
      {frames && frames.length > 0 && (
        <>
          <input
            type="range"
            className="rec-scrub"
            min={0}
            max={total}
            value={head}
            onChange={(e) => {
              setHead(Number(e.target.value))
              setPlaying(false)
            }}
            aria-label="Scrub recording timeline (read-only)"
          />
          <div className="rec-meta" role="status">
            frame {Math.min(head, total)}/{total} · +{fmtClock(relMs(Math.max(0, head - 1)))} · read-only replay
          </div>
          <pre ref={preRef} className="rec-screen" aria-label="Recording transcript (read-only)">
            {transcript}
          </pre>
        </>
      )}
    </div>
  )
}
