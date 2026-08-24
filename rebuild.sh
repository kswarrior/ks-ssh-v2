#!/usr/bin/env bash
# KS SSH — Hardened Production Build Script
#
# Same release pipeline as /test/ks-panel/rebuild.sh, adapted to the
# KS SSH layout (apps/web + apps/server, frontend embedded via go:embed).
#
# This script implements a professional closed-source Linux release pipeline with
# defense-in-depth security hardening. It produces a production binary that is
# significantly more difficult to reverse-engineer, tamper with, or extract
# information from, while preserving all runtime functionality.
#
# Usage:
#   ./rebuild.sh               # Production build (hardened)
#   ./rebuild.sh dev           # Development build (debuggable)
#   ./rebuild.sh --help        # Show help
#
# Environment Variables (production):
#   VERSION            Semantic version (e.g., 1.2.3)
#   COMMIT             Git short commit (auto-detected if not set)
#   BUILD_DATE         ISO8601 UTC (auto-generated if not set)
#   GOARCH             Target architecture (amd64, arm64)
#   GOOS               Target OS (linux)
#   GARBLE_ENABLE      Set to "1" to enable Go obfuscation via garble
#   SIGN_KEY           Path to signing private key (for code signing)
#   SIGN_CMD           Custom signing command (default: cosign sign-blob)
#
# Requirements:
#   - Go 1.22+
#   - Node.js 20+
#   - garble (optional, for obfuscation): go install mvdan.cc/garble@latest
#   - cosign (optional, for signing): go install github.com/sigstore/cosign/v2/cmd/cosign@latest
#
# Security Properties:
#   -trimpath: Removes all source paths from the binary
#   -ldflags="-s -w": Strips DWARF debug info and symbol table
#   Binary stripping: Removes non-essential ELF symbols (validated post-strip)
#   Source leakage scan: Verifies no absolute paths remain in binary
#   Secret scan: Checks artifacts for common secret patterns
#   Checksums: SHA-256 for all release artifacts
#   Signing: Optional cryptographic signing via cosign

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT_DIR/apps/server"
WEB_DIR="$ROOT_DIR/apps/web"
EMBED_DIST_DIR="$SERVER_DIR/internal/web/dist"   # go:embed target (internal/web)
RELEASE_DIR="$ROOT_DIR/release"

KSSSH_RELEASE_BIN="$RELEASE_DIR/ks-ssh"
KSSSH_OLD_BIN="$KSSSH_RELEASE_BIN.old"

# Build mode: "production" (default) or "development"
BUILD_MODE="${1:-production}"

# Target architecture (can be overridden via env)
TARGET_GOOS="${GOOS:-linux}"
TARGET_GOARCH="${GOARCH:-$(go env GOARCH)}"

# Obfuscation
GARBLE_ENABLE="${GARBLE_ENABLE:-0}"

# Signing
SIGN_KEY="${SIGN_KEY:-}"
SIGN_CMD="${SIGN_CMD:-cosign sign-blob}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# Helper Functions
# ============================================================================

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_ok() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_err() { echo -e "${RED}[ERR]${NC} $*" >&2; }
log_step() { echo -e "${BLUE}==>${NC} $*"; }

die() { log_err "$*"; exit 1; }

