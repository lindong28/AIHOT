#!/usr/bin/env python3
"""Read production backfill status; send low-urgency notifications on the Mac."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

REMOTE = ("cd /home/ubuntu/aihot/current && "
          "/usr/local/bin/node --env-file=/home/ubuntu/aihot/shared/app.env scripts/backfill.ts status --json && "
          "systemctl show aihot-backfill.timer aihot-backfill.service "
          "-p Id -p LoadState -p ActiveState -p SubState -p Result")


def problems(report, units):
    """Stable problem identities; never put raw exception/provider text in a notification."""
    found = {}
    timer = units.get('aihot-backfill.timer', {})
    runner = units.get('aihot-backfill.service', {})
    if timer.get('LoadState') != 'loaded' or timer.get('ActiveState') != 'active':
        found['scheduler'] = '历史回填定时器未运行，已批准批次可能无法自动接续。请检查 backfill-service.sh status。'
    if runner.get('LoadState') != 'loaded' or runner.get('ActiveState') == 'failed' or runner.get('Result') not in ('success', ''):
        found['runner'] = '历史回填执行器异常，进度可能停止。请检查 journalctl -u aihot-backfill.service；先核对回执再恢复。'
    for run in report['runs']:
        if run['state'] == 'needs_attention':
            found['batch:' + run['id']] = f"历史批次 {run['id']} 需要人工核账；不会自动重试。请在 /admin/backfill 检查失败条目与回执。"
        elif run['state'] == 'waiting_models':
            found['batch:' + run['id']] = f"历史批次 {run['id']} 正在等待已批准的模型路由，尚不能继续。请在 /admin/backfill 检查绑定与 Gateway 就绪状态。"
    return found


def read_status(host):
    result = subprocess.run(['/bin/zsh', '-c', 'exec /usr/bin/ssh "$@"', 'backfill-probe',
                             '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                             '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
                             host, REMOTE], capture_output=True, text=True, timeout=75)
    if result.returncode:
        raise RuntimeError('未能读取生产回填状态；生产健康未核实。请检查 SSH 与生产服务，不自动恢复批次。')
    first, _, remainder = result.stdout.partition('\n')
    report = json.loads(first)
    if not isinstance(report.get('runs'), list):
        raise ValueError('回填状态缺少 runs，生产健康未核实。')
    units = {}
    for block in remainder.strip().split('\n\n'):
        fields = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
        if 'Id' in fields:
            units[fields['Id']] = fields
    if set(units) != {'aihot-backfill.timer', 'aihot-backfill.service'}:
        raise ValueError('生产服务状态不完整；执行器健康未核实。')
    return report, units


def notify(binary, args):
    result = subprocess.run([str(binary), *args], capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError('回填通知未确认投递；请检查本机 im-notify 配置与投递账本。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='tencent-webserver-china')
    args = parser.parse_args()
    report, units = read_status(args.host)
    current = problems(report, units)
    state_file = Path.home() / '.local/state/aihot/backfill-probe.json'
    previous = json.loads(state_file.read_text()) if state_file.exists() else {}
    runs = {run['id']: run['state'] for run in report['runs']}
    # A missing batch is loss of observation, not evidence of recovery.
    for identity in previous:
        if identity.startswith('batch:') and identity[6:] not in runs:
            current[identity] = f'历史批次 {identity[6:]} 已无法从状态接口观察；恢复未核实。请检查 /admin/backfill 的批次记录。'
    binary = Path.home() / '.local/bin/im-notify'
    for identity, message in current.items():
        key = f'aihot-backfill:{args.host}:{identity}'
        notify(binary, ['--alert', '--dedup-key', key, f'【AI Radar 回填 · 知会】{message} 无需立即处置；公开站点可用性不在本次检查范围内。'])
    for identity in previous.keys() - current.keys():
        key = f'aihot-backfill:{args.host}:{identity}'
        paused = identity.startswith('batch:') and runs.get(identity[6:]) == 'paused'
        message = '批次已暂停，本条告警退役；不代表处理完成。' if paused else '本次状态读取确认原异常已解除；不代表全部回填完成。'
        notify(binary, ['--alert', '--dedup-key', key, f'【AI Radar 回填 · 知会】{identity}：{message} 无需立即处置。'])
        notify(binary, ['--dedup-clear', key])
    state_file.parent.mkdir(parents=True, exist_ok=True)
    temporary = state_file.with_suffix('.new')
    temporary.write_text(json.dumps(current, ensure_ascii=False))
    temporary.chmod(0o600)
    os.replace(temporary, state_file)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # SSH stderr, provider errors and environment values must never reach notification tails.
        print('回填监督未完成：生产状态或通知投递未核实。请检查本机监督服务、SSH 和 im-notify 账本；不要据此重试未知回执。', file=sys.stderr)
        sys.exit(1)
