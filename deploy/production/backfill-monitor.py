#!/usr/bin/env python3
"""Manage the Mac launchd backfill probe. Does not alter production services."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import sys

LABEL = 'live.aiplanet.aihot-backfill-probe'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'start', 'stop', 'status', 'uninstall'])
    parser.add_argument('--host', default='tencent-webserver-china')
    parser.add_argument('--interval', type=int, default=300)
    args = parser.parse_args()
    if args.interval < 60:
        parser.error('监督周期至少 60 秒。')
    home = Path.home()
    plist = home / 'Library/LaunchAgents' / f'{LABEL}.plist'
    logs = home / 'Library/Logs/aihot'
    domain = f'gui/{os.getuid()}'
    target = f'{domain}/{LABEL}'
    loaded = subprocess.run(['launchctl', 'print', target], capture_output=True).returncode == 0
    if args.action == 'install':
        wrapper = home / '.local/bin/run-or-alert'
        notifier = home / '.local/bin/im-notify'
        if not all(os.access(path, os.X_OK) for path in (wrapper, notifier)):
            parser.error('需先安装本机 im-notify 与 run-or-alert；未安装监督服务。')
        logs.mkdir(parents=True, exist_ok=True)
        plist.parent.mkdir(parents=True, exist_ok=True)
        data = {
            'Label': LABEL,
            'ProgramArguments': [str(wrapper), '--key', 'aihot-backfill-probe', '--title', 'AI Radar 回填监督 · 知会（无需立即处置）', '--',
                                 sys.executable, str(Path(__file__).resolve().with_name('backfill-probe.py')),
                                 '--host', args.host],
            'RunAtLoad': True, 'StartInterval': args.interval,
            'EnvironmentVariables': {'PATH': f'{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'},
            'StandardOutPath': str(logs / 'backfill-probe.log'),
            'StandardErrorPath': str(logs / 'backfill-probe.err.log'),
        }
        if loaded:
            subprocess.run(['launchctl', 'bootout', target], check=True)
        plist.write_bytes(plistlib.dumps(data))
        plist.chmod(0o600)
        subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
        print(f'✓ 本机回填监督已注册；每 {args.interval} 秒只读探测生产。投递仍需实测验收。检查：backfill-monitor.py status；日志：{logs}。')
    elif args.action == 'start':
        if not plist.exists():
            parser.error('监督服务未安装；先运行 install。')
        if not loaded:
            subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
        print('✓ 本机回填监督已启动；生产回填状态与通知投递仍需查看探针结果。')
    elif args.action in ('stop', 'uninstall'):
        if loaded:
            subprocess.run(['launchctl', 'bootout', target], check=True)
        if args.action == 'uninstall':
            plist.unlink(missing_ok=True)
        print('✓ 本机回填监督已停止；生产执行器、批次和通知记录保留。')
    elif not loaded:
        print('本机回填监督未加载；生产执行器与通知投递未核实。')
    else:
        print('本机回填监督已加载；以下为 supervisor 状态，不代表生产或通知已通过验收。')
        subprocess.run(['launchctl', 'print', target], check=True)


if __name__ == '__main__':
    main()