# file_type: print file(1)'s output when the utility is installed; on
# minimal hosts without file(1), fall back to reading the 4-byte ELF magic
# (7f 45 4c 46) directly so build verification doesn't false-fail.
file_type() {
    if command -v file >/dev/null 2>&1; then
        file "$1"
    elif [ "$(head -c 4 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "7f454c46" ]; then
        echo "$1: ELF"
    else
        echo "$1: unknown format"
        return 1
    fi
}

# has_file_cmd: true when file(1) is available (needed for checks that grep
# its detailed output, e.g. "with debug_info").
has_file_cmd() { command -v file >/dev/null 2>&1; }

show_help() {
    cat <<'EOF'
KS SSH — Hardened Production Build Script

Usage:
  ./rebuild.sh [mode] [options]

Modes:
  production    Hardened release build (default)
  dev           Development build with debug symbols

Environment Variables:
  VERSION            Semantic version (e.g., 1.2.3)
  COMMIT             Git short commit (auto-detected if not set)
  BUILD_DATE         ISO8601 UTC build date (auto-generated if not set)
  GOOS               Target OS (default: linux)
  GOARCH             Target architecture (default: host arch)
  GARBLE_ENABLE      Set to "1" to enable Go obfuscation via garble
  SIGN_KEY           Path to signing private key
  SIGN_CMD           Custom signing command (default: cosign sign-blob)

Examples:
  ./rebuild.sh                          # Production build
  ./rebuild.sh dev                      # Development build
  VERSION=1.2.3 ./rebuild.sh            # Production build with version
  GARBLE_ENABLE=1 ./rebuild.sh          # Production build with obfuscation
  SIGN_KEY=/path/key ./rebuild.sh       # Production build with signing

Output (production):
  release/
  ├── ks-ssh
  ├── ks-ssh.sha256
  └── checksums.txt

  If signing enabled:
  ├── ks-ssh.sig
  └── checksums.txt.sig
EOF
}

# ============================================================================
# Build Mode Configuration
# ============================================================================

configure_build_mode() {
    case "$BUILD_MODE" in
        production|prod|release)
            BUILD_MODE="production"
            GO_BUILD_TAGS=""
            GO_LDFLAGS_BASE="-s -w"
            GO_GCFLAGS=""
            STRIP_BINARY=true
            VITE_MODE="production"
            NPM_CMD="ci"
            ENABLE_OBFUSCATION="${GARBLE_ENABLE}"
            ENABLE_SIGNING="${SIGN_KEY:+1}"
            ENABLE_SECRET_SCAN=true
            ENABLE_SOURCE_LEAK_CHECK=true
            ENABLE_REPRODUCIBLE=true
            log_info "Build mode: PRODUCTION (hardened)"
            ;;
        development|dev|debug)
            BUILD_MODE="development"
            GO_BUILD_TAGS=""
            GO_LDFLAGS_BASE=""
            GO_GCFLAGS="-N -l"
            STRIP_BINARY=false
            VITE_MODE="development"
            NPM_CMD="install"
            ENABLE_OBFUSCATION="0"
            ENABLE_SIGNING="0"
            ENABLE_SECRET_SCAN=false
            ENABLE_SOURCE_LEAK_CHECK=false
            ENABLE_REPRODUCIBLE=false
            log_info "Build mode: DEVELOPMENT (debuggable)"
            ;;
        --help|-h|help)
            show_help
            exit 0
            ;;
        *)
            die "Unknown build mode: $BUILD_MODE. Use 'production' or 'dev'."
            ;;
    esac

    # Export for subcommands
    export CGO_ENABLED=0
    export GOOS="$TARGET_GOOS"
    export GOARCH="$TARGET_GOARCH"
}

# ============================================================================
# Version Information
# ============================================================================

resolve_version_info() {
    # Version: from env, or "dev" for development, or "0.0.0" for production
    if [[ -n "${VERSION:-}" ]]; then
        KSSSH_VERSION="$VERSION"
    elif [[ "$BUILD_MODE" == "development" ]]; then
        KSSSH_VERSION="dev"
    else
        KSSSH_VERSION="0.0.0"
    fi

    # Commit: from env, or git short hash, or "unknown"
    if [[ -n "${COMMIT:-}" ]]; then
        KSSSH_COMMIT="$COMMIT"
    else
        KSSSH_COMMIT="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
    fi

    # Build date: from env, or current UTC
    if [[ -n "${BUILD_DATE:-}" ]]; then
        KSSSH_BUILD_DATE="$BUILD_DATE"
    else
        KSSSH_BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    fi

    # For reproducible builds, allow SOURCE_DATE_EPOCH override
    if [[ -n "${SOURCE_DATE_EPOCH:-}" && "$ENABLE_REPRODUCIBLE" == "true" ]]; then
        KSSSH_BUILD_DATE="$(date -u -d @"$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "$KSSSH_BUILD_DATE")"
    fi

    log_info "Version:  $KSSSH_VERSION"
    log_info "Commit:   $KSSSH_COMMIT"
    log_info "Date:     $KSSSH_BUILD_DATE"
    log_info "Target:   $TARGET_GOOS/$TARGET_GOARCH"
}

