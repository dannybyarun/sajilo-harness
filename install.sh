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
#
# Options:
#   --help         this text
#   --status       report what is installed; change nothing
#   --no-tunnel    do not install the rotatable WARP tunnel (the relay then
#                  resets the identity instead of rotating the exit IP)
#   --run          start Sajilo at the end without asking
#   --no-run       install only, do not start Sajilo
#   --uninstall    remove the instance and the launcher from PATH
#   --yes         do not ask for confirmation
set -u

REPO_URL=${SAJILO_REPO_URL:-https://raw.githubusercontent.com/dannybyarun/sajilo-harness/main}

# ---------------------------------------------------------------- arguments
MODE=install
SKIP_TUNNEL=${SAJILO_SKIP_TUNNEL:-0}
ASSUME_YES=0
LAUNCH=ask

usage() {
  cat <<'EOF'
install.sh - one-click installer for Sajilo (Linux / macOS / WSL / Git Bash)

  bash install.sh                 install (or reinstall) the instance
  bash install.sh --run           install and start Sajilo without asking
  bash install.sh --no-run        install only, do not start Sajilo
  bash install.sh --status        report what is installed; change nothing
  bash install.sh --no-tunnel     install without the rotatable WARP tunnel
  bash install.sh --uninstall     remove the instance and the launcher
  bash install.sh --help          this text

What it does:
  - creates the instance layout under ~/.sajilo (own HOME, DB, sessions,
    project dir, relay port, pins, logs)
  - installs the relay plugin and the harness spec (your own prompt and
    tools are never overwritten - a new one lands next to it as *.bak)
  - puts the sajilo launcher on your PATH and drops a desktop launcher
  - uses your existing opencode, or downloads one into the instance
  - installs the rotatable WARP tunnel (usque) if it is missing; skip that
    step with --no-tunnel
  - starts Sajilo when it is done (a terminal asks first)

Nothing of yours is touched: the instance keeps its own HOME, its own
database and its own ports.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --status) MODE=status ;;
    --uninstall) MODE=uninstall ;;
    --no-tunnel | --skip-tunnel) SKIP_TUNNEL=1 ;;
    --run) LAUNCH=always ;;
    --no-run | --nostart) LAUNCH=never ;;
    -y | --yes) ASSUME_YES=1 ;;
    *)
      printf 'install: unknown option "%s" (try --help)\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

# Where does this script live? When it is piped into bash there is no script
# directory at all ($0 is just "bash"), so the plugin is fetched from the
# repository instead. Never fall back to the current directory: that would
# silently pick up a stray plugin/ folder.
#
# A RELATIVE path ("bash install.sh", the documented way to install from a
# clone) must still resolve to the clone - otherwise the installer downloads
# the plugin from a branch URL that can serve a stale copy, and the files
# next to it are ignored. So: a name without a slash is a file in the
# current directory if it exists, and "bash" (piped) is not a file at all.
if [ -n "${BASH_VERSION:-}" ]; then
  SELF="${BASH_SOURCE[0]:-$0}"
else
  SELF="$0"
fi
case "$SELF" in
  /*) ;;
  */*) SELF="$PWD/${SELF#./}" ;;
  *)
    if [ -f "$SELF" ]; then
      SELF="$PWD/$SELF"
    else
      SELF=""
    fi
    ;;
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
# Progress messages that must not pollute stdout. download_opencode runs
# inside a command substitution, so anything it printed to stdout would be
# captured as part of the path it returns - and that is how the pin file
# ended up holding log lines instead of a path.
say_err() { printf 'install: %s\n' "$*" >&2; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

# This is the Linux/macOS installer; Windows has its own (install.cmd ->
# install.ps1) and its own launcher (sajilo.cmd). Running THIS one from Git
# Bash would not fail loudly - $HOME is C:\Users\<you>, so ROOT resolves to the
# SAME ~/.sajilo the cmd launcher uses. It would copy the unix helpers over the
# instance's bin, link a launcher into ~/.local/bin and append a PATH line to
# ~/.bashrc and ~/.profile that nothing on Windows reads. Refuse instead, and
# leave --status alone: that one only reads.
case "$(uname -s 2>/dev/null)" in
  MINGW* | MSYS* | CYGWIN*)
    [ "$MODE" = "status" ] ||
      die "this is the Linux/macOS installer - on Windows run install.cmd instead (it installs the same instance under %USERPROFILE%\\.sajilo)"
    ;;
esac

