#!/usr/bin/env bash
# External liveness check for the wechat2rss container.
#
# Deliberately external rather than using the service's own BOT_WEBHOOK_URL:
# a service that has crashed cannot send its own alert, and "the WeChat source
# stopped producing and nobody noticed for three days" is the exact failure this
# is here to prevent (see plans/20260816-mp2rss-replacement/state.md ISSUE-008).
#
# Covers five distinct terminal states, not just the happy path:
#   unreachable    — container down, port gone, or service wedged
#   apierr         — the service answered with an error payload
#   noaccount      — no WeChat account is logged in at all
#   login invalid  — WeRead session died; needs a QR re-scan
#   risk control   — WeChat throttling; usually self-clears, needs a phone tap
#                    if it persists
#
# Exit 0 = healthy, 1 = a problem was found and alerted.
#
# Delivery goes through `im-notify --alert --dedup-key wechat2rss-<kind>`, and
# that dedup is exact-text: once a key has fired, an identical recurrence is
# skipped until the key is cleared. So the healthy path must clear every key,
# or the first firing under a key (a deliberate exercise of the failure branch
# counts) suppresses every later real one. That is how the 2026-08-30 → 09-04
# outage went undelivered: 335 sends, all `skipped(unchanged)` against the
# signature left by the 2026-08-17 exercise (plans/20260816-mp2rss-replacement/
# state.md ISSUE-016).
set -uo pipefail
here=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
export IM_NOTIFY_BIN="${IM_NOTIFY_BIN:-im-notify}"

# One dedup key per problem identity (listed in docs/operations/services.md).
KEYS=(unreachable apierr noaccount login riskctl)
# The resolve has its own key, and its text carries the incident's first
# observation time: a resolve repeated for the *same* incident (state file not
# committable) is suppressed as unchanged, while the next incident's resolve
# differs by that timestamp and delivers without anyone having to clear the key.
RECOVERED_KEY=wechat2rss-recovered

mark_firing() {  # $1 = kind; keep the first observation time across repeats
  local cur; cur="$(cat "$STATE_FILE" 2>/dev/null || true)"
  [[ "$cur" == "firing $1 "* ]] && return 0
  printf 'firing %s %s\n' "$1" "$(date -u +%Y-%m-%dT%H:%MZ)" >"$STATE_FILE" 2>/dev/null
}
# Last outcome as seen by this probe, so the healthy path can tell "recovered"
# from "still fine". Sits beside the container's persistent data (gitignored).
# Unwritable state only costs the recovery notice; firing and clearing do not
# depend on it. Granularity is one probe: a recover-and-relapse that fits
# entirely between two cron runs is never observed, so it reads as one
# continuing incident (the operator was told it is down, and it is).
STATE_FILE="${WECHAT2RSS_STATE_FILE:-/home/ubuntu/aihot/shared/wechat2rss/data/healthcheck.state}"
export STATE_FILE

alert() {  # $1 = dedup key suffix, $2 = message
  echo "$2"
  mark_firing "$1"
  "$IM_NOTIFY_BIN" --alert --dedup-key "wechat2rss-$1" "$2" >/dev/null 2>&1 \
    || echo "WARN: im-notify failed to deliver: $2"
  exit 1
}

