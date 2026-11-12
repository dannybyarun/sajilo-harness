#!/usr/bin/env bash
# install.sh - one-click installer for Linux / macOS / WSL / Git Bash.
#
#   curl -fsSL https://raw.githubusercontent.com/dannybyarun/sajilo-harness/main/install.sh | bash
#
# or, from a clone:
#
#   bash install.sh
#
# Creates the instance layout, installs the relay plugin, the launcher and the
# opencode binary (it downloads one if this machine has none), puts the
# launcher on PATH and drops a desktop launcher. Nothing to configure by hand.
set -u

REPO_URL=${SAJILO_REPO_URL:-https://raw.githubusercontent.com/dannybyarun/sajilo-harness/main}

# Where does this script live? When it is piped into bash there is no script
# directory at all ($0 is just "bash"), so the plugin is fetched from the
# repository instead. Never fall back to the current directory: that would
# silently pick up a stray plugin/ folder.
if [ -n "${BASH_VERSION:-}" ]; then
  SELF="${BASH_SOURCE[0]:-$0}"
else
  SELF="$0"
fi
case "$SELF" in
  */*) ;;
  *) SELF="" ;;
esac
HERE=""
if [ -n "$SELF" ]; then
  HERE=$(cd "$(dirname "$SELF")" 2>/dev/null && pwd) || HERE=""
fi
[ -f "$HERE/plugin/sajilo-relay.ts" ] || HERE=""

ROOT=${SAJILO_ROOT:-$HOME/.sajilo}
HOME_DIR="$ROOT/home"
PLUGIN_DIR="$HOME_DIR/.config/opencode/plugin"
STATE="$ROOT/state"
BIN_DIR="$ROOT/bin"
WORK_DIR="$ROOT/work"

say() { printf 'install: %s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

mkdir -p "$PLUGIN_DIR/resources" "$STATE" "$WORK_DIR" "$ROOT/mint" "$BIN_DIR" \
  "$ROOT/tunnel" || die "could not create the layout under $ROOT"
say "root -> $ROOT"

# ------------------------------------------------------------------ plugin
# Three sources, in order: the files next to this script, the repository, and
# the published release bundle. The release bundle is the fallback because a
# branch URL on the raw CDN can serve a stale copy for minutes after a push,
# and a fresh user must never get a broken install.
RELEASE_URL=${SAJILO_RELEASE_URL:-https://github.com/dannybyarun/sajilo-harness/releases/latest/download/sajilo-bootstrap.tar.gz}
BUNDLE_DIR=""

fetch_bundle() {
  command -v curl >/dev/null 2>&1 || return 1
  command -v tar >/dev/null 2>&1 || return 1
  local tmp
  tmp=$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/sajilo-bundle.$$")
  mkdir -p "$tmp"
  say "falling back to the release bundle -> $RELEASE_URL"
  if ! curl -fsSL "$RELEASE_URL" -o "$tmp/pkg.tar.gz"; then
    rm -rf "$tmp"
    return 1
  fi
  if ! tar -xzf "$tmp/pkg.tar.gz" -C "$tmp"; then
    rm -rf "$tmp"
    return 1
  fi
  rm -f "$tmp/pkg.tar.gz"
  BUNDLE_DIR="$tmp"
  return 0
}

if [ -n "$HERE" ] && [ -f "$HERE/plugin/sajilo-relay.ts" ]; then
  cp -f "$HERE/plugin/sajilo-relay.ts" "$PLUGIN_DIR/"
  # The harness spec (prompt + tools) is the USER'S. Never overwrite it: the
  # gateway checks the prompt's structure, so a clobbered spec can silently
  # break the harness (every request 429s). A new spec is only installed when
  # the instance does not have one yet.
  for f in agent-prompt.txt agent-tools.json title-prompt.txt sajilo-overlay.md; do
    src="$HERE/plugin/resources/$f"
    dst="$PLUGIN_DIR/resources/$f"
    [ -f "$src" ] || continue
    if [ -f "$dst" ]; then
      if ! cmp -s "$src" "$dst"; then
        cp -f "$dst" "$dst.bak"
        say "kept your harness spec ($f) - the new one is at $dst.bak"
      fi
      continue
    fi
    cp -f "$src" "$dst"
  done
  say "relay plugin installed -> $PLUGIN_DIR"
else
  say "relay plugin not found next to the installer - downloading it"
  command -v curl >/dev/null 2>&1 || die "curl is required to download the relay plugin"
  if curl -fsSL "$REPO_URL/plugin/sajilo-relay.ts" -o "$PLUGIN_DIR/sajilo-relay.ts"; then
    for f in agent-prompt.txt agent-tools.json title-prompt.txt; do
      curl -fsSL "$REPO_URL/plugin/resources/$f" -o "$PLUGIN_DIR/resources/$f" 2>/dev/null || true
    done
    say "relay plugin downloaded -> $PLUGIN_DIR"
  else
    fetch_bundle || die "could not download the relay plugin"
    cp -f "$BUNDLE_DIR/plugin/sajilo-relay.ts" "$PLUGIN_DIR/" \
      || die "the release bundle has no relay plugin"
    cp -f "$BUNDLE_DIR"/plugin/resources/* "$PLUGIN_DIR/resources/" 2>/dev/null || true
    say "relay plugin installed from the release bundle -> $PLUGIN_DIR"
  fi
fi

# ---------------------------------------------------------------- launcher
if [ -n "$HERE" ] && [ -f "$HERE/sajilo" ]; then
  cp -f "$HERE/sajilo" "$BIN_DIR/sajilo"
  for f in warp-rotate.sh tunnel-watchdog.sh sajilo-rebrand.sh sajilo-rebrand.ps1 sajilo-relay.ts sajilo-doctor.ts; do
    [ -f "$HERE/bin/$f" ] && cp -f "$HERE/bin/$f" "$BIN_DIR/"
  done
elif curl -fsSL "$REPO_URL/sajilo" -o "$BIN_DIR/sajilo"; then
  for f in warp-rotate.sh tunnel-watchdog.sh sajilo-rebrand.sh sajilo-rebrand.ps1 sajilo-relay.ts sajilo-doctor.ts; do
    curl -fsSL "$REPO_URL/bin/$f" -o "$BIN_DIR/$f" 2>/dev/null || true
  done
else
  [ -n "$BUNDLE_DIR" ] || fetch_bundle || die "could not download the launcher"
  cp -f "$BUNDLE_DIR/sajilo" "$BIN_DIR/sajilo" || die "the release bundle has no launcher"
  cp -f "$BUNDLE_DIR"/bin/*.sh "$BIN_DIR/" 2>/dev/null || true
  say "launcher installed from the release bundle -> $BIN_DIR/sajilo"
fi
chmod +x "$BIN_DIR/sajilo" 2>/dev/null || true
chmod +x "$BIN_DIR"/*.sh 2>/dev/null || true
say "launcher installed -> $BIN_DIR/sajilo"

# ---------------------------------------------------------------- opencode
find_opencode() {
  if [ "${SAJILO_FORCE_DOWNLOAD:-}" = "1" ]; then
    return 1
  fi
  if [ -n "${SAJILO_BIN:-}" ] && [ -x "$SAJILO_BIN" ]; then
    echo "$SAJILO_BIN"
    return 0
  fi
  if [ -n "${OPENCODE_BIN:-}" ] && [ -x "$OPENCODE_BIN" ]; then
    echo "$OPENCODE_BIN"
    return 0
  fi
  if command -v opencode >/dev/null 2>&1; then
    command -v opencode
    return 0
  fi
  for c in "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode" \
    "/usr/local/bin/opencode" "/opt/homebrew/bin/opencode"; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

# The standalone build is the fallback when this machine has no opencode at
# all. Pick the binary that matches the libc and the CPU.
download_opencode() {
  command -v curl >/dev/null 2>&1 || die "curl is required to download opencode"
  raw_os=$(uname -s)
  case "$raw_os" in
    Darwin*) os=darwin ;;
    Linux*) os=linux ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *) os=linux ;;
  esac
  arch=$(uname -m)
  case "$arch" in
    aarch64|arm64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
  esac
  base="https://opencode.ai/update/api/latest/cli/opencode/opencode-$os-$arch"
  suffix=".tar.gz"
  [ "$os" = windows ] && suffix=".zip"

  candidates="$base$suffix"
  if [ "$os" = linux ]; then
    musl=""
    if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
      musl="-musl"
    fi
    base_alt=""
    if [ "$arch" = x64 ] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
      base_alt="-baseline"
    fi
    candidates="$base$base_alt$musl$suffix $base$musl$suffix $base$base_alt$suffix $base$suffix"
  fi

  tmp=$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/sajilo-install.$$")
  mkdir -p "$tmp"
  for url in $candidates; do
    say "no opencode on this machine - downloading the standalone binary"
    say "  $url"
    if ! curl -fsSL "$url" -o "$tmp/opencode-bin"; then
      continue
    fi
    if [ "$suffix" = ".zip" ]; then
      command -v unzip >/dev/null 2>&1 || die "unzip is required on Windows-like systems"
      unzip -oq "$tmp/opencode-bin" -d "$BIN_DIR" || die "could not unpack $url"
      binpath="$BIN_DIR/opencode.exe"
    else
      tar -xzf "$tmp/opencode-bin" -C "$tmp" || continue
      mv -f "$tmp/opencode" "$BIN_DIR/opencode" || continue
      binpath="$BIN_DIR/opencode"
    fi
    chmod +x "$binpath" 2>/dev/null || true
    rm -rf "$tmp"
    echo "$binpath"
    return 0
  done
  rm -rf "$tmp"
  return 1
}

if bin=$(find_opencode); then
  say "opencode found: $bin"
elif [ "${SAJILO_NO_DOWNLOAD:-}" = "1" ]; then
  die "opencode NOT found and SAJILO_NO_DOWNLOAD=1 - install it from https://opencode.ai"
else
  bin=$(download_opencode) || die "could not download opencode - install it from https://opencode.ai and re-run"
  say "opencode installed -> $bin"
fi

# Pin the exact binary so sajilo always starts the same one, whatever shell
# launched it.
printf '%s\n' "$bin" > "$STATE/sajilo-bin.txt"
say "runtime binary pinned -> $STATE/sajilo-bin.txt"

# ------------------------------------------------------------------ PATH
mkdir -p "$HOME/.local/bin"
ln -sf "$BIN_DIR/sajilo" "$HOME/.local/bin/sajilo" 2>/dev/null || true
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      grep -q '.local/bin' "$rc" 2>/dev/null || {
        printf '\n# sajilo\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
        say "added $HOME/.local/bin to $rc"
      }
      break
    done
    ;;
esac
say "launcher on PATH -> $HOME/.local/bin/sajilo"

# ------------------------------------------------------------------ desktop
if [ -d "$HOME/Desktop" ]; then
  cat > "$HOME/Desktop/sajilo.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=sajilo
Comment=A fully separate opencode instance
Exec=$BIN_DIR/sajilo
Terminal=true
Categories=Development;
EOF
  chmod +x "$HOME/Desktop/sajilo.desktop" 2>/dev/null || true
  say "desktop launcher created -> $HOME/Desktop/sajilo.desktop"
fi

# ------------------------------------------------------------------ done
printf '\n'
say "done"
printf '\n'
printf '  sajilo             # interactive\n'
printf '  sajilo run "hi"    # headless\n'
printf '  sajilo status      # what is running\n'
printf '\n'
printf '  Open a NEW terminal so the PATH change takes effect. sajilo has its\n'
printf '  own HOME, database, sessions, project, relay (43914), pins and logs -\n'
printf '  it cannot affect any opencode you are already running.\n'
printf '\n'