# ------------------------------------------------------------------ status
status_report() {
  printf 'root        : %s\n' "$ROOT"
  printf 'plugin      : %s\n' "$([ -f "$PLUGIN_DIR/sajilo-relay.ts" ] && echo 'installed' || echo 'MISSING')"
  printf 'prompt      : %s\n' "$([ -f "$PLUGIN_DIR/resources/agent-prompt.txt" ] && echo 'installed' || echo 'MISSING')"
  printf 'tools       : %s\n' "$([ -f "$PLUGIN_DIR/resources/agent-tools.json" ] && echo 'installed' || echo 'MISSING')"
  printf 'overlay     : %s\n' "$([ -f "$PLUGIN_DIR/resources/sajilo-overlay.md" ] && echo 'installed' || echo 'MISSING')"
  printf 'launcher    : %s\n' "$([ -x "$BIN_DIR/sajilo" ] && echo "$BIN_DIR/sajilo" || echo 'MISSING')"
  printf 'on PATH     : %s\n' "$([ -x "$HOME/.local/bin/sajilo" ] && echo "$HOME/.local/bin/sajilo" || echo 'not linked')"
  # The runtime this instance is pinned to. The pin is one path per line -
  # but an old pin file written by a broken installer can hold log lines as
  # well, so take the first line that is actually an executable.
  pinned_path() {
    local line
    while IFS= read -r line; do
      [ -n "$line" ] && [ -x "$line" ] && {
        printf '%s\n' "$line"
        return 0
      }
    done <"$1" 2>/dev/null
    return 1
  }
  printf 'runtime     : %s\n' "$(pinned_path "$STATE/sajilo-bin.txt" || echo 'not pinned')"
  printf 'tunnel      : %s\n' "$(head -n 1 "$STATE/tunnel.txt" 2>/dev/null || echo 'unknown')"
}

if [ "$MODE" = "status" ]; then
  status_report
  exit 0
fi