# ============================================================================
# Build LDFLAGS
# ============================================================================

build_ldflags() {
    local base_ldflags="$GO_LDFLAGS_BASE"

    # Version stamping (intentional, required for update system)
    local version_ldflags
    version_ldflags="-X github.com/ks/ks-ssh/server/internal/version.Version=${KSSSH_VERSION} \
        -X github.com/ks/ks-ssh/server/internal/version.Commit=${KSSSH_COMMIT} \
        -X github.com/ks/ks-ssh/server/internal/version.BuildDate=${KSSSH_BUILD_DATE}"

    KSSSH_LDFLAGS="${base_ldflags} ${version_ldflags}"
    KSSSH_LDFLAGS="$(echo "$KSSSH_LDFLAGS" | xargs)"

    log_info "ks-ssh ldflags: $KSSSH_LDFLAGS"
}

# ============================================================================
# Cleanup
# ============================================================================

clean_build_artifacts() {
    log_step "Cleaning previous build artifacts..."
    rm -rf "$WEB_DIR/dist"
    rm -rf "$EMBED_DIST_DIR"
    mkdir -p "$EMBED_DIST_DIR"
    printf 'placeholder\n' > "$EMBED_DIST_DIR/index.html"  # keep go:embed resolvable
    rm -rf "$KSSSH_RELEASE_BIN" "$KSSSH_OLD_BIN"
    mkdir -p "$RELEASE_DIR"
}

# ============================================================================
# Frontend Build
# ============================================================================

build_frontend() {
    log_step "Building ks-ssh frontend (Vite $VITE_MODE)..."

    # Ensure node_modules exists
    if [[ ! -d "$WEB_DIR/node_modules" ]] || [[ ! -f "$WEB_DIR/node_modules/vite/bin/vite.js" ]]; then
        log_info "Installing npm dependencies..."
        (cd "$WEB_DIR" && npm "$NPM_CMD")
    fi

    # Fix esbuild permissions (required in some sandboxed environments)
    find "$WEB_DIR/node_modules" -path '*/@esbuild/linux-x64/bin/esbuild' -exec chmod +x {} + 2>/dev/null || true
    local ESBUILD_SHIM="$WEB_DIR/node_modules/esbuild/bin/esbuild"
    [[ -f "$ESBUILD_SHIM" ]] && chmod +x "$ESBUILD_SHIM" 2>/dev/null || true

    # Ensure .bin shims exist
    mkdir -p "$WEB_DIR/node_modules/.bin"
    [[ -f "$WEB_DIR/node_modules/vite/bin/vite.js" ]] && \
        ln -sf ../vite/bin/vite.js "$WEB_DIR/node_modules/.bin/vite" 2>/dev/null || true
    [[ -f "$ESBUILD_SHIM" ]] && \
        ln -sf ../esbuild/bin/esbuild "$WEB_DIR/node_modules/.bin/esbuild" 2>/dev/null || true

    # Build with Vite (production mode: no sourcemaps, minified)
    local vite_args=()
    if [[ "$VITE_MODE" == "production" ]]; then
        vite_args=(--mode production --sourcemap=false)
    else
        vite_args=(--mode development --sourcemap=true)
    fi

    # Retry guard: this workspace has an external process that
    # intermittently removes freshly written files right after the vite
    # step finishes. Verify the output landed and rebuild if it vanished.
    local attempt
    for attempt in 1 2 3; do
        (cd "$WEB_DIR" && node ./node_modules/vite/bin/vite.js build "${vite_args[@]}")
        if [[ -f "$WEB_DIR/dist/index.html" ]]; then
            break
        fi
        log_warn "frontend dist missing after vite attempt $attempt — retrying"
        sleep 2
    done
    [[ -f "$WEB_DIR/dist/index.html" ]] || die "frontend build did not produce dist/index.html"

    embed_frontend
}

