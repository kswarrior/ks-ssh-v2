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
                  ? 'Manage who can log in to this server'
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

          {/* Add more entries later — copy the <li> above, change icon/title/hash. */}
        </ul>
      </div>
    </section>
  )
}
