#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
action=${1:-status}
timer=aihot-backfill.timer
runner=aihot-backfill.service
installed() { [[ $(systemctl show "$1" -p LoadState --value) != not-found ]]; }
case "$action" in
  install)
    sudo install -m 0644 "$here/backfill.service" "/etc/systemd/system/$runner"
    sudo install -m 0644 "$here/backfill.timer" "/etc/systemd/system/$timer"
    sudo systemctl daemon-reload
    sudo systemctl enable "$timer"
    sudo systemctl restart "$timer"
    echo '✓ 回填调度已安装并启动；只续跑已恢复的批次，暂停批次保持暂停。请确认 app.env 中 BACKFILL_CONCURRENCY、BACKFILL_MAX_ITEMS、BACKFILL_MAX_RUNS、BACKFILL_DRAIN_SECONDS 已显式配置。'
    echo '检查：bash deploy/production/backfill-service.sh status；日志：journalctl -u aihot-backfill.service。安装成功不代表批次已完成。'
    ;;
  start)
    if ! installed "$timer"; then echo '⚠ 回填调度未安装；先运行 backfill-service.sh install。' >&2; exit 2; fi
    sudo systemctl start "$timer"
    echo '✓ 回填调度已启动；暂停批次不会自动恢复。'
    ;;
  stop|uninstall)
    if installed "$timer"; then sudo systemctl stop "$timer"; fi
    if installed "$runner"; then sudo systemctl stop "$runner"; fi
    if [[ "$action" == uninstall ]]; then
      if installed "$timer"; then sudo systemctl disable "$timer"; fi
      sudo rm -f "/etc/systemd/system/$timer" "/etc/systemd/system/$runner"
      sudo systemctl daemon-reload
    fi
    echo '✓ 回填调度已停止；批次、回执、配置与数据库保留。没有已安装服务时无需操作。'
    ;;
  status)
    if ! installed "$timer"; then echo '回填调度未安装；未核验批次进度。'; exit 0; fi
    echo '回填调度与执行器状态如下；批次进度另用 scripts/backfill.ts status 查看。'
    systemctl show "$timer" "$runner" -p Id -p LoadState -p ActiveState -p SubState -p Result -p ExecMainStatus -p NextElapseUSecMonotonic
    ;;
  *) echo '用法：backfill-service.sh install|start|stop|status|uninstall；本次未改变服务。' >&2; exit 2 ;;
esac
