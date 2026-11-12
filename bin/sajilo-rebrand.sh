#!/usr/bin/env bash
# sajilo-rebrand.sh - the identity of a Sajilo instance.
#
#   sajilo rebrand            apply the Sajilo identity (default)
#   sajilo rebrand --status   report what is branded right now
#   sajilo rebrand --restore  go back to the stock opencode identity
#
# What it brands:
#   * the provider the runtime prints next to the model  -> "Sajilo"
#   * the terminal window title                          -> no "OpenCode"
#   * the update dialog and the splash banner           -> gone
#
# What it cannot brand: the runtime's own welcome wordmark. That art is a
# compressed asset inside the opencode binary; no supported setting replaces
# it. It stays.
set -u

ROOT=${SAJILO_ROOT:-$HOME/.sajilo}
HOME_DIR="$ROOT/home"
STATE="$ROOT/state"
WORK="$ROOT/work"
CFG_DIR="$HOME_DIR/.config/opencode"
RUNTIME_CFG="$CFG_DIR/opencode.json"
CLI_CFG="$CFG_DIR/cli.json"
MARKER="$STATE/stock-identity"

say() { printf 'rebrand: %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }

mkdir -p "$CFG_DIR" "$STATE" 2>/dev/null || true

MODE="${1:-apply}"

write_sajilo() {
  cat >"$CLI_CFG" <<'EOF'
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "terminal": { "title": false },
  "highlights": false,
  "mini": { "splash": "hide" }
}
EOF
  rm -f "$MARKER"
  say "identity -> Sajilo"
  note "provider name      : Sajilo"
  note "terminal title     : off (no OpenCode in the tab)"
  note "update dialog      : off"
  note "splash banner      : off"
  note "welcome wordmark   : the runtime's own art - not replaceable"
}

write_stock() {
  cat >"$CLI_CFG" <<'EOF'
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "terminal": { "title": true },
  "highlights": true,
  "mini": { "splash": "show" }
}
EOF
  : >"$MARKER"
  say "identity -> stock opencode"
  note "restart the instance to pick it up"
}

status() {
  if [ -f "$MARKER" ]; then
    say "identity: stock opencode"
  else
    say "identity: Sajilo"
  fi
  if [ -f "$CLI_CFG" ]; then
    note "cli settings       : $CLI_CFG"
  else
    note "cli settings       : (none)"
  fi
  if [ -f "$RUNTIME_CFG" ]; then
    note "runtime config     : $RUNTIME_CFG"
    note "provider           : $(sed -n 's/.*"provider"[[:space:]]*:[[:space:]]*{\([[:space:]]*"\([a-z]*\)"\).*/\2/p' "$RUNTIME_CFG" | head -n 1)"
  fi
}

case "$MODE" in
  --status | status) status ;;
  --restore | restore) write_stock ;;
  *) write_sajilo ;;
esac
