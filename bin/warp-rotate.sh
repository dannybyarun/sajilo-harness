#!/bin/bash
# warp-rotate.sh (mobile) - WARP egress rotation, called by the 429 plugin.
#
# Installed inside the proot distro at
#   /usr/local/lib/opencode-warp/warp-rotate.sh
# which is exactly the path the plugin probes, so live recovery works on the
# phone like on the Linux box (OPENCODE_WARP_ROTATE is set as belt-and-braces).
#
# "Rotation" = destroy + re-register an anonymous WARP account (fresh identity
# == fresh free-tier bucket) and restart usque on the app's proxy port.
#
# Important: this script is spawned by the opencode server, whose environment
# contains HTTPS_PROXY=http://127.0.0.1:<port> - i.e. a proxy served by the very
# usque this script has just killed. usque itself must reach Cloudflare
# directly, so every usque invocation explicitly drops the proxy variables.
# If re-registration fails we put the previous identity back and restart it,
# because leaving the app without a tunnel is worse than a failed rotation.
#
# Parallel safety: every opencode instance shares one usque. A flock
# serializes rotations across ALL instances. The lock fd is explicitly closed
# before spawning the long-lived usque (an inherited lock fd would deadlock
# every later rotation).
#
# Usage: warp-rotate.sh [--rotate-only]
set -u

CONF=/root/.config/usque/config.json
STATE=/root/ocm
LOG="$STATE/usque.log"
LOCK="$STATE/.rotate.lock"
# The proxy port MUST match what the opencode server process has in

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

# The tunnel must live on the port the RUNNING SERVER proxies through: the
# app launcher picks the port and exports it in HTTPS_PROXY, so it is not a
# constant. Rotating onto the wrong port leaves the relay on a dead proxy.
PORT="$(resolve_proxy_port)"
# An explicit port file in the state dir wins over everything else — sajilo
# instance keeps its own tunnel port (40003) in its own state dir. Without
# this the sajilo rotator fell back to the default 40001 and even KILLED the
# live tunnel (its stop_usque matches by port).
if [ -s "$STATE/port" ]; then
  PORT="$(cat "$STATE/port" 2>/dev/null)"
fi

say() { printf 'warp-rotate: %s\n' "$*" >&2; }

probe() {
  curl -s --max-time 6 -x "http://127.0.0.1:$PORT" \
    https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q '^warp=on'
}

# usque is the tunnel: any proxy env inherited from the session would point at
# the instance we are about to replace (or have just stopped).
direct() {
  env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
      -u ALL_PROXY -u all_proxy "$@"
}

# Does this usque process serve OUR port? Read the port out of its cmdline
# ("http-proxy -b 127.0.0.1 -p 40001"). Only instances on our port are ours
# to replace: the operator may run a spare tunnel on another port, and
# killing that would fight with a manual setup.
usque_serves_port() {
  local pid=$1 want=$2 argline=""
  argline=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null) || return 1
  case "$argline" in
    *"-p $want"*) return 0 ;;
    *) return 1 ;;
  esac
}

# procps is absent from the minimal base image: use the pid file plus /proc.
stop_usque() {
  local d pid
  if [ -s "$STATE/usque.pid" ]; then
    pid="$(cat "$STATE/usque.pid" 2>/dev/null)"
    if [ -n "$pid" ] && usque_serves_port "$pid" "$PORT"; then
      kill -9 "$pid" 2>/dev/null
    fi
  fi
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    [ "$pid" = "$$" ] && continue
    [ "$(cat "$d/comm" 2>/dev/null)" = "usque" ] || continue
    usque_serves_port "$pid" "$PORT" || continue
    kill -9 "$pid" 2>/dev/null
  done
  sleep 1
}

