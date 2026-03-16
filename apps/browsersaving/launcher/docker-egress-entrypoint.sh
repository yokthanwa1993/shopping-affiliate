#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[launcher-egress] %s\n' "$*" >&2
}

configure_dlink_egress() {
  local enabled gateway control_if control_gw dlink_if
  enabled="${D_LINK_EGRESS_ENABLED:-false}"
  gateway="${D_LINK_GATEWAY:-}"

  if [[ "${enabled}" != "true" ]]; then
    log "D-Link egress disabled"
    return 0
  fi

  if [[ -z "${gateway}" ]]; then
    log "D-Link gateway missing; leaving routes unchanged"
    return 0
  fi

  control_if="$(ip route show default 2>/dev/null | awk 'NR==1 { print $5 }')"
  control_gw="$(ip route show default 2>/dev/null | awk 'NR==1 { print $3 }')"
  dlink_if="$(ip route get "${gateway}" 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i+1); exit }}')"

  if [[ -z "${dlink_if}" ]]; then
    log "Could not resolve D-Link interface for gateway ${gateway}"
    return 1
  fi

  if [[ "${dlink_if}" == "${control_if}" ]]; then
    log "D-Link interface matches control interface (${dlink_if}); leaving routes unchanged"
    return 0
  fi

  if [[ -n "${control_gw}" && -n "${control_if}" ]]; then
    ip route replace default via "${control_gw}" dev "${control_if}" metric 100 || true
  fi
  ip route replace default via "${gateway}" dev "${dlink_if}" metric 10

  log "default route switched to ${gateway} via ${dlink_if}"
  ip route >&2
}

main() {
  configure_dlink_egress
  cd /app
  exec su -s /bin/bash browser -c 'cd /app && exec npm start'
}

main "$@"
