#!/usr/bin/env python3
"""Read production backfill status; send low-urgency notifications on the Mac."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

PREPARATION = '/home/ubuntu/aihot/shared/history-full-20261002/prefilter-v1/summary.json'
PREPARATION_READ = ("import json,pathlib; p=pathlib.Path(" + repr(PREPARATION) + "); "
                    "print('PREPARATION_JSON='+json.dumps(json.loads(p.read_text()) if p.exists() else None))")
REMOTE = ("cd /home/ubuntu/aihot/current && "
          "/usr/local/bin/node --env-file=/home/ubuntu/aihot/shared/app.env scripts/backfill.ts status --json && "
          "python3 -c " + shlex.quote(PREPARATION_READ) + " && "
          "systemctl show aihot-backfill.timer aihot-backfill.service "
          "-p Id -p LoadState -p ActiveState -p SubState -p Result")


def problems(report, units):
    """Stable problem identities; never put raw exception/provider text in a notification."""
    found = {}
    timer = units.get('aihot-backfill.timer', {})
    runner = units.get('aihot-backfill.service', {})
    if timer.get('LoadState') != 'loaded' or timer.get('ActiveState') != 'active':
        found['scheduler'] = '历史回填定时器未运行，待办可能无法自动接续。请检查 backfill-service.sh status。'
    if runner.get('LoadState') != 'loaded' or runner.get('ActiveState') == 'failed' or runner.get('Result') not in ('success', ''):
        found['runner'] = '历史回填执行器异常，进度可能停止。请检查 journalctl -u aihot-backfill.service；先核对回执再恢复。'
    unified = any(run.get('scope') == 'history' for run in report['runs'])
    preparation = None if unified else report.get('preparation')
    if preparation is not None:
        errors = preparation.get('unresolvedErrors')
        if type(errors) is not int or errors < 0:
            raise ValueError('准备阶段错误计数无效，健康未核实。')
        if errors:
            found['preparation'] = '历史回填原文初筛有未解决的执行错误，相关材料尚未完成。请核对 prefilter-v1/summary.json、逐条结果及模型回执；不要直接重放未知请求。'
    for run in report['runs']:
        failed = 0
        if run.get('scope') == 'history':
            failed = run.get('totals', {}).get('failed')
            if type(failed) is not int or failed < 0:
                raise ValueError('统一回填异常计数缺失或无效，健康未核实。')
        if failed and run['state'] in ('ready', 'running'):
            found['batch:' + run['id']] = '历史回填有执行异常；其余待办仍可自动领取，异常条目保留。请在 /admin/backfill 检查原因与回执，不要重放未知请求。'
        elif run['state'] == 'needs_attention':
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
    preparation_line, _, remainder = remainder.partition('\n')
    if not preparation_line.startswith('PREPARATION_JSON='):
        raise ValueError('原文初筛状态读取缺失，健康未核实。')
    report['preparation'] = json.loads(preparation_line.removeprefix('PREPARATION_JSON='))
    if report['preparation'] is not None and not isinstance(report['preparation'], dict):
        raise ValueError('原文初筛状态格式无效，健康未核实。')
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
    unified = any(run.get('scope') == 'history' for run in report['runs'])
    # A missing batch is loss of observation, not evidence of recovery.
    for identity in previous:
        if identity == 'preparation' and report.get('preparation') is None and not unified:
            current[identity] = '历史回填原文初筛状态已无法读取；恢复未核实。请检查 prefilter-v1/summary.json 与执行器，勿据此重放未知请求。'
        if identity.startswith('batch:') and identity[6:] not in runs:
            current[identity] = f'历史批次 {identity[6:]} 已无法从状态接口观察；恢复未核实。请检查 /admin/backfill 的批次记录。'
    binary = Path.home() / '.local/bin/im-notify'
    for identity, message in current.items():
        key = f'aihot-backfill:{args.host}:{identity}'
        notify(binary, ['--alert', '--dedup-key', key, f'【AI Radar 回填 · 知会】{message} 无需立即处置；公开站点可用性不在本次检查范围内。'])
    for identity in previous.keys() - current.keys():
        key = f'aihot-backfill:{args.host}:{identity}'
        paused = identity.startswith('batch:') and runs.get(identity[6:]) == 'paused'
        if identity == 'preparation' and unified:
            message = '初筛已纳入统一回填任务，旧初筛告警退役；不代表旧异常已解决。后续状态见 /admin/backfill。'
        else:
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
