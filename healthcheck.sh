#!/usr/bin/env bash
# Probe the monitor's HTTP port and restart the unit when it stops answering.
#
# Why a port probe rather than systemd's own supervision: on 2026-09-14 the
# next-server process was still `active/running` with `NRestarts=0` while having
# lost its listening socket entirely — `/proc/<MainPID>/fd` held no LISTEN
# descriptor, only the single connection a browser had opened hours earlier.
# systemd saw a perfectly healthy service; nothing new could connect. The
# dashboard alternated between "live" (the surviving SSE socket kept delivering
# its 2 s tick) and "reconnecting" (every new request refused). Only a real
# request against the port detects that state.
set -uo pipefail

PORT="${MONITOR_PORT:-3200}"
UNIT="${MONITOR_UNIT:-openclaw-monitor.service}"
URL="http://127.0.0.1:${PORT}/"

# Three probes five seconds apart: a restart costs the dashboard a few seconds
# of downtime, so a single dropped request must not trigger one.
ATTEMPTS="${MONITOR_HC_ATTEMPTS:-3}"
DELAY="${MONITOR_HC_DELAY:-5}"
TIMEOUT="${MONITOR_HC_TIMEOUT:-5}"
COOLDOWN="${MONITOR_HC_COOLDOWN:-300}"

STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/openclaw-monitor-healthcheck"
STAMP="$STATE_DIR/last-restart"
mkdir -p "$STATE_DIR"

log() { printf 'healthcheck: %s\n' "$*"; }

# -f so an HTTP 5xx counts as a failure, --max-time so a hung event loop that
# still completes the TCP handshake counts as one too.
probe() { curl -fsS -o /dev/null --max-time "$TIMEOUT" "$URL"; }

for attempt in $(seq 1 "$ATTEMPTS"); do
  if probe; then
    [ "$attempt" -gt 1 ] && log "$URL answered on attempt $attempt/$ATTEMPTS"
    exit 0
  fi
  [ "$attempt" -lt "$ATTEMPTS" ] && sleep "$DELAY"
done

state="$(systemctl --user show "$UNIT" -p ActiveState --value 2>/dev/null || echo unknown)"

# A unit someone stopped on purpose stays stopped. systemd's own Restart=always
# already covers crashes, so reaching this point with an inactive unit means a
# human wanted it down — resurrecting it would just fight the operator.
if [ "$state" = "inactive" ] || [ "$state" = "deactivating" ]; then
  log "$URL unreachable but $UNIT is $state — deliberate stop assumed, leaving it alone"
  exit 0
fi

now="$(date +%s)"
if [ -f "$STAMP" ]; then
  last="$(cat "$STAMP" 2>/dev/null || echo 0)"
  age=$(( now - last ))
  if [ "$age" -lt "$COOLDOWN" ]; then
    log "$URL still unreachable (unit=$state) but the last restart was ${age}s ago (< ${COOLDOWN}s)"
    log "not restarting — this is a restart loop, not the lost-listener failure; investigate by hand"
    exit 1
  fi
fi

# Capture the evidence *before* the restart destroys it: the next occurrence of
# the 2026-09-14 failure should leave a diagnosable trace in the journal.
pid="$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null || echo 0)"
sockets="$(find "/proc/${pid}/fd" -lname 'socket:*' 2>/dev/null | wc -l)"
log "$URL unreachable after $ATTEMPTS attempts — unit=$state MainPID=$pid open_sockets=$sockets"
if ss -tlnp 2>/dev/null | grep -q ":${PORT}[[:space:]]"; then
  log "a listening socket on :${PORT} does exist — the process accepts but does not answer"
else
  log "no listening socket on :${PORT} — same failure mode as 2026-09-14"
fi

printf '%s\n' "$now" > "$STAMP"
systemctl --user restart "$UNIT"
sleep 5

if probe; then
  log "$UNIT restarted, $URL answers again"
  exit 0
fi
log "$UNIT restarted but $URL is still unreachable"
exit 1
