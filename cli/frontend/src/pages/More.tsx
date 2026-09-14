// "More" hub — replaces the old Settings page.
// Add future entries by copying the Users <li> below.

function UsersIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function AuditIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  )
}

function RecIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m10 9 5 3-5 3z" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

export default function MorePage({ authProtected }: { authProtected: boolean }) {
  const openUsers = () => {
    window.location.hash = '#/users'
  }
  const openAudit = () => {
    window.location.hash = '#/audit'
  }
  const openRecordings = () => {
    window.location.hash = '#/recordings'
  }

  return (
    <section className="page settings-page" aria-labelledby="page-title-more">
      <h1 id="page-title-more" className="sr-only">
        More
      </h1>

      <div className="card">
        <ul className="server-list">
          <li className="server-row">
            <span className="ssh-icon" aria-hidden="true">
              <UsersIcon />
            </span>
            <div className="server-info">
              <div className="server-name">Users</div>
              <div className="users-created">
                {authProtected
                  ? 'Roles (admin/operator/viewer), 2FA, sessions — admin manages accounts'
                  : 'Needs the login gate (--user and --pass)'}
              </div>
            </div>
            <div className="row-actions">
              {authProtected ? (
                <button type="button" className="btn btn-sm btn-primary" onClick={openUsers}>
                  Open <ChevronIcon />
                </button>
              ) : (
                <span className="tag offline">Disabled</span>
              )}
            </div>
          </li>

          <li className="server-row">
            <span className="ssh-icon" aria-hidden="true">
              <AuditIcon />
            </span>
            <div className="server-info">
              <div className="server-name">Audit log</div>
              <div className="users-created">
                {authProtected
                  ? 'Logins, user changes, kills, file writes, shell attach — admin only, JSON/CSV export'
                  : 'Needs the login gate (--user and --pass)'}
              </div>
            </div>
            <div className="row-actions">
              {authProtected ? (
                <button type="button" className="btn btn-sm btn-primary" onClick={openAudit}>
                  Open <ChevronIcon />
                </button>
              ) : (
                <span className="tag offline">Disabled</span>
              )}
            </div>
          </li>

          <li className="server-row">
            <span className="ssh-icon" aria-hidden="true">
              <RecIcon />
            </span>
            <div className="server-info">
              <div className="server-name">Recordings</div>
              <div className="users-created">
                Session replay (play/pause/speed/scrub, read-only) — viewer+ plays, admin deletes
              </div>
            </div>
            <div className="row-actions">
              <button type="button" className="btn btn-sm btn-primary" onClick={openRecordings}>
                Open <ChevronIcon />
              </button>
            </div>
          </li>

          {/* Add more entries later — copy the <li> above, change icon/title/hash. */}
        </ul>
      </div>

      <div className="card">
        <h2>Identity &amp; audit</h2>
        <p className="lead">
          Least-privilege roles: <code>viewer</code> reads (files/host/ports, watch
          terminals, play recordings); <code>operator</code> adds shell writes, uploads
          and mkdir; <code>admin</code> adds kill, delete, chmod, user management, audit
          and recording deletes. The main <code>--user</code> account is always admin;
          older accounts without a role default to <code>operator</code>.
        </p>
        <p className="lead">
          Sessions: 12h absolute + 30min idle expiry, cookie is HttpOnly + Secure +
          SameSite=Lax and rotates on privilege change. 5 bad logins lock the IP+user
          for 5 minutes (audited). Optional TOTP 2FA per account (Users page) and SSO
          via <code>--oidc-issuer</code> + <code>--oidc-client-id</code> (new SSO
          accounts start as <code>viewer</code>, optional{' '}
          <code>--oidc-allow-domain</code> whitelist).
        </p>
        <h2>Retention</h2>
        <p className="lead">
          Audit rows: <code>--audit-retain-days</code> (default 90, 0 = keep forever).
          Session recordings: <code>--record-max-mb</code> per session (default 10,
          oldest frames drop first); recording is ON by default when auth is on (
          <code>--record</code> forces on, <code>--no-record</code> forces off).
        </p>
        <h2>Relay links</h2>
        <p className="lead">
          The relay share link (<code>/v/TOKEN</code>) is token-addressed and now
          full-function: HTTP <code>/api/*</code> rides <code>rpc-*</code> and the
          PTY rides <code>shell-*</code> to a loopback server running the same
          router — so login, RBAC and audit apply over relay exactly as locally
          (your session cookie is forwarded). Restart with <code>--relay-auth</code>{' '}
          to additionally require a one-time viewer PIN (printed once at startup;
          authed users can mint fresh ones; each mint invalidates the previous
          PIN and PINs expire after 15 minutes) before any bridge opens. The PIN
          travels inside E2E only, and the E2E key <code>k</code> never travels
          in query strings or logs.
        </p>
        <p className="lead">
          Relay traffic is end-to-end encrypted by default (AES-256-GCM, strict:
          peers without E2E are refused with an <code>E2E error</code>, never
          silently downgraded; <code>--no-e2e</code> is the only explicit escape
          hatch). Ciphertexts bind the room, session, direction and connection
          epoch, carry random padding, and the agent&apos;s{' '}
          <code>E2E fingerprint</code> (printed at startup) is verified by the
          viewer on first connect. The pushed UI bundle itself is public build
          output with zero secrets, served with <code>no-store</code>.
        </p>
      </div>
    </section>
  )
}
