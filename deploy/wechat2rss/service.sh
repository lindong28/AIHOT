#!/usr/bin/env bash
set -euo pipefail
action=${1:-status}
here=$(cd -- "$(dirname -- "$0")" && pwd)
settings=${WECHAT2RSS_COMPOSE_ENV:-/home/ubuntu/aihot/shared/wechat2rss/compose.env}
case "$action" in install|start|restart|stop|status|uninstall) ;; *) echo 'Usage: service.sh install|start|restart|stop|status|uninstall' >&2; exit 2 ;; esac
if [[ ! -f "$settings" ]]; then
  echo "Wechat2RSS 本机实例未配置：${settings}；未启停容器。"
  exit 0
fi
if [[ "$action" == install ]]; then bash "$here/install-engine.sh"; fi
compose=(sudo -n docker compose --project-name aihot-wechat2rss --env-file "$settings" -f "$here/compose.yaml")
case "$action" in
  install|start|restart)
    "${compose[@]}" config --quiet
    args=(up -d --wait --wait-timeout 60)
    if [[ "$action" == restart ]]; then args+=(--force-recreate); fi
    "${compose[@]}" "${args[@]}"
    echo 'Wechat2RSS 容器已启动；登录与真实采集另查 status 和 AIHOT 来源运行记录。'
    ;;
  stop) "${compose[@]}" stop; echo 'Wechat2RSS 已停止，数据与配置保留。' ;;
  status)
    "${compose[@]}" ps --all
    /usr/local/bin/node --env-file="${WECHAT2RSS_ENV_FILE:-/home/ubuntu/aihot/shared/wechat2rss/service.env}" "$here/login-status.ts" --summary
    ;;
  uninstall) "${compose[@]}" down; echo 'Wechat2RSS 容器已移除，绑定目录的数据与配置保留；再次启动会重建容器。' ;;
esac
