import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('audit-source-gaps.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def item(id='one', url='https://x.com/Alice/status/123', name='X Alice'):
    return {'id': id, 'source': {'name': name}, 'links': {'original': url, 'aihot': 'https://aihot.news/items/' + id}, 'discoveredAt': '2026-10-06T01:00:00Z'}


def page(items, cursor=None):
    return {'schemaVersion': 1, 'query': {'mode': 'all', 'window': '7d', 'by': 'timeline'}, 'items': items, 'page': {'count': len(items), 'hasMore': cursor is not None, 'nextCursor': cursor}}


class SourceAuditTest(unittest.TestCase):
    def test_identities(self):
        self.assertEqual(audit.identity(item()), 'x:alice')
        self.assertEqual(audit.identity(item(url='https://twitter.com/ALICE/status/5')), 'x:alice')
        self.assertEqual(audit.identity(item(url='https://mp.weixin.qq.com/s?__biz=MzU5NTkwNDU2OA%3D%3D')), 'wechat:3595904568')
        self.assertTrue(audit.identity(item(url='https://mp.weixin.qq.com/s/opaque')).startswith('unknown:'))
        self.assertTrue(audit.identity(item(url='https://x.com/i/status/123')).startswith('unknown:'))

    def test_match_states_and_scope(self):
        sources = [{'id': 'alice', 'kind': 'x_search', 'name': 'Alice', 'enabled': True, 'config': {'query': 'from:ALICE -filter:replies'}},
                   {'id': 'bob', 'kind': 'x_search', 'name': 'Bob', 'enabled': False, 'config': {'query': 'from:bob'}},
                   {'id': 'blog', 'kind': 'rss', 'name': 'Example blog', 'enabled': True, 'config': {'feedUrl': 'https://www.example.com/blog/rss'}}]
        items = [item(), item('b', 'https://x.com/bob/status/2'), item('c', 'https://x.com/carol/status/3'),
                 item('d', 'https://example.com/other/1', 'Example newsroom'), item('e', 'https://mp.weixin.qq.com/s/opaque')]
        result = {g['identity']: g for g in audit.compare(items, sources)}
        self.assertEqual(result['x:alice']['status'], 'configured')
        self.assertEqual(result['x:bob']['status'], 'disabled')
        self.assertEqual(result['x:carol']['status'], 'missing')
        self.assertEqual(result['web:Example newsroom']['status'], 'site_match_review')
        self.assertEqual(result['unknown:X Alice']['status'], 'unresolved')

    def test_aggregate_channel_keeps_publishers_together(self):
        items = [item('a', 'https://a.example/1', 'HN'), item('b', 'https://b.example/2', 'HN')]
        sources = [{'id': 'hn', 'name': 'HN feed', 'kind': 'rss', 'enabled': True, 'config': {'feedUrl': 'https://hn.example/feed'}}]
        result = audit.compare(items, sources, {'HN': ['hn']})
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['originalHosts'], ['a.example', 'b.example'])
        self.assertEqual(result[0]['status'], 'channel_configured')
        self.assertEqual(audit.compare(items, sources)[0]['status'], 'missing')

    def test_pagination_dedup_and_full_scan(self):
        pages = [page([item()], 'c1'), page([item(), item('two')])]
        seen = []
        def fetch(cursor):
            seen.append(cursor)
            return pages[len(seen)-1]
        result, items = audit.crawl(fetch)
        self.assertEqual(seen, [None, 'c1'])
        self.assertEqual(len(result), 2)
        self.assertEqual(len(items), 2)

    def test_incomplete_fails(self):
        with self.assertRaises(ValueError):
            audit.crawl(lambda _: page([item()], 'loop'))
        with self.assertRaises(ValueError):
            audit.crawl(lambda _: page([item()], 'next'), max_pages=1)
        bad = page([item()]); bad['query']['mode'] = 'selected'
        with self.assertRaises(ValueError):
            audit.validate_page(bad)
        bad = page([item()]); bad['items'][0]['links']['original'] = ''
        with self.assertRaises(ValueError):
            audit.validate_page(bad)
        with self.assertRaises(ValueError):
            audit.validate_inventory({'sources': []})

    def test_seed_default_and_timezone(self):
        s = audit.validate_inventory({'sources': [{'id': 'a', 'config': {}}]})
        self.assertTrue(s[0]['enabled'])
        with self.assertRaises(ValueError):
            audit.date('2026-10-06T00:00:00')

    def test_excluded_x_author_is_not_configured(self):
        s = {'kind': 'x_search', 'config': {'query': 'AI -from:alice from:bob'}}
        self.assertEqual(audit.source_keys(s), {'x:bob'})


if __name__ == '__main__':
    unittest.main()
