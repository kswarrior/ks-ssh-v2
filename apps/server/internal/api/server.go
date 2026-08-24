// Package api wires HTTP/WS routes to the backend layers.
package api

import (
	"io/fs"
	"net/http"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/ks/ks-ssh/server/internal/config"
	"github.com/ks/ks-ssh/server/internal/cryptox"
	"github.com/ks/ks-ssh/server/internal/proxy"
	"github.com/ks/ks-ssh/server/internal/sftplayer"
	"github.com/ks/ks-ssh/server/internal/sshlayer"
	"github.com/ks/ks-ssh/server/internal/store"
	"github.com/ks/ks-ssh/server/internal/tunnels"
	"github.com/ks/ks-ssh/server/internal/wshub"
)

type ctxKey string

const claimsCtxKey ctxKey = "ks-ssh:claims"

type Server struct {
	Cfg      *config.Config
	St       *store.Store
	Box      *cryptox.Box
	SSH      *sshlayer.Manager
	Tunnels  *tunnels.Manager
	Uploads  *sftplayer.UploadManager
	Registry *wshub.Registry

	loginMu sync.Mutex // serializes login attempts per process

	monMu     sync.Mutex
	monitors  map[int64]*monitorState
}

func New(cfg *config.Config, st *store.Store, box *cryptox.Box,
	sshm *sshlayer.Manager, tm *tunnels.Manager, reg *wshub.Registry) *Server {
	return &Server{
		Cfg: cfg, St: st, Box: box, SSH: sshm, Tunnels: tm,
		Uploads: sftplayer.NewUploadManager(), Registry: reg,
		monitors: map[int64]*monitorState{},
	}
}

