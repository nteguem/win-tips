"""Dated source subsets stay verified, audited and outside the API schema."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from editorial_worker import sources as s, runner
from editorial_worker.http import FetchError
from test_petit_clock_rounding import ready, preflight
from test_worker import args

POLICY = {'RDJ_PETIT_PUBLICATION_POLICY': s.PETIT_UPCOMING_POLICY}


def packet(fixture, now):
    fixture = deepcopy(fixture)
    fixture['provenance']['card_index'] = 0
    return {'status': 'ready', 'fixtures': [fixture], 'issues': [], 'provenance': {'card_selection': {
        'policy': s.PETIT_UPCOMING_POLICY, 'minimum_lead_minutes': 30,
        'checked_at_utc': now.isoformat(), 'source_card_count': 2, 'validated_card_count': 2,
        'included_card_indexes': [0], 'included_source_ids': [fixture['id']],
        'included_count': 1, 'excluded_count': 1,
        'excluded': [{'card_index': 1, 'source_id': '9999', 'reason': 'minimum_publication_lead_not_met'}]}}}


def api_config(items, now, day='2026-10-31'):
    window = {'source': 'rdj_petit_journal', 'ready': False, 'reason': 'published_inventory_not_proven'}
    if items:
        window = {'source': 'rdj_petit_journal', 'ready': True, 'categoryId': 'a' * 24,
            'count': len(items), 'items': deepcopy(items),
            'latestStartsAtUtc': max(row['startsAtUtc'] for row in items)}
    return {'date': day, 'importEnabled': True, 'notificationsEnabled': True,
        'sources': [{'key': 'rdj_petit_journal', 'access': 'free', 'categoryIds': ['a' * 24],
            'editorialCopyState': {'state': 'frozen' if items else 'new', 'legacy': False}}],
        'publishedSourceWindows': {'version': 'published-source-windows-v1', 'editionDate': day,
            'checkedAtUtc': now.isoformat(), 'sources': [window]}}


def current_day_item():
    item, _, _, _, _ = ready()
    item = deepcopy(item)
    item['editionDate'] = '2026-10-31'
    item['sourceUrl'] = item['sourceUrl'].replace('30-octobre', '31-octobre')
    item.pop('scheduleProof', None)
    item.pop('editionConvention', None)
    return item


def paired_ready():
    item, fixture, detail, value, now = ready()
    other = deepcopy(fixture)
    other['id'] = '6014935'
    other['source_url'] = value.url.replace('6014934', '6014935')
    other['provenance']['kickoff_resolution']['source_url'] = other['source_url']
    original = packet(fixture, now)
    original['fixtures'].append(other)
    other['provenance']['card_index'] = 1
    original['provenance']['card_selection'].update(included_card_indexes=[0, 1],
        included_source_ids=[fixture['id'], other['id']], included_count=2, excluded_count=0, excluded=[])
    second = s.rdj.FetchedPage(other['source_url'], value.html)
    return item, fixture, other, detail, value, second, now, original


class UpcomingContractTests(unittest.TestCase):
    def test_published_partial_snapshot_stays_immutable_when_source_or_policy_changes(self):
        item = current_day_item()
        now = datetime(2026, 10, 31, tzinfo=timezone.utc)
        current = [now]
        class Api:
            def __init__(self): self.items, self.calls, self.notifications = [], [], 0
            def request(self, route, payload=None):
                self.calls.append((route, deepcopy(payload)))
                if route.endswith('/config'): return api_config(self.items, current[0])
                if route.endswith('/import'):
                    self.items = deepcopy(payload['items'])
                    self.notifications += 1
                    return {'imported': len(self.items), 'notificationsSent': 1}
                return {'sent': 0, 'pending': 0}
        class Translator:
            records = []
            def text(self, value, item): return value
            def market(self, value, item): return value
        result = {'status': 'ready', 'items': [item], 'issues': []}
        api = Api()
        fetcher = type('Fetcher', (), {'requests': 0, 'records': []})()
        with TemporaryDirectory() as directory, patch.dict(os.environ, {'RDJ_PETIT_PUBLICATION_POLICY': 'all-cards-required-v1'}), \
                patch.object(runner, 'collect', return_value=result):
            first = runner.run(args(directory, edition=item['editionDate'], source=['rdj_petit_journal'],
                api_base='http://localhost:4300', publish=True), fetcher=fetcher, now=now,
                clock=lambda: current[0], api_client=api, translator=Translator(),
                api_validator=lambda payload, clock: preflight(payload['items'][0], clock))
            self.assertTrue(first['published'], first)
            frozen = deepcopy(api.items)
            payload_file = Path(first['sources'][0]['payloadFile'])
            frozen_bytes = payload_file.read_bytes()
            current[0] = datetime(2026, 10, 31, 0, 10, tzinfo=timezone.utc)
            # The new policy would exclude the old first card or read a changed
            # source clock. A verified API publication still wins over all of it.
            with patch.dict(os.environ, POLICY), patch.object(runner, 'collect', side_effect=AssertionError('published snapshot must not be recollected')):
                second = runner.run(args(directory, edition=item['editionDate'], source=['rdj_petit_journal'],
                    api_base='http://localhost:4300', publish=True), fetcher=fetcher, now=current[0],
                    clock=lambda: current[0], api_client=api, translator=Translator())
            self.assertEqual(api.items, frozen)
            self.assertEqual(payload_file.read_bytes(), frozen_bytes)
            self.assertEqual(api.notifications, 1)
            self.assertEqual(sum(route.endswith('/import') for route, _ in api.calls), 1)
            self.assertEqual(second['sources'][0]['status'], 'published_snapshot_preserved')
            self.assertEqual(second['publishedSources'], ['rdj_petit_journal'])
            self.assertFalse(second['blocked'])

    def test_frozen_snapshot_requires_fresh_bound_api_inventory_not_local_flags(self):
        item = current_day_item()
        now = datetime(2026, 10, 31, tzinfo=timezone.utc)
        original = api_config([item], now)
        changes = [lambda row: row['publishedSourceWindows'].update(editionDate='2026-10-30'),
            lambda row: row['publishedSourceWindows'].update(checkedAtUtc='2026-10-30T20:00:00Z'),
            lambda row: row['publishedSourceWindows']['sources'][0].update(ready=False),
            lambda row: row['publishedSourceWindows']['sources'][0].update(count=2),
            lambda row: row['publishedSourceWindows']['sources'][0].update(categoryId='b' * 24),
            lambda row: row['publishedSourceWindows']['sources'][0].update(latestStartsAtUtc='2026-10-31T04:00:00Z'),
            lambda row: row['sources'][0]['editorialCopyState'].update(state='unknown'),
            lambda row: row['sources'][0]['editorialCopyState'].update(state='new')]
        for mutate in changes:
            changed = deepcopy(original)
            mutate(changed)
            with self.subTest(config=changed), patch.dict(os.environ, POLICY), self.assertRaises(ValueError):
                runner.published_petit_snapshot(changed, item['editionDate'], now)

    def test_publication_appearing_during_translation_is_not_overwritten(self):
        item = current_day_item()
        now = datetime(2026, 10, 31, tzinfo=timezone.utc)
        result = {'status': 'ready', 'items': [item], 'issues': [],
            'sourceSelectionAudit': {'canonicalSelection': {'policy': s.PETIT_UPCOMING_POLICY}}}
        class Api:
            def __init__(self): self.reads = 0
            def request(self, route, payload=None):
                if not route.endswith('/config'):
                    raise AssertionError('No import or notification when already published')
                self.reads += 1
                value = api_config([] if self.reads == 1 else [item], now)
                value['notificationsEnabled'] = False
                return value
        class Translator:
            records = []
            def text(self, value, item): return value
            def market(self, value, item): return value
        api = Api()
        with TemporaryDirectory() as directory, patch.dict(os.environ, POLICY), \
                patch.object(runner, 'collect', return_value=result):
            report = runner.run(args(directory, edition=item['editionDate'], source=['rdj_petit_journal'],
                api_base='http://localhost:4300', publish=True),
                fetcher=type('Fetcher', (), {'requests': 0, 'records': []})(), now=now,
                clock=lambda: now, api_client=api, translator=Translator(),
                api_validator=lambda *_: self.fail('Already published must precede preflight/import'))
        self.assertEqual(api.reads, 2)
        self.assertFalse(report['blocked'], report)
        self.assertEqual(report['sources'][0]['status'], 'published_snapshot_preserved')

    def test_atomic_server_ignored_reply_requires_a_new_inventory_read_and_is_reported_as_preserved(self):
        item = current_day_item()
        now = datetime(2026, 10, 31, tzinfo=timezone.utc)
        result = {'status': 'ready', 'items': [item], 'issues': [],
            'sourceSelectionAudit': {'canonicalSelection': {'policy': s.PETIT_UPCOMING_POLICY}}}
        class Api:
            def __init__(self): self.reads, self.posts, self.frozen = 0, 0, False
            def request(self, route, payload=None):
                if route.endswith('/config'):
                    self.reads += 1
                    value = api_config([item] if self.frozen else [], now)
                    value['notificationsEnabled'] = False
                    return value
                if route.endswith('/import'):
                    self.posts += 1
                    self.frozen = True  # competing first import won after GET
                    return {'ignored': True, 'reason': 'published_petit_journal_edition_preserved',
                        'imported': 0, 'notificationsSent': 0}
                raise AssertionError('No extra POST/drain permitted')
        class Translator:
            records = []
            def text(self, value, item): return value
            def market(self, value, item): return value
        api = Api()
        with TemporaryDirectory() as directory, patch.dict(os.environ, POLICY), patch.object(runner, 'collect', return_value=result):
            report = runner.run(args(directory, edition=item['editionDate'], source=['rdj_petit_journal'],
                api_base='http://localhost:4300', publish=True), fetcher=type('Fetcher', (), {'requests': 0, 'records': []})(),
                now=now, clock=lambda: now, api_client=api, translator=Translator(),
                api_validator=lambda payload, clock: preflight(payload['items'][0], clock))
        self.assertEqual((api.reads, api.posts), (3, 1))
        self.assertFalse(report['blocked'], report)
        self.assertEqual(report['publishedSources'], ['rdj_petit_journal'])
        self.assertFalse(report['sources'][0]['imported'])
        self.assertTrue(report['sources'][0]['publishedSnapshot']['verified'])

    def test_partial_requires_operator_opt_in_and_complete_exclusion_accounting(self):
        item, fixture, _, _, now = ready()
        original = packet(fixture, now)
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(s.ParseError):
            s._petit_selection_audit(original, item['editionDate'], now, 30)
        changes = [lambda row: row['provenance']['card_selection'].update(included_count=2),
            lambda row: row['provenance']['card_selection'].update(source_card_count=3),
            lambda row: row['provenance']['card_selection'].update(included_card_indexes=[1]),
            lambda row: row['provenance']['card_selection'].update(included_source_ids=['wrong']),
            lambda row: row['provenance']['card_selection']['excluded'][0].update(card_index=0),
            lambda row: row['provenance']['card_selection'].update(minimum_lead_minutes=0)]
        for mutate in changes:
            changed = deepcopy(original)
            mutate(changed)
            with self.subTest(packet=changed), patch.dict(os.environ, POLICY), self.assertRaises(s.ParseError):
                s._petit_selection_audit(changed, item['editionDate'], now, 30)

    def test_private_evidence_keeps_exclusions_and_original_clock_proof(self):
        item, fixture, detail, value, now = ready()
        original = packet(fixture, now)
        with patch.dict(os.environ, POLICY), patch.object(s.rdj, 'collect_edition', return_value=original), \
                patch.object(s.rdj, '_detail', return_value=detail):
            result = s.collect_petit(item['editionDate'], type('Fetcher', (), {'html': lambda _, url: value})(),
                now=now, resolver=None)
        self.assertEqual(result['items'], [item])
        self.assertEqual(result['sourceSelectionAudit']['canonicalSelection'], original['provenance']['card_selection'])
        self.assertEqual(result['sourceSelectionAudit']['fixtureEvidence'][0]['provenance'], original['fixtures'][0]['provenance'])
        self.assertTrue(preflight(result['items'][0], now)['passed'])
        self.assertNotIn('sourceSelectionAudit', result['items'][0])

    def test_typed_reread_cannot_replace_canonical_participants_clock_or_analysis(self):
        _, fixture, detail, value, _ = ready()
        fixture['analysis_fr'] = detail['analysis_fr']
        for field, bad in [('home', 'Another player'), ('sport', 'football'),
                ('competition', 'Another competition'), ('kickoff', datetime(2030, 1, 1)),
                ('analysis_fr', 'invented replacement analysis')]:
            with self.subTest(field=field), self.assertRaises(s.ParseError):
                s._petit_fixture_evidence(fixture, {**detail, field: bad}, value)

    def test_one_changed_reread_never_invalidates_the_other_verified_card(self):
        item, fixture, other, detail, value, second_page, now, original = paired_ready()
        with patch.dict(os.environ, POLICY), patch.object(s.rdj, 'collect_edition', return_value=original), \
                patch.object(s.rdj, '_detail', side_effect=[{**detail, 'home': 'Wrong participant'}, detail]):
            result = s.collect_petit(item['editionDate'],
                type('Fetcher', (), {'html': lambda _, url: value if url == value.url else second_page})(),
                now=now, resolver=None)
        self.assertEqual(result['status'], 'ready', result)
        self.assertEqual([row['sourceId'] for row in result['items']], [other['id']])
        self.assertEqual(result['sourceSelectionAudit']['consumerExcluded'], [{'sourceId': fixture['id'],
            'sourceUrl': fixture['source_url'], 'reason': 'consumer_fixture_no_longer_verified',
            'code': 'petit_canonical_fixture_changed'}])
        self.assertTrue(preflight(result['items'][0], now)['passed'])

    def test_missing_or_unparseable_page_and_typed_error_exclude_only_that_card(self):
        for failure in ('404', 'incomplete_html', 'typed_validation'):
            item, fixture, other, detail, value, second, now, original = paired_ready()
            first = (s.rdj.FetchedPage(value.url, '<html>Source changed</html>', 404 if failure == '404' else 200)
                if failure != 'typed_validation' else value)
            actual_match = s.match_item
            def match(detail, page, *args, **kwargs):
                if failure == 'typed_validation' and page.url == value.url:
                    raise s.ParseError('explicit_expert_outcome_missing')
                return actual_match(detail, page, *args, **kwargs)
            with self.subTest(failure=failure), patch.dict(os.environ, POLICY), \
                    patch.object(s.rdj, 'collect_edition', return_value=original), patch.object(s, 'match_item', side_effect=match):
                result = s.collect_petit(item['editionDate'],
                    type('Fetcher', (), {'html': lambda _, url: first if url == value.url else second})(),
                    now=now, resolver=None)
            self.assertEqual(result['status'], 'ready', result)
            self.assertEqual([row['sourceId'] for row in result['items']], [other['id']])
            excluded = result['sourceSelectionAudit']['consumerExcluded'][0]
            self.assertEqual(excluded['sourceUrl'], value.url)
            self.assertEqual(excluded['sourceId'], fixture['id'])
            self.assertTrue(excluded['code'])

    def test_global_budget_and_unexpected_programming_errors_never_authorize_partial_publication(self):
        item, _, _, detail, value, _, now, original = paired_ready()
        for error in (FetchError('public_request_budget_exceeded'), FetchError('public_time_budget_exceeded'),
                ValueError('unexpected programming error')):
            with self.subTest(error=str(error)), patch.dict(os.environ, POLICY), \
                    patch.object(s.rdj, 'collect_edition', return_value=original), patch.object(s.rdj, '_detail', side_effect=error), \
                    self.assertRaises(type(error)):
                s.collect_petit(item['editionDate'], type('Fetcher', (), {'html': lambda _, url: value})(), now=now, resolver=None)

    def test_source_failure_stays_all_or_nothing_under_the_historical_strict_policy(self):
        item, _, _, _, value, _, now, original = paired_ready()
        original.pop('provenance')
        with patch.dict(os.environ, {'RDJ_PETIT_PUBLICATION_POLICY': 'all-cards-required-v1'}), \
                patch.object(s.rdj, 'collect_edition', return_value=original), \
                patch.object(s.rdj, '_detail', side_effect=s.rdj.SourceError('source_incomplete', 'synthetic incomplete page')), \
                self.assertRaises(s.rdj.SourceError):
            s.collect_petit(item['editionDate'], type('Fetcher', (), {'html': lambda _, url: value})(), now=now, resolver=None)

    def test_translation_delay_removes_only_closed_card_and_audits_before_actual_js_preflight(self):
        item, _, _, _, now = ready()
        second = deepcopy(item)
        second.update(sourceId='6014935', startsAtUtc='2026-10-31T05:35:00Z')
        # This test exercises runner orchestration; the second card stays on the
        # edition day and has no next-day exception or reconciliation metadata.
        second['editionDate'] = '2026-10-31'
        second['sourceUrl'] = item['sourceUrl'].replace('30-octobre', '31-octobre')
        second.pop('scheduleProof', None)
        second.pop('editionConvention', None)
        first = deepcopy(second)
        first.update(sourceId='6014934', startsAtUtc='2026-10-31T00:35:00Z')
        now = datetime(2026, 10, 31, tzinfo=timezone.utc)
        after = datetime(2026, 10, 31, 0, 5, tzinfo=timezone.utc)  # exact 30-minute frontier
        result = {'status': 'ready', 'issues': [], 'items': [first, second],
            'sourceSelectionAudit': {'canonicalSelection': {'policy': s.PETIT_UPCOMING_POLICY},
                'includedSourceIds': [first['sourceId'], second['sourceId']]}}
        class Api:
            def __init__(self): self.calls = []
            def request(self, route, payload=None):
                self.calls.append((route, deepcopy(payload)))
                if route.endswith('/config'):
                    return {'date': '2026-10-31', 'importEnabled': True, 'notificationsEnabled': False,
                        'sources': [{'key': 'rdj_petit_journal', 'categoryIds': ['test-only']}]}
                return {'imported': 1, 'notificationsSent': 0}
        class Translator:
            records = []
            def text(self, value, item): return value
            def market(self, value, item): return value
        api = Api()
        with TemporaryDirectory() as directory, patch.object(runner, 'collect', return_value=result):
            report = runner.run(args(directory, edition='2026-10-31', source=['rdj_petit_journal'],
                api_base='http://localhost:4300', publish=True), fetcher=type('Fetcher', (), {'requests': 0, 'records': []})(),
                now=now, clock=lambda: after, api_client=api, translator=Translator(),
                api_validator=lambda payload, check_clock: preflight(payload['items'][0], check_clock))
            self.assertFalse(report['blocked'], report)
            submitted = next(payload for route, payload in api.calls if route.endswith('/import'))
            self.assertEqual([item['sourceId'] for item in submitted['items']], [second['sourceId']])
            row = report['sources'][0]
            audit_file = Path(row['sourceSelectionAuditFile'])
            self.assertEqual(hashlib.sha256(audit_file.read_bytes()).hexdigest(), row['sourceSelectionAuditSha256'])
            audit = json.loads(audit_file.read_text('utf-8'))
            self.assertEqual(audit['deliverySelection']['excluded'][0]['sourceId'], first['sourceId'])
            self.assertEqual(row['itemCount'], 1)
            self.assertTrue(row['apiPreflight']['passed'])
            self.assertNotIn('sourceSelectionAudit', submitted)


@unittest.skipUnless(os.environ.get('RDJ_TEST_HUB_CODE_ROOT'), 'canonical shared checkout required')
class RealNovember10Tests(unittest.TestCase):
    def collect(self, now, tennis_proof=True):
        code = Path(os.environ['RDJ_TEST_HUB_CODE_ROOT']).resolve()
        fixture_path = code.parent / 'journal-parieur-worker/journal_worker/tests/fixtures/rdj-petit-20261110-excerpt.json'
        pages = json.loads(fixture_path.read_text('utf-8'))['pages']
        class Offline:
            def html(self, url):
                if url not in pages: raise AssertionError('Unexpected HTTP source: ' + url)
                return s.rdj.FetchedPage(url, pages[url])
        def resolver(fixture, edition):
            if fixture['sport'] == 'tennis':
                if not tennis_proof: return None
                return {'kickoff_utc': '2026-11-10T14:35:00Z',
                    'source_url': 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard?dates=20261109',
                    'source_id': '186527', 'method': 'provider_schedule', 'provider': 'ESPN',
                    'time_valid': True, 'status': 'pre', 'orientation': 'reversed',
                    'matched_participants': ['Arthur Rinderknech', 'Miomir Kecmanovic'],
                    'tournament_id': '148-2026', 'tournament_name': 'Bybit Stockholm Open', 'match_type': 'mens-singles'}
            return {'kickoff_utc': '2026-11-11T04:00:00Z', 'method': 'official_schedule',
                'source_url': 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json',
                'source_id': '0022600216'}
        with TemporaryDirectory() as directory, patch.dict(os.environ, {**POLICY,
                'RDJ_CONTENT_HUB_DIR': directory, 'RDJ_HUB_CODE_ROOT': str(code)}):
            return s.collect_petit('2026-11-10', Offline(), now=now, resolver=resolver)

    def test_late_tennis_does_not_hide_verified_future_nba_or_change_its_source(self):
        now = datetime(2026, 11, 10, 15, tzinfo=timezone.utc)
        result = self.collect(now)
        self.assertEqual(result['status'], 'ready', result)
        self.assertEqual([row['sourceId'] for row in result['items']], ['6019799'])
        item = result['items'][0]
        self.assertEqual(item['source'], 'rdj_petit_journal')
        self.assertEqual(item['startsAtUtc'], '2026-11-11T04:00:00Z')
        self.assertEqual(item['selection']['label']['fr'], 'Victoire OKC')
        self.assertEqual(item['selection']['odds'], 1.7)
        self.assertTrue(preflight(item, now)['passed'])
        selection = result['sourceSelectionAudit']['canonicalSelection']
        self.assertEqual(selection['excluded'][0]['source_id'], '6578489')
        self.assertEqual(selection['excluded'][0]['reason'], 'minimum_publication_lead_not_met')

    def test_missing_tennis_schedule_is_excluded_never_guessed_or_replaced(self):
        now = datetime(2026, 11, 10, 10, tzinfo=timezone.utc)
        result = self.collect(now, tennis_proof=False)
        self.assertEqual([row['sourceId'] for row in result['items']], ['6019799'])
        excluded = result['sourceSelectionAudit']['canonicalSelection']['excluded']
        self.assertEqual(excluded[0]['reason'], 'source_card_not_verified')

    def test_photo_refresh_and_dynamic_tennis_time_keep_their_full_private_proof(self):
        now = datetime(2026, 11, 10, 10, tzinfo=timezone.utc)
        result = self.collect(now)
        self.assertEqual([row['sourceId'] for row in result['items']], ['6578489', '6019799'])
        first = result['items'][0]
        self.assertEqual(first['startsAtUtc'], '2026-11-10T14:35:00Z')
        proof = result['sourceSelectionAudit']['fixtureEvidence'][0]['provenance']
        self.assertEqual(proof['participant_identity_resolution']['journal_photo_ids'], ['686569', '651501'])
        self.assertEqual(proof['participant_identity_resolution']['detail_photo_ids'], ['495087', '651501'])
        self.assertEqual(proof['kickoff_resolution']['journal_clock_update']['delta_seconds'], -1500)
        self.assertTrue(preflight(first, now)['passed'])
        self.assertFalse({'rdj_nba', 'rdj_tennis'} & set(s.SOURCES))


if __name__ == '__main__': unittest.main()
