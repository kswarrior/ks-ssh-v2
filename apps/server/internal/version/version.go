// Package version holds build-stamped release metadata.
// Values are injected at link time by rebuild.sh (-ldflags -X).
package version

var (
	Version   = "dev"
	Commit    = "unknown"
	BuildDate = "unknown"
)

// String renders "version (commit, date)".
func String() string {
	return Version + " (" + Commit + ", " + BuildDate + ")"
}
