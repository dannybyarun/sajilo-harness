#!/bin/bash
# tunnel-watchdog.sh (mobile) - proactive WARP tunnel keeper.
#
# The relay's rescue chain (warp-rotate.sh) only fires when an actual request
# fails, so a tunnel that dies while the user is not making requests stays
# down until the next burst of traffic. This watchdog flips that: it probes
# the local usque HTTP proxy and repairs it from a cold start when needed,
# so the tunnel is always up independent of traffic.
#
# Probe pass  ->  no-op, exits 0 (cheap: one local HTTP call).
# Probe fail  ->  warp-rotate.sh --rotate-only, which handles every case:
#                   - usque process gone: restarts it from the existing
#                     registration and waits for warp=on
#                   - registration damaged/gone: re-registers a fresh
#                     anonymous WARP account, restarts usque
#                   - re-register fails: restores the previous registration
#                     and still brings the tunnel back up
#                 A 5-minute cooldown file prevents rapid re-fire loops when
#                 the device itself is offline (no tunnel can exist then).
#
# Runs detached from the sajilo-relay plugin on a 3-minute timer
# (SAJILO_RELAY_WATCHDOG=0 to disable the timer; the script itself stays
# available for manual runs: bash tunnel-watchdog.sh).
set -u

STATE=${SAJILO_STATE:-${SAJILO_ROOT:-/root/ocm}/state}
LOG="$STATE/watchdog.log"
LAST="$STATE/.watchdog.last"
# resolve_proxy_port — which port does the running opencode server use for its
# proxy? The rotator and the watchdog must replace the tunnel ON THAT PORT:
# the server process has HTTPS_PROXY baked into its environment, and the app's
# launcher chooses the port (and exports it), so the port is not a constant.
#
# Order of truth:
#   1. WARP_PROXY_PORT / HTTPS_PROXY from our own environment (the normal
#      case: these scripts are spawned by the opencode server itself).
#   2. The running server's environment (read from /proc) — correct even when
#      the script is started from a plain shell that has no proxy vars.
#   3. The recorded usque.port file.
#   4. 40001 as the last resort.
resolve_proxy_port() {
  local p=""
  # 1. our own environment
  if [ -n "${WARP_PROXY_PORT:-}" ]; then
    printf '%s' "$WARP_PROXY_PORT"
    return 0
  fi
  case "${HTTPS_PROXY:-}" in
    *127.0.0.1:*)
      p="${HTTPS_PROXY##*:}"
      p="${p%%/*}"
      [ -n "$p" ] && {
        printf '%s' "$p"
        return 0
      }
      ;;
  esac
  # 2. the running server's environment
  local d pid line
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    line=$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null) || continue
    case "$line" in
      *"opencode serve"*)
        local envline
        envline=$(tr '\0' '\n' <"$d/environ" 2>/dev/null | grep -m1 '^HTTPS_PROXY=')
        case "$envline" in
          *127.0.0.1:*)
            p="${envline##*:}"
            p="${p%%/*}"
            [ -n "$p" ] && {
              printf '%s' "$p"
              return 0
            }
            ;;
        esac
        ;;
    esac
  done
  # 3. recorded port
  if [ -s "$STATE/usque.port" ]; then
    p="$(cat "$STATE/usque.port" 2>/dev/null)"
    [ -n "$p" ] && {
      printf '%s' "$p"
      return 0
    }
  fi
  # 4. fallback
  printf '%s' "40001"
}

# The tunnel must live on the port the RUNNING SERVER proxies through.
PORT="$(resolve_proxy_port)"
# An explicit port file in the state dir wins — the sajilo instance keeps its own
# tunnel port (40003) there. Without this the sajilo watchdog probed the LIVE
# port, reported "probe ok" while sajilo's tunnel was dead, and never
# repaired it.
if [ -s "$STATE/port" ]; then
  PORT="$(cat "$STATE/port" 2>/dev/null)"
fi