# ---------------------------------------------------------------- uninstall
if [ "$MODE" = "uninstall" ]; then
  printf 'This removes:\n'
  printf '  %s\n' "$ROOT"
  printf '  %s\n' "$HOME/.local/bin/sajilo"
  printf 'Your opencode, its config and its sessions are NOT touched.\n'
  if [ "$ASSUME_YES" != "1" ]; then
    printf 'Type "yes" to continue: '
    read -r answer || answer=""
    [ "$answer" = "yes" ] || {
      printf 'install: left everything alone\n'
      exit 0
    }
  fi
  # Only ever the instance dir and the symlink the installer made.
  if [ -e "$HOME/.local/bin/sajilo" ] && [ -L "$HOME/.local/bin/sajilo" ]; then
    rm -f "$HOME/.local/bin/sajilo"
    say "launcher removed from PATH -> $HOME/.local/bin/sajilo"
  fi
  if [ -d "$ROOT" ]; then
    # The harness spec (the prompt, the tools, the overlay) is the USER'S
    # own work - it may have been edited in the instance. A copy goes out
    # before the instance goes: removing the instance must never throw
    # their work away.
    if [ -d "$PLUGIN_DIR/resources" ]; then
      backup="$HOME/.sajilo-spec-backup-$(date +%Y%m%d-%H%M%S)"
      if mkdir -p "$backup" 2>/dev/null && cp -f "$PLUGIN_DIR"/resources/* "$backup/" 2>/dev/null; then
        say "harness spec saved -> $backup"
      fi
    fi
    rm -rf "$ROOT"
    say "instance removed -> $ROOT"
  fi
  say "uninstalled"
  exit 0
fi

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

# The harness spec (prompt + tools + overlay) is the USER'S. Never overwrite
# it: the gateway checks the prompt's structure, so a clobbered spec can
# silently break the harness (every request 429s). A new spec is only
# installed when the instance does not have one yet.
SPEC_FILES="agent-prompt.txt agent-tools.json title-prompt.txt sajilo-overlay.md"

install_spec() {
  # install_spec <source-dir> - copy the spec, keeping the user's version.
  local src_dir="$1" f src dst
  for f in $SPEC_FILES; do
    src="$src_dir/$f"
    dst="$PLUGIN_DIR/resources/$f"
    [ -f "$src" ] || continue
    if [ -f "$dst" ]; then
      if ! cmp -s "$src" "$dst"; then
        # The NEW upstream spec goes next to the user's one - never on top
        # of it. (Copying the other way round would park a copy of the
        # user's own file at .bak and throw the new spec away.)
        cp -f "$src" "$dst.bak"
        say "kept your harness spec ($f) - the new one is at $dst.bak"
      fi
      continue
    fi
    cp -f "$src" "$dst"
  done
}

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
  install_spec "$HERE/plugin/resources"
  say "relay plugin installed -> $PLUGIN_DIR"
  say "harness spec        -> $PLUGIN_DIR/resources (yours to edit)"
else
  say "relay plugin not found next to the installer - downloading it"
  command -v curl >/dev/null 2>&1 || die "curl is required to download the relay plugin"
  if curl -fsSL "$REPO_URL/plugin/sajilo-relay.ts" -o "$PLUGIN_DIR/sajilo-relay.ts"; then
    for f in $SPEC_FILES; do
      curl -fsSL "$REPO_URL/plugin/resources/$f" -o "$PLUGIN_DIR/resources/$f" 2>/dev/null || true
    done
    say "relay plugin downloaded -> $PLUGIN_DIR"
  else
    fetch_bundle || die "could not download the relay plugin"
    cp -f "$BUNDLE_DIR/plugin/sajilo-relay.ts" "$PLUGIN_DIR/" \
      || die "the release bundle has no relay plugin"
    install_spec "$BUNDLE_DIR/plugin/resources"
    say "relay plugin installed from the release bundle -> $PLUGIN_DIR"
  fi
fi

# ---------------------------------------------------------------- launcher
LAUNCHER_FILES="warp-rotate.sh tunnel-watchdog.sh usque-rotate.ps1 usque-rotate.cmd sajilo-rebrand.sh sajilo-rebrand.ps1 sajilo-relay.ts sajilo-doctor.ts"

install_launcher() {
  # install_launcher <source-root> - the launcher and its helpers.
  local src_root="$1" f
  cp -f "$src_root/sajilo" "$BIN_DIR/sajilo"
  for f in $LAUNCHER_FILES; do
    [ -f "$src_root/bin/$f" ] && cp -f "$src_root/bin/$f" "$BIN_DIR/"
  done
}

if [ -n "$HERE" ] && [ -f "$HERE/sajilo" ]; then
  install_launcher "$HERE"
elif curl -fsSL "$REPO_URL/sajilo" -o "$BIN_DIR/sajilo"; then
  for f in $LAUNCHER_FILES; do
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

# The launcher runs with "set -u": a typo in a variable name is a crash on
# the first run, not a warning. Parse it here, where the user can read it.
bash -n "$BIN_DIR/sajilo" || die "the installed launcher does not parse - look at $BIN_DIR/sajilo"

# ---------------------------------------------------------------- tunnel
# The rotatable tunnel is what makes a NEW exit IP - and a new exit IP is
# a new quota bucket.
#
# usque is a user-space WARP MASQUE client: one binary, one config file, one
# HTTP proxy. Installing it is downloading a binary; rotating it is writing a
# config file. NO administrator rights, NO service, NO systemd unit - so
# nothing here asks the user to do anything.
#
# The launcher (sajilo) registers it and runs it for this instance; the
# rotator gives it a new identity.
#
# Best effort: the relay works without a tunnel (it resets the identity
# instead), so a failure here NEVER fails the install.
USQUE_VERSION="${USQUE_VERSION:-v4.2.1}"
USQUE_BASE="https://github.com/Diniboy1123/usque/releases/download/${USQUE_VERSION}"
USQUE_BIN="$BIN_DIR/usque"

usque_asset() {
  os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
  case "$os" in
    linux) os=linux ;;
    darwin) os=darwin ;;
    *) return 1 ;;
  esac
  arch=$(uname -m 2>/dev/null)
  case "$arch" in
    x86_64 | amd64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  echo "usque_${USQUE_VERSION#v}_${os}_${arch}.zip"
}

install_usque() {
  asset=$(usque_asset) || {
    say "tunnel: no usque build for this platform"
    return 1
  }
  tmp=$(mktemp -d 2>/dev/null || echo "$TMPDIR/sajilo-usque.$$")
  mkdir -p "$tmp"
  ok=1
  curl -fsSL --max-time 180 -o "$tmp/$asset" "$USQUE_BASE/$asset" 2>/dev/null || ok=0
  curl -fsSL --max-time 60 -o "$tmp/checksums.txt" "$USQUE_BASE/checksums.txt" 2>/dev/null || ok=0
  if [ "$ok" != "1" ]; then
    say "tunnel: could not download usque ($asset)"
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  fi
  # Verify the download against the release's checksums.
  want=$(grep " $asset\$" "$tmp/checksums.txt" 2>/dev/null | awk '{print $1}' | head -1)
  got=$(sha256sum "$tmp/$asset" 2>/dev/null | awk '{print $1}')
  if [ -n "$want" ] && [ "$want" != "$got" ]; then
    say "tunnel: the usque checksum does not match - refusing to install it"
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  fi
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$tmp/$asset" -d "$tmp/x" 2>/dev/null || true
  else
    python3 -m zipfile -e "$tmp/$asset" "$tmp/x" 2>/dev/null || true
  fi
  bin=$(find "$tmp/x" -maxdepth 2 -name usque -type f 2>/dev/null | head -1)
  if [ -z "$bin" ]; then
    say "tunnel: the usque archive has no binary"
    rm -rf "$tmp" 2>/dev/null || true
    return 1
  fi
  cp -f "$bin" "$USQUE_BIN" && chmod +x "$USQUE_BIN"
  rm -rf "$tmp" 2>/dev/null || true
  return 0
}

if [ "$SKIP_TUNNEL" = "1" ]; then
  say "tunnel skipped (--no-tunnel) - the relay will use the machine's own egress"
  echo "skipped by --no-tunnel" >"$STATE/tunnel.txt"
elif command -v usque >/dev/null 2>&1 || [ -x "$USQUE_BIN" ]; then
  say "tunnel: usque is available ($(command -v usque || echo "$USQUE_BIN")) - a rotation is a new exit IP, no admin needed"
  echo "usque: $(command -v usque || echo "$USQUE_BIN")" >"$STATE/tunnel.txt"
else
  say "tunnel: installing usque (a user-space WARP client - no administrator rights, no systemd)"
  if install_usque; then
    say "tunnel: usque installed -> $USQUE_BIN - the launcher starts it for this instance"
    echo "usque: $USQUE_BIN" >"$STATE/tunnel.txt"
  else
    say "tunnel: not available - the relay resets the identity instead (one bucket, not two)"
    echo "unavailable" >"$STATE/tunnel.txt"
  fi
fi

# ---------------------------------------------------------------- opencode
find_opencode() {
  if [ "${SAJILO_FORCE_DOWNLOAD:-}" = "1" ]; then
    return 1
  fi
  if [ -n "${SAJILO_BIN:-}" ] && [ -x "${SAJILO_BIN}" ]; then
    echo "$SAJILO_BIN"
    return 0
  fi
  if [ -n "${OPENCODE_BIN:-}" ] && [ -x "${OPENCODE_BIN}" ]; then
    echo "$OPENCODE_BIN"
    return 0
  fi
  # The runtime this instance is ALREADY pinned to. A reinstall must not
  # quietly change the runtime under the user: the pin exists exactly so
  # that every sajilo session starts the same binary. Only when that
  # binary is gone does the search continue.
  if [ -s "$STATE/sajilo-bin.txt" ]; then
    pinned=$(head -n 1 "$STATE/sajilo-bin.txt" 2>/dev/null || true)
    if [ -n "$pinned" ] && [ -x "$pinned" ]; then
      echo "$pinned"
      return 0
    fi
  fi
  if command -v opencode >/dev/null 2>&1; then
    command -v opencode
    return 0
  fi
  for c in "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode" \
    "/usr/local/bin/opencode" "/opt/homebrew/bin/opencode"; do
    [ -x "$c" ] && {
      echo "$c"
      return 0
    }
  done
  # The instance's OWN copy, from an earlier install. Without this a
  # reinstall on a machine with no system opencode would download the
  # runtime again - a ~250 MB fetch for a binary that is already there.
  if [ -x "$BIN_DIR/opencode" ]; then
    echo "$BIN_DIR/opencode"
    return 0
  fi
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
    MINGW* | MSYS* | CYGWIN*) os=windows ;;
    *) os=linux ;;
  esac
  arch=$(uname -m)
  case "$arch" in
    aarch64 | arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
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
    candidates="$base$base_alt$musl$suffix $base$musl$suffix $base$baseline$suffix $base$suffix"
  fi

  tmp=$(mktemp -d 2>/dev/null || echo "$TMPDIR/sajilo-install.$$")
  mkdir -p "$tmp"
  for url in $candidates; do
    say_err "no opencode on this machine - downloading the standalone binary"
    say_err "  $url"
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
# launched it. The pin is ONE line and nothing else: the launcher reads it
# with "head -n 1", so a log line in there would send it looking for a
# binary called "install: ...".
case "$bin" in
  /*) ;;
  *) bin=$(cd "$(dirname "$bin")" 2>/dev/null && pwd)/$(basename "$bin") ;;
esac
[ -n "$bin" ] && [ -x "$bin" ] || die "the runtime is not an executable file: '$bin'"
printf '%s\n' "$bin" >"$STATE/sajilo-bin.txt"
say "runtime binary pinned -> $STATE/sajilo-bin.txt"

# ------------------------------------------------------------------ PATH
# "One click" has to mean the command works afterwards - in THIS shell and
# in every new one. Two things do that:
#
#   1. a launcher in a directory that is ALREADY on PATH (best effort: it
#      needs write access there, which a normal user often does not have),
#   2. ~/.local/bin on PATH through the shell rc files.
#
# The rc check has to look for an ACTIVE export. A commented-out line
# ("# export PATH=...$HOME/.local/bin:...") is not one - matching it is how
# the launcher ends up never being added at all.
mkdir -p "$HOME/.local/bin"
ln -sf "$BIN_DIR/sajilo" "$HOME/.local/bin/sajilo" 2>/dev/null || true
say "launcher linked -> $HOME/.local/bin/sajilo"

PATH_DIR=""
for d in /usr/local/bin /usr/bin; do
  [ -d "$d" ] && [ -w "$d" ] || continue
  case ":$PATH:" in
    *":$d:"*) ;;
    *) continue ;;
  esac
  if ln -sf "$BIN_DIR/sajilo" "$d/sajilo" 2>/dev/null; then
    PATH_DIR="$d"
    break
  fi
done
if [ -n "$PATH_DIR" ]; then
  say "launcher linked -> $PATH_DIR/sajilo (already on PATH - it works right now)"
fi

has_path_export() {
  grep -qE '^[[:space:]]*export[[:space:]]+PATH=.*\.local/bin' "$1" 2>/dev/null
}

case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    # Every shell rc that exists gets the line - not just the first one.
    # A user with both zsh and bash should not have to run the installer
    # twice.
    touched=""
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      if ! has_path_export "$rc"; then
        printf '\n# sajilo\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$rc"
        say "added $HOME/.local/bin to $rc"
      fi
      touched="$touched $rc"
    done
    # No rc file at all: make a profile so the PATH survives the next login.
    if [ -z "$touched" ]; then
      printf '\n# sajilo\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$HOME/.profile"
      say "added $HOME/.local/bin to $HOME/.profile"
    fi
    ;;
esac

# ---------------------------------------------------------------- desktop
# A double-clickable entry: in the app menu and on the desktop when there is
# one. The Exec path is quoted - a HOME with a space in it would otherwise
# produce a desktop entry that does nothing when it is clicked.
write_desktop() {
  local dst="$1"
  mkdir -p "$(dirname "$dst")" 2>/dev/null || true
  cat >"$dst" <<EOF
[Desktop Entry]
Type=Application
Name=Sajilo
Comment=Sajilo - a coding agent harness of its own
Exec="$BIN_DIR/sajilo"
Terminal=true
Categories=Development;Utility;
Icon=terminal
EOF
  chmod +x "$dst" 2>/dev/null || true
}

APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
if [ -d "$APPS_DIR" ] || mkdir -p "$APPS_DIR" 2>/dev/null; then
  write_desktop "$APPS_DIR/sajilo.desktop"
  say "app menu entry      -> $APPS_DIR/sajilo.desktop"
fi
if [ -d "$HOME/Desktop" ]; then
  write_desktop "$HOME/Desktop/sajilo.desktop"
  say "desktop launcher    -> $HOME/Desktop/sajilo.desktop"
fi

# ------------------------------------------------------------------ launch
# One click means one click: after the install, Sajilo starts - exactly what
# the Windows installer does. A terminal asks first; --run never asks;
# --no-run never starts.
launch_sajilo() {
  local target="$1"
  if [ "$LAUNCH" = "never" ]; then
    return 0
  fi
  if [ "$LAUNCH" != "always" ]; then
    # Only ask when there is a person on the other end. When the installer
    # is piped into bash, stdin is the script itself.
    [ -t 0 ] && [ -t 1 ] || return 0
    printf 'Start Sajilo now? [Y/n] '
    read -r answer || answer=""
    case "$answer" in
      n | N | no | No | NO) return 0 ;;
    esac
  fi
  cd "$target" 2>/dev/null || cd "$HOME" 2>/dev/null || true
  say "starting Sajilo in $PWD"
  exec "$BIN_DIR/sajilo"
}

# ------------------------------------------------------------------ done
printf '\n'
say "done"
printf '\n'
printf '  sajilo             # interactive\n'
printf '  sajilo run "hi"    # headless\n'
printf '  sajilo status      # what is running\n'
printf '\n'
if [ -n "$PATH_DIR" ]; then
  printf '  sajilo is on your PATH already - no new terminal needed.\n'
else
  printf '  Open a NEW terminal so the PATH change takes effect. sajilo has its\n'
  printf '  own HOME, database, sessions, project, relay (43915), pins and logs -\n'
  printf '  it cannot affect any opencode you are already running.\n'
fi
printf '\n'

launch_sajilo "$PWD"