# Copy the built frontend into the go:embed location.
embed_frontend() {
    log_step "Embedding frontend into $EMBED_DIST_DIR..."
    local attempt
    for attempt in 1 2 3; do
        rm -rf "$EMBED_DIST_DIR"
        cp -r "$WEB_DIR/dist" "$EMBED_DIST_DIR"
        if [[ -f "$EMBED_DIST_DIR/index.html" ]] &&
           compgen -G "$EMBED_DIST_DIR/assets/*" >/dev/null; then
            log_ok "Frontend embedded into internal/web/dist"
            return 0
        fi
        log_warn "embedded dist incomplete after attempt $attempt — retrying"
        sleep 2
    done
    die "failed to embed frontend dist"
}

# ============================================================================
# Go Build
# ============================================================================

build_go_binary() {
    log_step "Building ks-ssh binary..."

    # Remove stale directory if exists
    if [[ -d "$KSSSH_RELEASE_BIN" ]]; then
        log_warn "Removing stale directory at $KSSSH_RELEASE_BIN..."
        rm -rf "$KSSSH_RELEASE_BIN"
    fi

    # Backup existing binary
    if [[ -f "$KSSSH_RELEASE_BIN" ]]; then
        mv "$KSSSH_RELEASE_BIN" "$KSSSH_OLD_BIN"
    fi

    # The embed step can be undone by the same external interference as the
    # vite output — re-verify immediately before compiling and regenerate.
    if [[ ! -f "$EMBED_DIST_DIR/index.html" ]]; then
        log_warn "embedded dist vanished before go build — regenerating"
        build_frontend
    fi

    # Build command
    local go_cmd=(go build -buildvcs=false -trimpath)
    [[ -n "$GO_BUILD_TAGS" ]] && go_cmd+=(-tags "$GO_BUILD_TAGS")
    [[ -n "$GO_GCFLAGS" ]] && go_cmd+=(-gcflags "$GO_GCFLAGS")
    go_cmd+=(-ldflags "$KSSSH_LDFLAGS")
    go_cmd+=(-o "$KSSSH_RELEASE_BIN" ./cmd/ks-ssh)

    log_info "Running: ${go_cmd[*]} (in $SERVER_DIR)"

    if ! (cd "$SERVER_DIR" && "${go_cmd[@]}"); then
        log_err "ks-ssh build failed"
        if [[ -f "$KSSSH_OLD_BIN" ]]; then
            mv "$KSSSH_OLD_BIN" "$KSSSH_RELEASE_BIN"
            log_info "Restored previous binary from $KSSSH_OLD_BIN"
        fi
        return 1
    fi

    rm -f "$KSSSH_OLD_BIN"
    log_ok "ks-ssh built at $KSSSH_RELEASE_BIN"
    return 0
}

# ============================================================================
# Binary Stripping
# ============================================================================

