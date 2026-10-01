#!/usr/bin/env python3
"""Manage this project's Mac-to-production loopback SSH forwards with launchd."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess

LABEL = 'live.aiplanet.aihot-gateway-tunnel'
parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['install', 'start', 'stop', 'status', 'uninstall'])
parser.add_argument('--host', default='tencent-webserver-china')
parser.add_argument('--proxy-port', type=int, default=59527)
args = parser.parse_args()
home = Path.home()
plist = home / 'Library/LaunchAgents' / f'{LABEL}.plist'
logs = home / 'Library/Logs/aihot'
domain = f'gui/{os.getuid()}'
target = f'{domain}/{LABEL}'

def loaded():
    return subprocess.run(['launchctl', 'print', target], capture_output=True).returncode == 0

if args.action == 'install':
    logs.mkdir(parents=True, exist_ok=True)
    plist.parent.mkdir(parents=True, exist_ok=True)
    data = {
        'Label': LABEL,
        # The installed ~/.zshenv resolves the native per-login SSH agent socket.
        # Resolve at every launch: a captured socket path expires after reboot/login.
        'ProgramArguments': ['/bin/zsh', '-c', 'exec /usr/bin/ssh "$@"', LABEL,
            '-N', '-T', '-o', 'BatchMode=yes',
            '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15',
            '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
            '-R', '127.0.0.1:39031:127.0.0.1:39011',
            '-R', f'127.0.0.1:39032:127.0.0.1:{args.proxy_port}', args.host],
        'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 15,
        'StandardOutPath': str(logs / 'gateway-tunnel.log'),
        'StandardErrorPath': str(logs / 'gateway-tunnel.err.log'),
    }
    if loaded():
        subprocess.run(['launchctl', 'bootout', target], check=True)
    plist.write_bytes(plistlib.dumps(data))
    plist.chmod(0o600)
    subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    print(f'AI Radar tunnel registered. Verify remote 39031 /health and 39032 proxy; logs: {logs}.')
elif args.action == 'start':
    if not plist.exists():
        parser.error('Tunnel is not installed; run install first.')
    if not loaded():
        subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    print('AI Radar tunnel registered; endpoint readiness still requires a remote request.')
elif args.action in ('stop', 'uninstall'):
    if loaded():
        subprocess.run(['launchctl', 'bootout', target], check=True)
    if args.action == 'uninstall':
        plist.unlink(missing_ok=True)
    print('AI Radar tunnel stopped; local Gateway and other tunnels are unchanged.')
else:
    if not loaded():
        print('AI Radar tunnel is not registered; model access from production is not verified.')
    else:
        subprocess.run(['launchctl', 'print', target], check=True)
        print('Registration shown above; this does not verify remote Gateway or proxy readiness.')