func (s *Server) Router(webFS fs.FS, devMode bool) http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(secureHeaders(devMode))
	r.Use(recoverer)
	r.Use(requestLogger)

	// ---- public ----
	r.Post("/api/auth/login", s.handleLogin)
	r.Post("/api/auth/bootstrap", s.handleBootstrap)
	r.Get("/api/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
	})

	// ---- authenticated ----
	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)

		r.Post("/api/auth/logout", s.handleLogout)
		r.Get("/api/auth/me", s.handleMe)
		r.Post("/api/auth/2fa/setup", s.handle2FASetup)
		r.Post("/api/auth/2fa/enable", s.handle2FAEnable)
		r.Post("/api/auth/2fa/disable", s.handle2FADisable)
		r.Get("/api/ping", s.handlePing)

		// users (admin)
		r.With(s.requireRole("admin")).Get("/api/users", s.handleListUsers)
		r.With(s.requireRole("admin")).Post("/api/users", s.handleCreateUser)
		r.With(s.requireRole("admin")).Patch("/api/users/{id}", s.handleUpdateUser)
		r.With(s.requireRole("admin")).Delete("/api/users/{id}", s.handleDeleteUser)

		// hosts
		r.Get("/api/hosts", s.handleListHosts)
		r.With(s.requireRole("operator")).Post("/api/hosts", s.handleCreateHost)
		r.Post("/api/hosts/test", s.handleTestHost)
		r.Post("/api/hosts/import-ssh-config", s.handleImportSSHConfig)
		r.Get("/api/hosts/{id}", s.handleGetHost)
		r.With(s.requireRole("operator")).Put("/api/hosts/{id}", s.handleUpdateHost)
		r.With(s.requireRole("admin")).Delete("/api/hosts/{id}", s.handleDeleteHost)
		r.Post("/api/hosts/{id}/accept-key", s.handleAcceptHostKey)
		r.Post("/api/hosts/{id}/connect", s.handleConnectHost)
		r.Post("/api/hosts/{id}/disconnect", s.handleDisconnectHost)
		r.Get("/api/hosts/status", s.handleHostStatuses)

		r.Get("/api/groups", s.handleListGroups)
		r.With(s.requireRole("operator")).Post("/api/groups", s.handleCreateGroup)
		r.With(s.requireRole("operator")).Delete("/api/groups/{id}", s.handleDeleteGroup)

		r.Get("/api/known-hosts", s.handleListKnownHosts)
		r.Delete("/api/known-hosts/{hostname}/{port}", s.handleDeleteKnownHost)

		// files (REST)
		r.Get("/api/files/list", s.handleFileList)
		r.Get("/api/files/stat", s.handleFileStat)
		r.Get("/api/files/download", s.handleFileDownload)
		r.With(s.requireRole("operator")).Post("/api/files/mkdir", s.handleMkdir)
		r.With(s.requireRole("operator")).Post("/api/files/rename", s.handleRename)
		r.With(s.requireRole("operator")).Post("/api/files/move", s.handleMove)
		r.With(s.requireRole("operator")).Post("/api/files/copy", s.handleCopy)
		r.With(s.requireRole("operator")).Post("/api/files/delete", s.handleDelete)
		r.With(s.requireRole("operator")).Post("/api/files/chmod", s.handleChmod)
		r.Get("/api/files/search", s.handleFileSearch)
		r.With(s.requireRole("operator")).Post("/api/files/url-upload", s.handleURLUpload)

		// editor
		r.Get("/api/editor/open", s.handleEditorOpen)
		r.With(s.requireRole("operator")).Post("/api/editor/save", s.handleEditorSave)
		r.Post("/api/editor/diff", s.handleEditorDiff)
		r.Get("/api/editor/backups", s.handleBackupsList)
		r.Post("/api/editor/restore-backup", s.handleBackupRestore)
		r.Get("/api/editor/stat-poll", s.handleStatPoll)
		r.Post("/api/editor/touch-recent", s.handleTouchRecent)

		// search
		r.Post("/api/search", s.handleGlobalSearch)

		// ports
		r.Get("/api/ports", s.handlePortsList)
		r.With(s.requireRole("operator")).Post("/api/ports/kill", s.handlePortKill)

		// tunnels
		r.Get("/api/tunnels", s.handleTunnelList)
		r.With(s.requireRole("operator")).Post("/api/tunnels", s.handleTunnelCreate)
		r.With(s.requireRole("operator")).Put("/api/tunnels/{id}", s.handleTunnelUpdate)
		r.Post("/api/tunnels/{id}/start", s.handleTunnelStart)
		r.Post("/api/tunnels/{id}/stop", s.handleTunnelStop)
		r.With(s.requireRole("operator")).Delete("/api/tunnels/{id}", s.handleTunnelDelete)

		// monitor
		r.Get("/api/monitor/info", s.handleSysInfo)
		r.Get("/api/monitor/top", s.handleTopProcs)
		r.Get("/api/monitor/ws", s.handleMonitorWS)

		// snippets
		r.Get("/api/snippets", s.handleSnippetList)
		r.With(s.requireRole("operator")).Post("/api/snippets", s.handleSnippetCreate)
		r.With(s.requireRole("operator")).Put("/api/snippets/{id}", s.handleSnippetUpdate)
		r.With(s.requireRole("operator")).Delete("/api/snippets/{id}", s.handleSnippetDelete)
		r.Get("/api/snippets/ws/multi-run", s.handleMultiRunWS)

		// ops panels
		r.Get("/api/git/status", s.handleGitStatus)
		r.Post("/api/git/stage", s.handleGitStage)
		r.Post("/api/git/unstage", s.handleGitUnstage)
		r.Post("/api/git/commit", s.handleGitCommit)
		r.Get("/api/git/log", s.handleGitLog)
		r.Get("/api/git/branches", s.handleGitBranches)
		r.Post("/api/git/switch", s.handleGitSwitch)
		r.Post("/api/git/action", s.handleGitAction)

		r.Get("/api/docker/ps", s.handleDockerPS)
		r.Post("/api/docker/action", s.handleDockerAction)
		r.Get("/api/docker/logs/ws", s.handleDockerLogsWS)
		r.Get("/api/docker/exec/ws", s.handleDockerExecWS)

		r.Get("/api/services", s.handleServicesList)
		r.Post("/api/services/action", s.handleServiceAction)

		r.Get("/api/cron", s.handleCronRead)
		r.Post("/api/cron", s.handleCronWrite)

		r.Get("/api/logs/ws", s.handleLogsWS)

		// history
		r.Get("/api/history", s.handleHistoryList)

		// bookmarks
		r.Get("/api/bookmarks", s.handleBookmarkList)
		r.Post("/api/bookmarks", s.handleBookmarkCreate)
		r.Delete("/api/bookmarks/{id}", s.handleBookmarkDelete)
		r.Patch("/api/bookmarks/{id}", s.handleBookmarkRename)

		// sessions & audit
		r.Get("/api/sessions", s.handleSessionList)
		r.Get("/api/hosts/{id}/sessions", s.handleHostSessions)
		r.Get("/api/audit", s.handleAuditList)
		r.Get("/api/audit/export", s.handleAuditExport)
		r.Get("/api/recordings", s.handleRecordingsList)
		r.Get("/api/recordings/{id}", s.handleRecordingFile)

		// settings
		r.Get("/api/settings", s.handleSettingsGet)
		r.Put("/api/settings", s.handleSettingsPut)

		// transfers persistence view
		r.Get("/api/transfers", s.handleTransfersList)

		// websockets (auth already applied)
		r.Get("/api/terminal/ws", s.handleTerminalWS)
		r.Get("/api/files/ws", s.handleFilesWS)
	})

	// preview proxy (own auth: cookie OR bearer-less browser nav)
	r.Route("/port/preview", func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Handle("/*", s.previewProxy())
	})

	// embedded SPA
	if webFS != nil {
		fileServer := http.FileServerFS(webFS)
		r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
			serveStatic(w, req, webFS, fileServer)
		})
		r.NotFound(func(w http.ResponseWriter, req *http.Request) {
			serveIndex(w, req, webFS, fileServer)
		})
	}
	return r
}

// previewProxy builds the gated reverse proxy handler.
func (s *Server) previewProxy() http.Handler {
	gate := func(hostID int64) (bool, string) {
		h, err := s.St.GetHost(hostID)
		if err != nil {
			return false, "unknown host"
		}
		if !h.PreviewEnabled {
			return false, "preview disabled for this host (enable in host settings)"
		}
		return true, ""
	}
	return proxy.New(s.SSH, gate, s.Cfg.PortAsInt())
}

var _ = sftplayer.ChunkSize // keep transfer constants referenced

