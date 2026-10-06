#!/usr/bin/env python3
"""Read-only comparison of AIHOT public news with a configured source inventory."""
import argparse
import base64
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen


def date(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('时间必须包含时区')
    return result


def host(url):
    return (urlsplit(url).hostname or '').lower().removeprefix('www.')


def identity(item):
    url = item['links']['original']
    u = urlsplit(url)
    h = host(url)
    if h in ('x.com', 'twitter.com', 'mobile.twitter.com'):
        m = re.match(r'^/([A-Za-z0-9_]+)/status/\d+', u.path)
        if m and m[1].lower() not in ('i', 'intent'):
            return 'x:' + m[1].lower()
        return 'unknown:' + item['source']['name']
    if h == 'mp.weixin.qq.com':
        biz = parse_qs(u.query).get('__biz', [''])[0]
        try:
            value = base64.b64decode(biz + '=' * (-len(biz) % 4), validate=True).decode('ascii')
            if value.isdigit():
                return 'wechat:' + value
        except (ValueError, UnicodeError):
            pass
        return 'unknown:' + item['source']['name']
    # Preserve publisher sections/aggregators instead of collapsing every arXiv or GitHub item.
    return 'web:' + item['source']['name']


def source_keys(source):
    c = source['config']
    if source['kind'] == 'mp_account' and c.get('bizId'):
        return {'wechat:' + str(c['bizId'])}
    if source['kind'] == 'x_search':
        return {'x:' + v.lower() for v in re.findall(r'(?i)(?<![\w-])from:([A-Za-z0-9_]+)', c.get('query', ''))}
    return set()


def compare(items, sources, aliases=None):
    aliases = aliases or {}
    groups = {}
    for item in items:
        key = identity(item)
        group = groups.setdefault(key, {'identity': key, 'names': set(), 'articles': []})
        group['names'].add(item['source']['name'])
        group['articles'].append(item)
    for group in groups.values():
        key = group['identity']
        matches = []
        for s in sources:
            if key.startswith('web:') and s['id'] in aliases.get(key[4:], []):
                matches.append({'id': s['id'], 'name': s['name'], 'enabled': s['enabled'], 'basis': 'explicit_channel_alias'})
            elif key.startswith(('x:', 'wechat:')):
                if key in source_keys(s):
                    matches.append({'id': s['id'], 'name': s['name'], 'enabled': s['enabled'], 'basis': 'account_identity'})
            elif key.startswith('web:'):
                urls = [s['config'].get(k, '') for k in ('url', 'feedUrl', 'urlTemplate')]
                urls += s['config'].get('allowUrlPrefixes', [])
                domains = {host(u) for u in urls if u.startswith(('https://', 'http://'))}
                observed = {host(i['links']['original']) for i in group['articles']}
                if observed & domains:
                    matches.append({'id': s['id'], 'name': s['name'], 'enabled': s['enabled'], 'basis': 'same_host_only'})
        group['names'] = sorted(group['names'])
        group['originalHosts'] = sorted({host(i['links']['original']) for i in group['articles']})
        group['matches'] = matches
        enabled = [m for m in matches if m['enabled']]
        group['status'] = ('unresolved' if key.startswith('unknown:') else
                           'configured' if enabled and key.startswith(('x:', 'wechat:')) else
                           'channel_configured' if any(m['basis'] == 'explicit_channel_alias' for m in enabled) else
                           'site_match_review' if enabled else 'disabled' if matches else 'missing')
        group['count'] = len(group['articles'])
    return sorted(groups.values(), key=lambda g: (-g['count'], g['identity']))


def validate_page(data):
    if data.get('schemaVersion') != 1 or not isinstance(data.get('items'), list):
        raise ValueError('上游响应 schema 不受支持')
    if any(data.get('query', {}).get(k) != v for k, v in {'mode': 'all', 'window': '7d', 'by': 'timeline'}.items()):
        raise ValueError('上游未返回请求的 all / 7d / timeline 口径')
    page = data.get('page', {})
    if not isinstance(page.get('hasMore'), bool) or page.get('count') != len(data['items']):
        raise ValueError('上游分页字段不完整')
    if page['hasMore'] and (not data['items'] or not isinstance(page.get('nextCursor'), str) or not page['nextCursor']):
        raise ValueError('上游还有更多条目但缺少有效 cursor')
    for item in data['items']:
        if not isinstance(item.get('id'), str) or not item['id'] or not item.get('source', {}).get('name'):
            raise ValueError('上游条目缺少 id 或来源名称')
        if not host(item.get('links', {}).get('original', '')):
            raise ValueError('上游条目缺少原文 URL')
        date(item['discoveredAt'])
    return data


def crawl(fetch, max_pages=200):
    pages, items, seen, cursors = [], [], set(), set()
    cursor = None
    for _ in range(max_pages):
        data = validate_page(fetch(cursor))
        pages.append(data)
        for item in data['items']:
            if item['id'] not in seen:
                items.append(item)
                seen.add(item['id'])
        if not data['page']['hasMore']:
            return pages, items
        cursor = data['page']['nextCursor']
        if cursor in cursors:
            raise ValueError('上游重复 cursor；扫描未完成')
        cursors.add(cursor)
    raise ValueError('达到 max-pages；扫描未完成，不能宣称完整')


def production_inventory(ssh):
    # Explicit whitelist: never export credentials, provider tokens or the full config object.
    keys = ['url', 'feedUrl', 'query', 'bizId', 'allowUrlPrefixes', 'urlTemplate']
    pairs = ','.join("'%s',config->'%s'" % (k, k) for k in keys)
    sql = "SELECT json_agg(json_build_object('id',id,'name',name,'kind',kind,'enabled',enabled,'config',jsonb_strip_nulls(jsonb_build_object(%s)))) FROM sources;" % pairs
    result = subprocess.run(['ssh', '--', ssh, 'sudo -n -u postgres psql -X -At -d aihot -c ' + shlex.quote(sql)], check=True, capture_output=True, text=True, timeout=45)
    return {'label': ssh + ' production sources table', 'capturedAt': datetime.now(timezone.utc).isoformat(), 'sources': json.loads(result.stdout)}


def validate_inventory(inventory):
    sources = inventory.get('sources')
    if not isinstance(sources, list) or not sources:
        raise ValueError('来源清单为空或格式错误')
    ids = set()
    for s in sources:
        if not s.get('id') or s['id'] in ids or not isinstance(s.get('config'), dict):
            raise ValueError('来源清单缺少 id/config 或包含重复 id')
        ids.add(s['id'])
        if 'enabled' not in s:
            s['enabled'] = True  # seed.ts default
        if not isinstance(s['enabled'], bool):
            raise ValueError('enabled 必须是布尔值')
    return sources


STATUS = {'missing': '未配置', 'disabled': '已停用', 'unresolved': '身份待核实', 'site_match_review': '同站点，需核对范围', 'configured': '账号已配置', 'channel_configured': '渠道已配置'}


def markdown(report):
    counts = Counter(g['status'] for g in report['groups'])
    text = ['# AIHOT 来源缺口审计', '',
            f"收录窗口：{report['since']} 至 {report['until']}（discoveredAt）。", '',
            f"比较基线：{report['inventoryLabel']}；{report['enabledSources']} 个启用来源。扫描 {report['pages']} 页、{report['scannedItems']} 条去重公开动态，窗口内 {report['windowItems']} 条、{len(report['groups'])} 个来源身份。", '',
            '范围：官方 mode=all 的公开动态（包含非精选）；不是内部采集库。完整翻完 API 的 7 天时间轴窗口后按收录时间筛选；已删除、隐藏、过滤掉的内容与窗口外条目不可见。分页不是事务快照。', '',
            '账号已配置不等于采集健康；网站同域名不证明栏目、过滤规则或文章覆盖相同。此审计不能证明某来源是官方最近新添加的。', '',
            ' · '.join(f'{STATUS[k]} {counts[k]}' for k in STATUS), '']
    for status, label in STATUS.items():
        text += ['## ' + label, '', '| 来源身份 / 官方名称 | 条数 | 本地匹配 | 示例 |', '|---|---:|---|---|']
        for g in report['groups']:
            if g['status'] != status:
                continue
            item = g['articles'][0]
            esc = lambda s: str(s).replace('|', '\\|').replace('\n', ' ')
            local = ', '.join(m['id'] for m in g['matches']) or '—'
            text.append(f"| {esc(g['identity'])}<br>{esc(' / '.join(g['names']))} | {g['count']} | {esc(local)} | [官方文章]({item['links']['aihot']}) · [原文]({item['links']['original']}) |")
        text += ['']
    return '\n'.join(text)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base', default='https://aihot.news')
    p.add_argument('--hours', type=float, default=48)
    p.add_argument('--until', help='ISO 时间，默认运行开始时刻；必须在官方7天窗口内')
    inv = p.add_mutually_exclusive_group(required=True)
    inv.add_argument('--sources', type=Path, help='industry/sources.json 或已导出的生产来源 JSON')
    inv.add_argument('--ssh', help='通过 SSH 只读导出生产 aihot 库来源，例如 tencent-webserver-china')
    p.add_argument('--out', type=Path, required=True, help='新输出目录；拒绝覆盖已有目录')
    p.add_argument('--replay', type=Path, help='读取旧报告目录的 capture.json，离线重新比较')
    p.add_argument('--max-pages', type=int, default=200)
    p.add_argument('--aliases', type=Path, default=Path(__file__).resolve().parent.parent / 'industry/source-audit-aliases.json', help='官方来源名到本地 source ID 的已核实渠道映射')
    a = p.parse_args()
    if not 0 < a.hours <= 144 or a.max_pages < 1:
        p.error('hours 必须在 (0,144] 内，max-pages 必须大于0；为滚动窗口留余量')
    until = date(a.until) if a.until else datetime.now(timezone.utc)
    if a.replay:
        capture = json.loads((a.replay / 'capture.json').read_text())
        until = date(capture['until'])
    elif not datetime.now(timezone.utc) - timedelta(hours=168-a.hours) < until <= datetime.now(timezone.utc):
        p.error('请求窗口超出当前 API 7天范围')
    inventory = production_inventory(a.ssh) if a.ssh else json.loads(a.sources.read_text())
    sources = validate_inventory(inventory)
    aliases = json.loads(a.aliases.read_text())
    if not isinstance(aliases, dict) or any(not isinstance(v, list) or not all(isinstance(i, str) for i in v) for v in aliases.values()):
        raise ValueError('aliases 必须是来源名称到 source ID 数组的对象')
    a.out.mkdir(parents=True, exist_ok=False)
    (a.out / 'inventory.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + '\n')
    (a.out / 'aliases.json').write_text(json.dumps(aliases, ensure_ascii=False, indent=2) + '\n')
    if a.replay:
        iterator = iter(capture['pages'])
        pages, items = crawl(lambda _: next(iterator), a.max_pages)
    else:
        def fetch(cursor):
            query = {'mode': 'all', 'window': '7d', 'by': 'timeline', 'limit': 100}
            if cursor:
                query['cursor'] = cursor
            req = Request(a.base.rstrip('/') + '/api/v1/items?' + urlencode(query), headers={'User-Agent': 'AIHOT-source-gap-audit/1.0', 'Accept': 'application/json'})
            with urlopen(req, timeout=40) as response:
                data = json.load(response)
            # Cursor dependency is sequential; stay below the documented 60 requests/minute.
            time.sleep(1.1)
            print(f"已读取第 {fetch.page} 页：{len(data.get('items', []))} 条", file=sys.stderr)
            (a.out / f'page-{fetch.page:04d}.json').write_text(json.dumps(data, ensure_ascii=False) + '\n')
            fetch.page += 1
            return data
        fetch.page = 1
        pages, items = crawl(fetch, a.max_pages)
        capture = {'until': until.isoformat(), 'base': a.base, 'pages': pages}
    (a.out / 'capture.json').write_text(json.dumps(capture, ensure_ascii=False) + '\n')
    since = until - timedelta(hours=a.hours)
    selected = [i for i in items if since <= date(i['discoveredAt']) <= until]
    report = {'since': since.isoformat(), 'until': until.isoformat(), 'base': capture['base'],
              'inventoryLabel': inventory.get('label', str(a.sources)), 'inventoryCapturedAt': inventory.get('capturedAt'),
              'inventorySha256': hashlib.sha256((a.out / 'inventory.json').read_bytes()).hexdigest(),
              'enabledSources': sum(s['enabled'] for s in sources), 'pages': len(pages), 'scannedItems': len(items),
              'windowItems': len(selected), 'groups': compare(selected, sources, aliases)}
    (a.out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (a.out / 'report.md').write_text(markdown(report) + '\n')
    print(f"查询完成：窗口内 {len(selected)} 条公开动态、{len(report['groups'])} 个来源身份。报告：{a.out / 'report.md'}")
    print('仅比较来源配置；同站点匹配需人工核对范围，未验证采集健康。')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'审计未完成（{type(error).__name__}）；不得据此判定无缺口。已取页面保留在输出目录。检查参数、网络或上游分页后换新目录重跑。', file=sys.stderr)
        sys.exit(1)
