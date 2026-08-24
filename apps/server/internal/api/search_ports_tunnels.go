package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/ks/ks-ssh/server/internal/execx"
)

func (s *Server) handleGlobalSearch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID        int64  `json:"hostId"`
		Root          string `json:"root"`
		Query         string `json:"query"`
		Replace       string `json:"replace,omitempty"`
		DoReplace     bool   `json:"doReplace,omitempty"`
		CaseSensitive bool   `json:"caseSensitive,omitempty"`
		IncludeGlob   string `json:"includeGlob,omitempty"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	c, err := s.SSH.Get(req.HostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	if req.DoReplace {
		n, err := execx.Replace(r.Context(), c, req.Root, req.Query, req.Replace, req.CaseSensitive)
		if err != nil {
			fail(w, http.StatusBadGateway, "grep", err.Error())
			return
		}
		s.audit(r, "search.replace", req.Query+" → "+req.Replace+" in "+req.Root,
			strconv.FormatInt(req.HostID, 10), "ok", "files changed")
		writeJSON(w, 200, map[string]any{"filesChanged": n})
		return
	}
	hits, err := execx.Grep(r.Context(), c, req.Root, req.Query, req.CaseSensitive, req.IncludeGlob, 500)
	if err != nil {
		fail(w, http.StatusBadGateway, "grep", err.Error())
		return
	}
	writeJSON(w, 200, hits)
}

func (s *Server) handlePortsList(w http.ResponseWriter, r *http.Request) {
	hostID := queryHost(r)
	c, err := s.SSH.Get(hostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	rows, err := portsList(r.Context(), c)
	if err != nil {
		fail(w, http.StatusBadGateway, "ports", err.Error())
		return
	}
	writeJSON(w, 200, rows)
}

func (s *Server) handlePortKill(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID int64 `json:"hostId"`
		PID    int64 `json:"pid"`
		Port   int   `json:"port"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	c, err := s.SSH.Get(req.HostID)
	if err != nil {
		fail(w, http.StatusBadGateway, "offline", "host offline")
		return
	}
	if err := portsKill(r.Context(), c, req.PID, req.Port); err != nil {
		s.audit(r, "port.kill", pidPortStr(req.PID, req.Port),
			strconv.FormatInt(req.HostID, 10), "failed", err.Error())
		fail(w, http.StatusBadGateway, "kill", err.Error())
		return
	}
	s.audit(r, "port.kill", pidPortStr(req.PID, req.Port),
		strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 200, map[string]bool{"killed": true})
}

func pidPortStr(pid int64, port int) string {
	return "pid=" + strconv.FormatInt(pid, 10) + " port=" + strconv.Itoa(port)
}

// ---- tunnels ----

type tunnelRow struct {
	ID          int64  `json:"id"`
	HostID      int64  `json:"hostId"`
	Kind        string `json:"kind"`
	LocalHost   string `json:"localHost"`
	LocalPort   int    `json:"localPort"`
	RemoteHost  string `json:"remoteHost"`
	RemotePort  int    `json:"remotePort"`
	AutoStart   bool   `json:"autoStart"`
	Status      string `json:"status"`
	Error       string `json:"error,omitempty"`
	BytesUp     int64  `json:"bytesUp"`
	BytesDown   int64  `json:"bytesDown"`
	Connections int64  `json:"connections"`
}

func (s *Server) handleTunnelList(w http.ResponseWriter, r *http.Request) {
	list, err := s.St.ListTunnels()
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	out := make([]tunnelRow, 0, len(list))
	for _, t := range list {
		row := tunnelRow{
			ID: t.ID, HostID: t.HostID, Kind: t.Kind,
			LocalHost: t.LocalHost, LocalPort: t.LocalPort,
			RemoteHost: t.RemoteHost, RemotePort: t.RemotePort,
			AutoStart: t.AutoStart,
		}
		st, e, up, down, cn := s.Tunnels.Detail(t.ID)
		row.Status = string(st)
		row.Error = e
		row.BytesUp = up
		row.BytesDown = down
		row.Connections = cn
		out = append(out, row)
	}
	writeJSON(w, 200, out)
}