if [[ -n "${WECHAT2RSS_SSH_HOST:-}" ]]; then
  ssh_options=(-T -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3)
  if [[ -n "${WECHAT2RSS_SSH_KEY_FILE:-}" ]]; then
    [[ -n "${WECHAT2RSS_SSH_KNOWN_HOSTS_FILE:-}" ]] || alert unreachable 'Wechat2RSS 探针缺少专用 SSH 主机信任文件，健康未核实。请重新运行 probe-install.ts。'
    ssh_options+=(-F /dev/null -i "$WECHAT2RSS_SSH_KEY_FILE" -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$WECHAT2RSS_SSH_KNOWN_HOSTS_FILE")
  fi
  body="$(ssh "${ssh_options[@]}" "$WECHAT2RSS_SSH_HOST" \
    '/usr/local/bin/node --env-file=/home/ubuntu/aihot/shared/wechat2rss/service.env /home/ubuntu/aihot/current/deploy/wechat2rss/login-status.ts' 2>/dev/null)" \
    || alert unreachable "腾讯 Wechat2RSS 健康未核实：SSH 或健康检查失败，公众号采集可能受影响。请运行 ssh tencent-webserver-china 'bash /home/ubuntu/aihot/current/deploy/wechat2rss/service.sh status' 排查。"
else
  body="$(node --env-file="${WECHAT2RSS_ENV_FILE:-/home/ubuntu/aihot/shared/wechat2rss/service.env}" "$here/login-status.ts" 2>/dev/null)" \
    || alert unreachable "Wechat2RSS 健康未核实，公众号采集可能受影响。请运行 bash deploy/wechat2rss/service.sh status 排查。"
fi

python3 - "$body" <<'PY' || exit 1
import json, os, sys, subprocess, time

def alert(key, msg):
    print(msg)
    try:  # same contract as mark_firing above: keep the first observation time
        state = os.environ['STATE_FILE']
        try:
            cur = open(state).read()
        except OSError:
            cur = ''
        if not cur.startswith(f'firing {key} '):
            with open(state, 'w') as f:
                f.write(f'firing {key} {time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime())}\n')
    except (KeyError, OSError):
        pass
    try:
        r = subprocess.run([os.environ['IM_NOTIFY_BIN'],'--alert','--dedup-key',f'wechat2rss-{key}',msg],
                           capture_output=True)
        failed = r.returncode != 0
    except OSError:
        failed = True
    if failed:
        print(f'WARN: im-notify failed to deliver: {msg}')
    sys.exit(1)

try:
    d = json.loads(sys.argv[1])
except Exception:
    alert('unreachable', 'wechat2rss 返回了无法解析的响应，微信文章发现可能已停止')

if d.get('err'):
    alert('apierr', f"wechat2rss API 报错：{d['err']}")

accounts = d.get('data') or []
if not accounts:
    alert('noaccount', 'wechat2rss 没有任何已登录微信账号，抓取已停止，需要重新扫码登录')

dead = [a for a in accounts if not a.get('available')]
if dead:
    names = ', '.join(str(a.get('name') or a.get('id')) for a in dead)
    alert('login', f"wechat2rss 微信账号登录失效：{names}。需要重新扫码（服务无法自行恢复）")

throttled = [a for a in accounts if a.get('needCheck')]
if throttled:
    names = ', '.join(f"{a.get('name') or a.get('id')}(重试 {a.get('waitTime')})" for a in throttled)
    alert('riskctl', f"wechat2rss 账号处于微信风控中：{names}。会自动退避重试；若持续，在微信读书里打开 书架→文章收藏→点公众号名称")

print(f"healthy: {len(accounts)} 个账号可用，均未风控")
PY

# Healthy. Clear every key so the next real recurrence delivers again
# (--dedup-clear is idempotent), then one explicit resolve on a firing→healthy
# transition so the reader knows the incident ended. The state is committed to
# "healthy" only after both succeeded: a failed clear or a failed resolve leaves
# it as it was, so the next healthy run retries instead of silently accepting
# a stale signature (a retried resolve is deduplicated under RECOVERED_KEY; a
# stale signature costs the next outage).
prev="$(cat "$STATE_FILE" 2>/dev/null || true)"
clear_failed=""
for k in "${KEYS[@]}"; do  # try every key; one failure must not shadow the rest
  "$IM_NOTIFY_BIN" --dedup-clear "wechat2rss-$k" >/dev/null 2>&1 || clear_failed="$clear_failed wechat2rss-$k"
done
if [[ -n "$clear_failed" ]]; then
  echo "WARN: im-notify --dedup-clear failed for:$clear_failed; state left as-is for retry"
  exit 0
fi
if [[ "$prev" == firing* ]]; then
  read -r _ kind since <<<"$prev"
  msg="wechat2rss 已恢复：健康接口可达、微信账号可用且未风控（此前告警：${kind}，探针自 ${since:-?} 起观察到）。无需动作。这只证明服务侧健康；AIHOT 是否重新入库，以 mp_account 来源的下一轮 fetch_runs 与 worker 处理记录为准。"
  echo "$msg"
  "$IM_NOTIFY_BIN" --alert --dedup-key "$RECOVERED_KEY" "$msg" >/dev/null 2>&1 \
    || { echo "WARN: im-notify failed to deliver the recovery notice; state left as-is for retry"; exit 0; }
fi
printf 'healthy\n' >"$STATE_FILE" 2>/dev/null \
  || echo "WARN: cannot write $STATE_FILE; the resolve is deduplicated under $RECOVERED_KEY until it is writable"
exit 0
