#!/usr/bin/env python3
"""Manage only the existing Wechat2RSS host's reverse SSH tunnel to AIHOT."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess

LABEL = "live.aiplanet.aihot-wechat2rss-tunnel"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("action", choices=["install", "start", "stop", "status", "uninstall"])
args = parser.parse_args()
home = Path.home()
plist = home / "Library/LaunchAgents" / f"{LABEL}.plist"
logs = home / "Library/Logs/aihot"
domain = f"gui/{os.getuid()}"
target = f"{domain}/{LABEL}"


def loaded():
    return subprocess.run(["launchctl", "print", target], capture_output=True).returncode == 0


if args.action == "install":
    logs.mkdir(parents=True, exist_ok=True)
    plist.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "Label": LABEL,
        "ProgramArguments": ["/bin/zsh", "-c", 'exec /usr/bin/ssh "$@"', LABEL,
            "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
            "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
            "-R", "127.0.0.1:39033:127.0.0.1:8080", "tencent-webserver-china"],
        "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 15,
        "StandardOutPath": str(logs / "wechat2rss-tunnel.log"),
        "StandardErrorPath": str(logs / "wechat2rss-tunnel.err.log"),
    }
    if loaded():
        subprocess.run(["launchctl", "bootout", target], check=True)
    plist.write_bytes(plistlib.dumps(data))
    plist.chmod(0o600)
    subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
    print("公众号隧道已注册；须从腾讯云回环 39033 验证认证 RSS，注册不代表采集成功。")
elif args.action == "start":
    if not plist.exists():
        parser.error("公众号隧道尚未安装，请先运行 install。")
    if not loaded():
        subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
    print("公众号隧道已注册；采集可用性须从腾讯云认证 RSS 和来源运行记录核实。")
elif args.action in ("stop", "uninstall"):
    if loaded():
        subprocess.run(["launchctl", "bootout", target], check=True)
    if args.action == "uninstall":
        plist.unlink(missing_ok=True)
    print("公众号隧道已停；Wechat2RSS 容器和数据保留，AIHOT 公众号采集将等待隧道恢复。")
else:
    result = subprocess.run(["launchctl", "print", target], capture_output=True, text=True)
    if result.returncode:
        print("公众号隧道未注册，腾讯云公众号入口未核实；运行 start 恢复。")
        raise SystemExit(1)
    fields = [line.strip() for line in result.stdout.splitlines() if line.strip().startswith(("state =", "pid =", "last exit code ="))]
    print("公众号隧道：" + "；".join(fields))
    print("仅报告 launchd 状态；实际采集请查腾讯云来源运行记录。")
