#!/usr/bin/env bash
# Entry point of the isolated Codeforces submitter (Render free web service).
#
# Why: Cloudflare in front of Codeforces flags POSTs coming from Render's
# datacenter IPs and answers them with an interactive Turnstile (403) that a
# headless browser cannot pass. cv3inx/turnstile-solver gets around this by
# sending its browser out through Cloudflare WARP. We do the same here, fully in
# userspace (no root, no TUN device — Render free allows neither):
#
#   wgcf      -> registers a free WARP account and writes a WireGuard profile
#   wireproxy -> runs that WireGuard tunnel in userspace and exposes it as a
#                local SOCKS5 proxy on 127.0.0.1:${WARP_SOCKS_PORT}
#   Firefox   -> launched with CODEFORCES_PROXY=socks5://127.0.0.1:${WARP_SOCKS_PORT}
#
# If anything in the WARP setup fails, the submitter still starts on the direct
# connection (same behaviour as before), so this can never make things worse.
#
# Env:
#   WARP_ENABLED     default "true"; "false" skips the tunnel entirely
#   WARP_SOCKS_PORT  default 40000
#   WARP_PROFILE_B64 optional base64 of a wgcf-profile.conf to reuse one fixed
#                    WARP account instead of registering a new one on each boot
#   HEADLESS         "false" starts a virtual display (Xvfb) and runs Firefox
#                    headed, as the solver repo recommends (costs extra RAM)
set -u

WARP_DIR=/tmp/warp
WARP_SOCKS_PORT="${WARP_SOCKS_PORT:-40000}"
log() { echo "[start-submitter] $*"; }

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

start_warp() {
  command -v wgcf >/dev/null 2>&1 || { log "wgcf binary missing"; return 1; }
  command -v wireproxy >/dev/null 2>&1 || { log "wireproxy binary missing"; return 1; }
  mkdir -p "$WARP_DIR" && cd "$WARP_DIR" || return 1

  if [ -n "${WARP_PROFILE_B64:-}" ]; then
    log "using WARP profile from WARP_PROFILE_B64"
    echo "$WARP_PROFILE_B64" | base64 -d > wgcf-profile.conf || return 1
  else
    log "registering a free WARP account"
    wgcf register --accept-tos --config wgcf-account.toml >/dev/null 2>&1 \
      || { log "wgcf register failed"; return 1; }
    wgcf generate --config wgcf-account.toml --profile wgcf-profile.conf >/dev/null 2>&1 \
      || { log "wgcf generate failed"; return 1; }
  fi

  cat > wireproxy.conf <<EOF
WGConfig = ${WARP_DIR}/wgcf-profile.conf

[Socks5]
BindAddress = 127.0.0.1:${WARP_SOCKS_PORT}
EOF

  wireproxy -c wireproxy.conf > "$WARP_DIR/wireproxy.log" 2>&1 &
  for _ in $(seq 1 30); do
    if port_open "$WARP_SOCKS_PORT"; then
      log "WARP SOCKS5 proxy is up on 127.0.0.1:${WARP_SOCKS_PORT}"
      if command -v curl >/dev/null 2>&1; then
        trace=$(curl -s --max-time 10 --socks5-hostname "127.0.0.1:${WARP_SOCKS_PORT}" \
          https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(ip|warp|colo)=' | tr '\n' ' ')
        log "egress via WARP: ${trace:-<trace unavailable>}"
      fi
      return 0
    fi
    sleep 1
  done
  log "wireproxy did not open its port; log follows"
  cat "$WARP_DIR/wireproxy.log" 2>/dev/null | tail -n 20
  return 1
}

if [ "${WARP_ENABLED:-true}" != "false" ]; then
  if start_warp; then
    export CODEFORCES_PROXY="socks5://127.0.0.1:${WARP_SOCKS_PORT}"
  else
    log "WARP unavailable — falling back to the direct connection"
    unset CODEFORCES_PROXY
  fi
fi

if [ "${HEADLESS:-true}" = "false" ] && [ -z "${DISPLAY:-}" ]; then
  if command -v Xvfb >/dev/null 2>&1; then
    Xvfb :99 -screen 0 1024x768x16 -nolisten tcp > /tmp/xvfb.log 2>&1 &
    export DISPLAY=:99
    log "started Xvfb on :99 for headed Firefox"
  else
    log "Xvfb missing — forcing HEADLESS=true"
    export HEADLESS=true
  fi
fi

cd /app || exit 1
exec node --expose-gc dist/src/codeforces/submitterService.js
