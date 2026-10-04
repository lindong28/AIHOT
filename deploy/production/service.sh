#!/usr/bin/env bash
set -euo pipefail
# Run on the production host; secrets and database survive uninstall.
action=${1:-status}
here=$(cd -- "$(dirname -- "$0")" && pwd)
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
    bash "$here/../wechat2rss/service.sh" install
    ln -sfn "$root" /home/ubuntu/aihot/current.next
    mv -Tf /home/ubuntu/aihot/current.next /home/ubuntu/aihot/current
    for unit in "${units[@]}"; do sudo install -m 0644 "$here/$unit" "/etc/systemd/system/$unit"; done
    sudo systemctl daemon-reload
    sudo systemctl enable "${units[@]}"
    sudo systemctl restart "${units[@]}"
    if [[ $(systemctl show aihot-backfill.timer -p LoadState --value) != not-found ]]; then bash "$here/backfill-service.sh" install; fi
    echo 'AI Radar services restarted. Check: bash deploy/production/service.sh status; logs: journalctl -u aihot-worker. Public Nginx routing is unchanged.'
    ;;
  start|restart)
    bash "$here/../wechat2rss/service.sh" "$action"
    sudo systemctl "$action" "${units[@]}"
    if [[ $(systemctl show aihot-backfill.timer -p LoadState --value) != not-found ]]; then bash "$here/backfill-service.sh" start; fi
    ;;
  stop)
    bash "$here/backfill-service.sh" stop
    if ((${#installed[@]})); then sudo systemctl stop "${installed[@]}"; fi
    bash "$here/../wechat2rss/service.sh" stop
    echo 'AI Radar services stopped (absent services require no action).'
    ;;
  status)
    result=0
    bash "$here/../wechat2rss/service.sh" status || result=$?
    bash "$here/backfill-service.sh" status
    if ((${#installed[@]})); then
      systemctl --no-pager status "${installed[@]}"
    else
      echo 'AI Radar services are not installed; production readiness has not been checked.'
    fi
    exit "$result"
    ;;
  uninstall)
    bash "$here/backfill-service.sh" uninstall
    if ((${#installed[@]})); then sudo systemctl disable --now "${installed[@]}"; fi
    bash "$here/../wechat2rss/service.sh" uninstall
    for unit in "${units[@]}"; do sudo rm -f "/etc/systemd/system/$unit"; done
    sudo systemctl daemon-reload
    echo 'AI Radar services removed; releases, credentials and PostgreSQL data retained.'
    ;;
  *) echo 'Usage: service.sh install|start|stop|restart|status|uninstall' >&2; exit 2 ;;
esac