start_usque() {
  : >>"$LOG" 2>/dev/null || true
  printf '\n--- rotator start usque %s ---\n' "$(date -u +%H:%M:%S)" >>"$LOG" 2>/dev/null || true
  # setsid + nohup: the tunnel must OUTLIVE this script. Started as a plain
  # background child it was killed when the rotator exited (SIGHUP / process
  # group teardown), which is why a rotation could report "egress up on a
  # fresh identity" and leave the tunnel dead seconds later — the tunnel died
  # with the script that started it.
  # `200<&-` closes the inherited lock fd in the child. Without it the
  # long-lived usque keeps the cross-instance flock held forever and every
  # later rotation blocks in `flock` — which is exactly what happened on
  # 2026-11-11 18:09Z: the rotator waited minutes for a lock that the
  # previous tunnel still held.
  setsid nohup env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
      -u ALL_PROXY -u all_proxy \
      usque -c "$CONF" http-proxy -b 127.0.0.1 -p "$PORT" >>"$LOG" 2>&1 200<&- &
  echo "$!" >"$STATE/usque.pid"
  local i
  for i in $(seq 1 90); do
    probe && return 0
    kill -0 "$(cat "$STATE/usque.pid" 2>/dev/null)" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

release_lock() { eval "exec ${LOCKFD}>&-" 2>/dev/null || true; }

# --- take the cross-instance lock -------------------------------------------
mkdir -p "$STATE"
LOCKFD=200
eval "exec ${LOCKFD}>\"$LOCK\"" || { say "cannot open $LOCK"; exit 1; }
trap release_lock EXIT
flock "$LOCKFD" || { say "could not acquire rotation lock"; exit 1; }

# --- rotate ----------------------------------------------------------------
# --restart-only: keep the CURRENT registration and just restart the proxy.
# This is the cheap repair, and it is the one the watchdog should try first:
# re-registering replaces a working identity with a brand-new account, and a
# fresh account does not always come up (observed 2026-11-11 17:10Z: the MASQUE
# session connected but no traffic flowed, and the old identity — which the
# rotator had already thrown away — was the one that actually worked).
if [ "${1:-}" = "--restart-only" ]; then
  say "restarting the tunnel on the existing identity (port $PORT)"
  stop_usque
  # Release the lock before starting the long-lived usque (the child must not
  # inherit the lock fd) and let the EXIT trap clean up.
  release_lock
  trap - EXIT
  if start_usque; then
    say "egress up on the existing identity - warp=on"
    exit 0
  fi
  say "restart on the existing identity failed; falling through to a rotation"
  # Re-take the lock for the full rotation below.
  eval "exec ${LOCKFD}>\"$LOCK\"" || { say "cannot open lock"; exit 1; }
  flock "$LOCKFD" || { say "could not acquire rotation lock"; exit 1; }
  trap release_lock EXIT
fi

# Mark the rotation window: every in-flight request fails while the proxy is
# down, and the relay would otherwise read those failures as "the egress is
# broken" and kick another rotation — a loop that rotates the tunnel out
# from under the rotator. The relay checks this marker and ignores fetch
# errors raised inside the window.
MARK="$STATE/.rotate.inprogress"
date +%s >"$MARK" 2>/dev/null || true
cleanup_marker() { rm -f "$MARK" 2>/dev/null || true; }
trap 'cleanup_marker; release_lock' EXIT

say "rotating: stopping usque, re-registering a fresh WARP account (port $PORT)"
stop_usque

if [ -f "$CONF" ]; then
  mv "$CONF" "$CONF.rotated" 2>/dev/null || true
fi
mkdir -p "$(dirname "$CONF")"

# -a: the minimal image has no stdin for the TOS prompt; -c: without it usque
# writes ./config.json instead of the path the proxy is started with.
if ! direct usque register -a -c "$CONF" -n "ocm-phone-$(date +%s)" >>"$LOG" 2>&1; then
  [ -f "$CONF.rotated" ] && mv "$CONF.rotated" "$CONF"
  say "re-register failed; restoring the previous registration"
  release_lock
  trap - EXIT
  cleanup_marker
  if start_usque; then
    say "egress restored on the previous identity"
  else
    say "previous egress did not come back; see $LOG"
  fi
  exit 1
fi
say "fresh registration acquired"

# --- release the lock BEFORE spawning the long-lived usque ------------------
release_lock
trap - EXIT
cleanup_marker

if start_usque; then
  rm -f "$CONF.rotated"
  say "egress up on a fresh identity - warp=on"
  exit 0
fi

say "egress FAILED after rotation; last log lines:"
tail -5 "$LOG" 2>/dev/null >&2
# Never leave the session without a tunnel: fall back to the previous identity.
if [ -f "$CONF.rotated" ]; then
  mv "$CONF.rotated" "$CONF"
  if start_usque; then say "fell back to the previous identity"; fi
fi
exit 1