func (s *Server) handleTunnelCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		HostID     int64  `json:"hostId"`
		Kind       string `json:"kind"` // L | R | D
		LocalHost  string `json:"localHost"`
		LocalPort  int    `json:"localPort"`
		RemoteHost string `json:"remoteHost"`
		RemotePort int    `json:"remotePort"`
		AutoStart  *bool  `json:"autoStart"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	switch req.Kind {
	case "L":
		if req.RemoteHost == "" || req.RemotePort <= 0 {
			fail(w, 400, "bad_request", "L needs remoteHost+remotePort")
			return
		}
	case "R":
		if req.RemotePort <= 0 || req.LocalPort <= 0 {
			fail(w, 400, "bad_request", "R needs remotePort and local target port")
			return
		}
	case "D":
	default:
		fail(w, 400, "bad_request", "kind must be L|R|D")
		return
	}
	localHost := req.LocalHost
	if localHost == "" {
		localHost = "127.0.0.1"
	}
	if err := validateBind(localHost, req.LocalPort, s.Cfg.PortAsInt()); err != nil {
		fail(w, 400, "bad_bind", err.Error())
		return
	}
	autoStart := true
	if req.AutoStart != nil {
		autoStart = *req.AutoStart
	}
	t, err := s.St.CreateTunnel(req.HostID, req.Kind, localHost, req.LocalPort,
		req.RemoteHost, req.RemotePort, autoStart)
	if err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	if autoStart {
		_ = s.Tunnels.Start(t)
	}
	s.audit(r, "tunnel.create", tunnelTarget(t.Kind, localHost, req.LocalPort, req.RemoteHost, req.RemotePort),
		strconv.FormatInt(req.HostID, 10), "ok", "")
	writeJSON(w, 201, map[string]any{"id": t.ID})
}

func tunnelTarget(kind, lh string, lp int, rh string, rp int) string {
	switch kind {
	case "L":
		return lh + ":" + itoa(lp) + " → " + rh + ":" + itoa(rp)
	case "R":
		return "remote " + orLoopback2(rh) + ":" + itoa(rp) + " → local :" + itoa(lp)
	default:
		return "SOCKS5 on " + lh + ":" + itoa(lp)
	}
}

func orLoopback2(h string) string {
	if h == "" {
		return "*"
	}
	return h
}

func itoa(n int) string { return strconv.Itoa(n) }

func (s *Server) handleTunnelUpdate(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	var req struct {
		Kind       string `json:"kind"`
		LocalHost  string `json:"localHost"`
		LocalPort  int    `json:"localPort"`
		RemoteHost string `json:"remoteHost"`
		RemotePort int    `json:"remotePort"`
		AutoStart  bool   `json:"autoStart"`
	}
	if err := decodeJSON(r, &req); err != nil {
		fail(w, 400, "bad_request", err.Error())
		return
	}
	localHost := req.LocalHost
	if localHost == "" {
		localHost = "127.0.0.1"
	}
	if err := validateBind(localHost, req.LocalPort, s.Cfg.PortAsInt()); err != nil {
		fail(w, 400, "bad_bind", err.Error())
		return
	}
	s.Tunnels.Stop(id)
	if err := s.St.UpdateTunnel(id, req.Kind, localHost, req.LocalPort, req.RemoteHost, req.RemotePort, req.AutoStart); err != nil {
		fail(w, 404, "not_found", err.Error())
		return
	}
	if t, err := s.St.GetTunnel(id); err == nil && req.AutoStart {
		_ = s.Tunnels.Start(t)
	}
	s.audit(r, "tunnel.update", itoa(int(id)), "-", "ok", "")
	writeJSON(w, 200, map[string]bool{"updated": true})
}

func (s *Server) handleTunnelStart(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	t, err := s.St.GetTunnel(id)
	if err != nil {
		fail(w, 404, "not_found", "no such tunnel")
		return
	}
	if err := s.Tunnels.Start(t); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"started": true})
}

func (s *Server) handleTunnelStop(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	s.Tunnels.Stop(id)
	writeJSON(w, 200, map[string]bool{"stopped": true})
}

func (s *Server) handleTunnelDelete(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(chiURLParam(r, "id"), 10, 64)
	s.Tunnels.Stop(id)
	if err := s.St.DeleteTunnel(id); err != nil {
		fail(w, 500, "internal", err.Error())
		return
	}
	s.audit(r, "tunnel.delete", itoa(int(id)), "-", "ok", "")
	writeJSON(w, 200, map[string]bool{"deleted": true})
}

var _ = time.Now