probe() {
  curl -s --max-time 10 -x "http://127.0.0.1:$PORT" \
    https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q '^warp=on'
}

# Is the usque process still alive? (procps is absent on this device, so read
# /proc directly.)
usque_alive() {
  local d pid argline
  if [ -s "$STATE/usque.pid" ]; then
    pid="$(cat "$STATE/usque.pid" 2>/dev/null)"
    if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
      argline=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) || argline=""
      case "$argline" in
        *"-p $PORT"*) return 0 ;;
      esac
    fi
  fi
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    [ "$(cat "$d/comm" 2>/dev/null)" = "usque" ] || continue
    argline=$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null) || continue
    case "$argline" in
      *"-p $PORT"*) return 0 ;;
    esac
  done
  return 1
}

# Cooldown: do not hammer repairs faster than every 5 minutes.
if [ -f "$LAST" ]; then
  now=$(date +%s)
  last=$(cat "$LAST" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt 300 ]; then
    exit 0
  fi
fi

if probe; then
  # Bounded trace so ticks are observable (log is capped at 200 lines).
  : >>"$LOG" 2>/dev/null || true
  tail -n 199 "$LOG" 2>/dev/null >"$LOG.tmp" && mv "$LOG.tmp" "$LOG" 2>/dev/null || true
  printf 'probe ok %s\n' "$(date -u +%FT%TZ)" >>"$LOG" 2>/dev/null || true
  exit 0
fi

# A saturated tunnel looks exactly like a dead one to a single short probe:
# during the 18:30-19:07 drain the relay was pushing ~5 req/s through the
# proxy and the 6 s probe timed out, so the watchdog judged the tunnel dead
# and rotated the egress mid-experiment (19:02:53Z). Require TWO consecutive
# failures with a generous timeout before touching a tunnel that still has a
# live usque process; only a dead usque is treated as a hard failure.
if usque_alive; then
  # A usque on OUR port is running but the probe failed. It can be busy
  # (a saturated tunnel still answers, just late) or hung (dead tunnel that
  # never answers). Distinguish them with patient, spread-out probes: a busy
  # tunnel answers one of them, a hung one answers none.
  sleep 10
  if probe; then
    printf 'probe slow but ok %s\n' "$(date -u +%FT%TZ)" >>"$LOG" 2>/dev/null || true
    exit 0
  fi
  sleep 15
  if probe; then
    printf 'probe slow, recovered %s\n' "$(date -u +%FT%TZ)" >>"$LOG" 2>/dev/null || true
    exit 0
  fi
  printf 'probe failed 3x with usque alive %s — treating the tunnel as hung\n' \
    "$(date -u +%FT%TZ)" >>"$LOG" 2>/dev/null || true
  # Fall through to the repair: a tunnel that never answers is dead weight.
fi

date +%s >"$LAST"
printf '\n--- watchdog: tunnel down at %s — repairing on port %s ---\n' \
  "$(date -u +%FT%TZ)" "$PORT" >>"$LOG" 2>/dev/null || true
# Repair in two steps, cheapest first:
#   1. restart the tunnel on the EXISTING registration (keeps the IP, and a
#      fresh registration does not always come up — observed 2026-11-11
#      17:10Z: the new account's MASQUE session connected but no traffic
#      flowed, while the old identity was fine);
#   2. only if that fails, rotate to a brand-new identity.
ROTATOR=/usr/local/lib/opencode-warp/warp-rotate.sh
"$ROTATOR" --restart-only >>"$LOG" 2>&1
rc=$?
if [ "$rc" != "0" ]; then
  printf 'watchdog: restart-only failed (rc=%s) — rotating to a new identity\n' \
    "$rc" >>"$LOG" 2>/dev/null || true
  "$ROTATOR" --rotate-only >>"$LOG" 2>&1
  rc=$?
fi
printf 'watchdog repair rc=%s at %s\n' "$rc" "$(date -u +%FT%TZ)" >>"$LOG" 2>/dev/null || true
exit "$rc"
