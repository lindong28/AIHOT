#!/usr/bin/env python3
"""Copy a consistent SQLite snapshot and private env without stopping the source service."""
import argparse
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess

parser = argparse.ArgumentParser(description="复制 Wechat2RSS 数据与私有配置；不启停任何服务。")
parser.add_argument("host", help="SSH 主机别名")
parser.add_argument("source", help="远端部署目录绝对路径")
parser.add_argument("destination", type=Path, help="尚不存在的本机快照目录（必须不受 Git 跟踪）")
parser.add_argument("--remote-python", default="/opt/homebrew/bin/python3", help="远端 Python 3.11+ 可执行路径")
parser.add_argument("--env-name", default=".env", choices=[".env", "service.env"], help="源部署目录中的私有配置文件名")
args = parser.parse_args()
os.umask(0o077)
args.destination.mkdir(parents=True, exist_ok=False)
source = str(Path(args.source) / "data" / "res.db")
# backup() includes committed WAL pages and obtains a consistent read snapshot.
code = f"""import sqlite3,sys
from pathlib import Path
src=sqlite3.connect(Path({source!r}).as_uri()+'?mode=ro',uri=True)
dst=sqlite3.connect(':memory:')
src.backup(dst)
sys.stdout.buffer.write(dst.serialize())
"""
try:
    with (args.destination / "res.db").open("xb") as out:
        subprocess.run(["ssh", "-T", "-o", "ConnectTimeout=10", args.host,
                        shlex.quote(args.remote_python) + " -"], input=code.encode(), stdout=out, check=True, timeout=180)
    with (args.destination / ".env").open("xb") as out:
        subprocess.run(["ssh", "-T", "-o", "ConnectTimeout=10", args.host,
                        "cat " + shlex.quote(str(Path(args.source) / args.env_name))], stdout=out, check=True, timeout=30)
    # This newly copied snapshot has no concurrent writer or WAL sidecar. Immutable mode also
    # lets macOS system SQLite validate a serialized WAL-mode database without creating sidecars.
    db = sqlite3.connect((args.destination / "res.db").resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise RuntimeError("SQLite 完整性检查失败")
    subscriptions = db.execute("SELECT count(*) FROM rsses").fetchone()[0]
    articles = db.execute("SELECT count(*) FROM articles").fetchone()[0]
    db.close()
except Exception:
    print(f"快照未完成，部分文件保留在 {args.destination}；未启停源端或目标服务。请检查 SSH、源路径和 Python 3.11+ 后换新目录重试。")
    raise
print(f"快照已保存：{subscriptions} 个订阅、{articles} 篇文章，SQLite 完整性正常。路径：{args.destination}")
print("本脚本未启停源服务；快照不含之后的新数据。尚未启动目标或验证登录状态，切换前须确认旧实例已停并使用最终快照。")
