#!/usr/bin/env bash
set -euo pipefail
# Run on the production host; secrets and database survive uninstall.
action=${1:-status}
units=(aihot-api.service aihot-web.service aihot-worker.service)
installed=()
for unit in "${units[@]}"; do
  state=$(systemctl show "$unit" -p LoadState --value)
  if [[ "$state" != not-found ]]; then installed+=("$unit"); fi
done
case "$action" in
  install)
    here=$(cd -- "$(dirname -- "$0")" && pwd)
    root=$(cd -- "$here/../.." && pwd)
    bash "$here/prepare-release.sh"
    ln -sfn "$root" /home/ubuntu/aihot/current.next
    mv -Tf /home/ubuntu/aihot/current.next /home/ubuntu/aihot/current
    for unit in "${units[@]}"; do sudo install -m 0644 "$here/$unit" "/etc/systemd/system/$unit"; done
    sudo systemctl daemon-reload
    sudo systemctl enable "${units[@]}"
    sudo systemctl restart "${units[@]}"
    echo 'AI Radar services restarted. Check: bash deploy/production/service.sh status; logs: journalctl -u aihot-worker. Public Nginx routing is unchanged.'
    ;;
  start|restart) sudo systemctl "$action" "${units[@]}" ;;
  stop)
    if ((${#installed[@]})); then sudo systemctl stop "${installed[@]}"; fi
    echo 'AI Radar services stopped (absent services require no action).'
    ;;
  status)
    if ((${#installed[@]})); then
      systemctl --no-pager status "${installed[@]}"
    else
      echo 'AI Radar services are not installed; production readiness has not been checked.'
    fi
    ;;
  uninstall)
    if ((${#installed[@]})); then sudo systemctl disable --now "${installed[@]}"; fi
    for unit in "${units[@]}"; do sudo rm -f "/etc/systemd/system/$unit"; done
    sudo systemctl daemon-reload
    echo 'AI Radar services removed; releases, credentials and PostgreSQL data retained.'
    ;;
  *) echo 'Usage: service.sh install|start|stop|restart|status|uninstall' >&2; exit 2 ;;
esac