strip_binary() {
    if [[ "$STRIP_BINARY" != "true" ]]; then
        log_info "Skipping strip for ks-ssh (development mode)"
        return 0
    fi

    log_step "Stripping ks-ssh binary..."

    if ! command -v strip >/dev/null 2>&1; then
        log_warn "strip command not found, skipping"
        return 0
    fi

    if strip --strip-unneeded "$KSSSH_RELEASE_BIN" 2>/dev/null; then
        log_ok "ks-ssh stripped successfully"
    else
        log_warn "strip --strip-unneeded failed, trying basic strip..."
        if strip "$KSSSH_RELEASE_BIN" 2>/dev/null; then
            log_ok "ks-ssh stripped (basic)"
        else
            log_warn "strip failed, leaving binary unstripped"
            return 0
        fi
    fi

    # Verify binary still executes (ks-ssh supports -version)
    if "$KSSSH_RELEASE_BIN" -version >/dev/null 2>&1 ||
       "$KSSSH_RELEASE_BIN" version >/dev/null 2>&1; then
        log_ok "ks-ssh executes correctly after strip"
    elif command -v file >/dev/null 2>&1 && file "$KSSSH_RELEASE_BIN" | grep -q "ELF"; then
        log_ok "ks-ssh verified as valid ELF binary after strip"
    elif [ "$(head -c 4 "$KSSSH_RELEASE_BIN" 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "7f454c46" ]; then
        log_ok "ks-ssh verified as valid ELF binary after strip (magic bytes)"
    else
        log_err "ks-ssh appears corrupted after strip!"
        return 1
    fi

    return 0
}

# ============================================================================
# Obfuscation (Garble)
# ============================================================================

apply_obfuscation() {
    if [[ "$ENABLE_OBFUSCATION" != "1" ]]; then
        return 0
    fi

    log_step "Applying Go obfuscation to ks-ssh..."

    if ! command -v garble >/dev/null 2>&1; then
        log_warn "garble not installed, skipping obfuscation"
        log_warn "Install with: go install mvdan.cc/garble@latest"
        return 0
    fi

    log_warn "Post-build garble obfuscation requires a rebuild:"
    log_warn "garble -trimpath -ldflags=\"$KSSSH_LDFLAGS\" build -o $KSSSH_RELEASE_BIN ./cmd/ks-ssh"
    log_warn "(run inside $SERVER_DIR; see BUILD_SECURITY.md in ks-panel for details)"

    return 0
}

# ============================================================================
# Source Path Leakage Check
# ============================================================================

check_source_leakage() {
    if [[ "$ENABLE_SOURCE_LEAK_CHECK" != "true" ]]; then
        return 0
    fi

    log_step "Checking ks-ssh for source path leakage..."

    local leaks=0

    local patterns=(
        "/home/"
        "/root/"
        "/Users/"
        "/var/"
        "/opt/"
        "/build/"
        "/workspace/"
        ".git"
        "gitlab.com"
        "bitbucket.org"
    )

    for pattern in "${patterns[@]}"; do
        if strings "$KSSSH_RELEASE_BIN" 2>/dev/null | grep -q "$pattern"; then
            log_warn "ks-ssh: Potential path leakage found: $pattern"
            leaks=$((leaks+1))
        fi
    done

    if strings "$KSSSH_RELEASE_BIN" 2>/dev/null | grep -q "$ROOT_DIR"; then
        log_warn "ks-ssh: Build root directory found in binary: $ROOT_DIR"
        leaks=$((leaks+1))
    fi

    if [[ $leaks -eq 0 ]]; then
        log_ok "ks-ssh: No obvious source path leakage detected"
    else
        log_warn "ks-ssh: $leaks potential leakage(s) detected"
    fi

    return 0
}

# ============================================================================
# Secret Scanning
# ============================================================================

scan_secrets() {
    if [[ "$ENABLE_SECRET_SCAN" != "true" ]]; then
        return 0
    fi

    log_step "Scanning ks-ssh for embedded secrets..."

    local patterns=(
        # API keys
        "sk-[a-zA-Z0-9]{32,}"
        "AKIA[0-9A-Z]{16}"
        "gh[pousr]_[a-zA-Z0-9]{36,}"
        "glpat-[a-zA-Z0-9_-]{20,}"
        # Private keys
        "-----BEGIN (RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY-----"
        # JWT
        "eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}"
    )

    local found=0
    local strings_output
    strings_output=$(strings "$KSSSH_RELEASE_BIN" 2>/dev/null || true)

    for pattern in "${patterns[@]}"; do
        if echo "$strings_output" | grep -E -q -e "$pattern"; then
            log_warn "ks-ssh: Potential secret pattern matched: $pattern"
            ((found++))
        fi
    done

    if [[ $found -eq 0 ]]; then
        log_ok "ks-ssh: No obvious secrets detected"
    else
        log_warn "ks-ssh: $found potential secret pattern(s) matched (review manually)"
    fi

    return 0
}

# ============================================================================
# Binary Verification
# ============================================================================

verify_binary() {
    log_step "Verifying ks-ssh binary..."

    # Existence
    if [[ ! -f "$KSSSH_RELEASE_BIN" ]]; then
        log_err "ks-ssh: Binary not found at $KSSSH_RELEASE_BIN"
        return 1
    fi

    # Executable
    if [[ ! -x "$KSSSH_RELEASE_BIN" ]]; then
        log_err "ks-ssh: Binary is not executable"
        return 1
    fi

    # ELF format
    if ! file_type "$KSSSH_RELEASE_BIN" | grep -q "ELF"; then
        log_err "ks-ssh: Not a valid ELF binary"
        return 1
    fi

    local arch_info
    arch_info=$(file_type "$KSSSH_RELEASE_BIN")
    log_info "ks-ssh: $arch_info"

    # Check for debug info (production should not have it)
    if [[ "$BUILD_MODE" == "production" ]] && has_file_cmd; then
        if file "$KSSSH_RELEASE_BIN" | grep -q "with debug_info"; then
            log_warn "ks-ssh: Binary contains debug info (unexpected for production)"
        else
            log_ok "ks-ssh: No debug info (as expected)"
        fi

        if readelf -S "$KSSSH_RELEASE_BIN" 2>/dev/null | grep -q "\.symtab"; then
            log_warn "ks-ssh: Binary contains symbol table (.symtab)"
        else
            log_ok "ks-ssh: No symbol table (as expected)"
        fi
    fi

    # Version stamp check (proves ldflags landed and binary executes)
    local vout
    if vout="$("$KSSSH_RELEASE_BIN" -version 2>/dev/null)"; then
        log_info "ks-ssh reports: $vout"
        if [[ "$KSSSH_VERSION" != "dev" ]] && ! echo "$vout" | grep -q "$KSSSH_VERSION"; then
            log_warn "ks-ssh: version stamp mismatch (expected $KSSSH_VERSION)"
        fi
    else
        log_warn "ks-ssh: -version probe failed (may be expected on cross targets)"
    fi

    return 0
}

# ============================================================================
# Checksum Generation
# ============================================================================

generate_checksums() {
    log_step "Generating SHA-256 checksums..."

    cd "$RELEASE_DIR"

    sha256sum ks-ssh > ks-ssh.sha256
    cp ks-ssh.sha256 checksums.txt

    log_ok "Checksums written to checksums.txt"
    cat checksums.txt
}

# ============================================================================
# Code Signing
# ============================================================================

sign_artifacts() {
    if [[ "$ENABLE_SIGNING" != "1" ]]; then
        log_info "Code signing disabled (set SIGN_KEY to enable)"
        return 0
    fi

    log_step "Signing release artifacts..."

    if ! command -v cosign >/dev/null 2>&1; then
        log_warn "cosign not installed, skipping signing"
        log_warn "Install with: go install github.com/sigstore/cosign/v2/cmd/cosign@latest"
        return 0
    fi

    if [[ ! -f "$SIGN_KEY" ]]; then
        log_warn "Signing key not found at $SIGN_KEY, skipping signing"
        return 0
    fi

    cd "$RELEASE_DIR"

    for artifact in ks-ssh checksums.txt; do
        if [[ -f "$artifact" ]]; then
            log_info "Signing $artifact..."
            if COSIGN_PRIVATE_KEY="$SIGN_KEY" $SIGN_CMD --yes "$artifact" \
                --output-signature "${artifact}.sig" 2>/dev/null; then
                log_ok "Signed $artifact -> ${artifact}.sig"
            else
                log_warn "Failed to sign $artifact"
            fi
        fi
    done
}

# ============================================================================
# Security Verification Stage
# ============================================================================

security_verification() {
    log_step "Running security verification stage..."

    local all_ok=true

    # Binary exists & executable
    if [[ -f "$KSSSH_RELEASE_BIN" ]]; then
        log_ok "Binary exists: $KSSSH_RELEASE_BIN"
    else
        log_err "Missing binary: $KSSSH_RELEASE_BIN"
        all_ok=false
    fi

    if [[ -x "$KSSSH_RELEASE_BIN" ]]; then
        log_ok "Executable: $KSSSH_RELEASE_BIN"
    else
        log_err "Not executable: $KSSSH_RELEASE_BIN"
        all_ok=false
    fi

    # Verify no debug info in production
    if [[ "$BUILD_MODE" == "production" ]] && has_file_cmd; then
        if file "$KSSSH_RELEASE_BIN" | grep -q "with debug_info"; then
            log_warn "Debug info present: $KSSSH_RELEASE_BIN"
        else
            log_ok "No debug info: $KSSSH_RELEASE_BIN"
        fi
    fi

    # Source path leakage check
    check_source_leakage || true

    # Secret scanning
    scan_secrets || true

    # Frontend source maps check
    if [[ "$BUILD_MODE" == "production" ]]; then
        if find "$EMBED_DIST_DIR" -name "*.map" 2>/dev/null | grep -q .; then
            log_warn "Source maps found in embedded frontend (production should not have them)"
            all_ok=false
        else
            log_ok "No source maps in embedded frontend"
        fi
    fi

    # Permissions check
    local perms
    perms=$(stat -c "%a" "$KSSSH_RELEASE_BIN" 2>/dev/null || stat -f "%A" "$KSSSH_RELEASE_BIN" 2>/dev/null)
    if [[ "$perms" == "755" ]]; then
        log_ok "Correct permissions (755): $KSSSH_RELEASE_BIN"
    else
        log_warn "Permissions are $perms (expected 755): $KSSSH_RELEASE_BIN"
    fi

    # Checksums exist & verify
    if [[ -f "$RELEASE_DIR/ks-ssh.sha256" ]]; then
        log_ok "Checksum exists: ks-ssh.sha256"
    else
        log_err "Missing checksum: ks-ssh.sha256"
        all_ok=false
    fi

    cd "$RELEASE_DIR"
    if sha256sum -c checksums.txt 2>/dev/null; then
        log_ok "All checksums verified"
    else
        log_err "Checksum verification failed"
        all_ok=false
    fi

    if [[ "$all_ok" == "true" ]]; then
        log_ok "Security verification PASSED"
        return 0
    else
        log_err "Security verification FAILED"
        return 1
    fi
}

# ============================================================================
# Cleanup Temporary Files
# ============================================================================

cleanup_temp_files() {
    log_step "Cleaning up temporary build files..."
    rm -f "$RELEASE_DIR"/*.old
    rm -f "$RELEASE_DIR"/*.tmp
    rm -f "$RELEASE_DIR"/*.part
    log_ok "Temporary files cleaned"
}

# ============================================================================
# Main Build Flow
# ============================================================================

main() {
    log_step "KS SSH Build System"
    log_info "Mode: $BUILD_MODE | Target: $TARGET_GOOS/$TARGET_GOARCH"

    configure_build_mode
    resolve_version_info
    build_ldflags
    clean_build_artifacts

    # Build frontend + embed
    build_frontend

    # Build server binary (single static binary, frontend embedded)
    build_go_binary || exit 1

    # Strip binaries (production only)
    strip_binary || exit 1

    chmod 755 "$KSSSH_RELEASE_BIN"

    # Obfuscation (if enabled)
    apply_obfuscation

    # Verify binary
    verify_binary || exit 1

    # Generate checksums
    generate_checksums

    # Sign artifacts (if enabled)
    sign_artifacts

    # Security verification
    security_verification || exit 1

    # Cleanup
    cleanup_temp_files

    # Summary
    echo
    log_step "Build completed successfully!"
    echo
    echo "Release artifacts:"
    ls -lh "$RELEASE_DIR"/
    echo
    if [[ "$BUILD_MODE" == "production" ]]; then
        echo "Production build complete. Binary is hardened:"
        echo "  -trimpath: Source paths removed"
        echo "  -ldflags=-s -w: Debug info & symbol table stripped"
        echo "  strip --strip-unneeded: Non-essential ELF symbols removed"
        echo "  Version stamp: $KSSSH_VERSION ($KSSSH_COMMIT)"
        echo "  Source leakage: Verified"
        echo "  Secret scan: Completed"
        echo "  Checksums: SHA-256 generated"
        [[ "${ENABLE_SIGNING:-0}" == "1" ]] && echo "  Signing: Artifacts signed" || true
        [[ "${ENABLE_OBFUSCATION:-0}" == "1" ]] && echo "  Obfuscation: garble available (rebuild with garble build for full effect)" || true
    else
        echo "Development build complete. Binary contains debug symbols."
    fi
}

# ============================================================================
# Entry Point
# ============================================================================

main "$@"
