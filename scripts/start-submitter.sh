#!/usr/bin/env bash
# Optional userspace WARP tunnel for the isolated Codeforces Firefox service.
# An explicit CODEFORCES_PROXY takes priority. A listening SOCKS port alone
# does not prove WireGuard can reach the Internet (for example, UDP may be blocked).
set -u

WARP_DIR=/tmp/warp
WARP_SOCKS_PORT="${WARP_SOCKS_PORT:-40000}"
log() { echo "[start-submitter] $*"; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

start_warp() (
  command -v wgcf >/dev/null 2>&1 || { log "wgcf binary missing"; return 1; }
  command -v wireproxy >/dev/null 2>&1 || { log "wireproxy binary missing"; return 1; }
  command -v curl >/dev/null 2>&1 || { log "curl missing; cannot verify WARP connectivity"; return 1; }
  mkdir -p "$WARP_DIR" && cd "$WARP_DIR" || return 1
  umask 077

  if [ -n "${WARP_PROFILE_B64:-}" ]; then
    log "using WARP_PROFILE_B64"
    printf '%s' "$WARP_PROFILE_B64" | base64 -d > wgcf-profile.conf || { log "invalid WARP_PROFILE_B64"; return 1; }
  elif [ ! -s wgcf-profile.conf ]; then
    if [ ! -s wgcf-account.toml ]; then
      log "registering a free WARP account (20s limit)"
      timeout 20 wgcf register --accept-tos --config wgcf-account.toml > register.log 2>&1
      result=$?
      if [ "$result" -ne 0 ]; then
        # wgcf logs can include credentials; report only status and remediation.
        log "wgcf register failed (exit $result); set WARP_PROFILE_B64 from a working local wgcf profile or configure CODEFORCES_PROXY"
        return 1
      fi
    fi
    timeout 10 wgcf generate --config wgcf-account.toml --profile wgcf-profile.conf > generate.log 2>&1 \
      || { log "wgcf generate failed"; return 1; }
  else
    log "reusing existing WARP profile"
  fi

  cat > wireproxy.conf <<EOF
WGConfig = ${WARP_DIR}/wgcf-profile.conf

[Socks5]
BindAddress = 127.0.0.1:${WARP_SOCKS_PORT}
EOF

  wireproxy -c wireproxy.conf > wireproxy.log 2>&1 &
  warp_pid=$!
  for _ in $(seq 1 15); do
    kill -0 "$warp_pid" 2>/dev/null || { log "wireproxy exited before becoming ready"; return 1; }
    if port_open "$WARP_SOCKS_PORT"; then
      trace=$(curl --fail --silent --max-time 10 --socks5-hostname "127.0.0.1:${WARP_SOCKS_PORT}" https://www.cloudflare.com/cdn-cgi/trace) || trace=''
      if printf '%s\n' "$trace" | grep -Eq '^warp=(on|plus)$'; then
        log "WARP tunnel verified on 127.0.0.1:${WARP_SOCKS_PORT}"
        return 0
      fi
      log "SOCKS port opened but WARP egress verification failed; stopping the unusable tunnel"
      kill "$warp_pid" 2>/dev/null || true
      wait "$warp_pid" 2>/dev/null || true
      return 1
    fi
    sleep 1
  done
  log "wireproxy did not become ready"
  kill "$warp_pid" 2>/dev/null || true
  wait "$warp_pid" 2>/dev/null || true
  return 1
)

if [ -n "${CODEFORCES_RUNNER_REPOSITORY:-}" ]; then
  log "GitHub browser runner configured; Render will only dispatch and broker jobs"
elif [ -n "${CODEFORCES_PROXY:-}" ]; then
  log "using configured CODEFORCES_PROXY"
elif [ "${WARP_ENABLED:-true}" != "false" ]; then
  if start_warp; then
    export CODEFORCES_PROXY="socks5://127.0.0.1:${WARP_SOCKS_PORT}"
  else
    log "WARP unavailable; using direct connection (Codeforces verification may still block this connection)"
  fi
fi

if [ "${HEADLESS:-true}" = "false" ] && [ -z "${DISPLAY:-}" ]; then
  if command -v Xvfb >/dev/null 2>&1; then
    Xvfb :99 -screen 0 1024x768x16 -nolisten tcp > /tmp/xvfb.log 2>&1 &
    export DISPLAY=:99
    log "started Xvfb on :99 for headed Firefox"
  else
    log "Xvfb missing; forcing HEADLESS=true"
    export HEADLESS=true
  fi
fi

cd /app || exit 1
exec node --expose-gc dist/src/codeforces/submitterService.js
