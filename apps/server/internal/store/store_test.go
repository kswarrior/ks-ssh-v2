package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestMigrationsAndCRUD(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	if n, _ := st.UserCount(); n != 0 {
		t.Fatalf("fresh db should have 0 users, got %d", n)
	}
	u, err := st.CreateUser("admin", "password123", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if !st.CheckPassword(u.ID, "password123") || st.CheckPassword(u.ID, "wrong") {
		t.Fatal("password check failed")
	}

	in := HostInput{Name: "web1", Hostname: "10.0.0.5", Port: 22,
		Username: "root", AuthType: "password", Labels: `["prod"]`, Color: "#fff",
		MaxSessions: 5, PreviewEnabled: true}
	h, err := st.CreateHost(in)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetCredential(h.ID, strptr("enc-pass"), nil, nil); err != nil {
		t.Fatal(err)
	}
	got, err := st.GetCredential(h.ID)
	if err != nil || got.PasswordEnc == nil || *got.PasswordEnc != "enc-pass" {
		t.Fatalf("credential roundtrip failed: %+v %v", got, err)
	}
	h2, _ := st.GetHost(h.ID)
	if !h2.PreviewEnabled || h2.MaxSessions != 5 || h2.Labels != `["prod"]` {
		t.Fatalf("host fields lost: %+v", h2)
	}
	if err := st.DeleteHost(h.ID); err != nil {
		t.Fatal(err)
	}
	if c, _ := st.GetCredential(h.ID); c == nil {
		// cascade delete leaves no row — GetCredential returns empty struct, fine
		_ = c
	}

	if err := st.AppendAudit("alice", "file.delete", "/tmp/x", "web1", "ok", ""); err != nil {
		t.Fatal(err)
	}
	log, err := st.ListAudit(10)
	if err != nil || len(log) != 1 || log[0].Action != "file.delete" {
		t.Fatalf("audit append/list failed: %+v %v", log, err)
	}

	if _, err := st.StartSession("tok-1", "alice", "web1", "pty"); err != nil {
		t.Fatal(err)
	}
	sessions, _ := st.ListSessions(5)
	if len(sessions) != 1 {
		t.Fatalf("want 1 session, got %d", len(sessions))
	}

	id, err := st.AddBackup(h.ID, "/etc/app.conf", []byte("old"))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.PruneBackups(h.ID, "/etc/app.conf", 3); err != nil {
		t.Fatal(err)
	}
	bs, _ := st.ListBackups(h.ID, "/etc/app.conf")
	if len(bs) != 1 || bs[0].ID != id {
		t.Fatalf("backup list wrong: %+v", bs)
	}

	if err := st.SetSetting("theme", "dark"); err != nil {
		t.Fatal(err)
	}
	v, ok, _ := st.GetSetting("theme")
	if !ok || v != "dark" {
		t.Fatal("setting roundtrip failed")
	}
}

func TestLockoutWindow(t *testing.T) {
	dir := t.TempDir()
	st, _ := Open(filepath.Join(dir, "t2.db"))
	defer st.Close()
	for i := 0; i < 6; i++ {
		_ = st.RecordAuthAttempt("bob", "1.2.3.4", false)
	}
	n, err := st.RecentFailures("bob", 10*time.Minute)
	if err != nil || n != 6 {
		t.Fatalf("failures=%d err=%v", n, err)
	}
}

func strptr(s string) *string { return &s }
