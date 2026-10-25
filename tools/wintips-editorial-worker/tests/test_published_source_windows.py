"""Offline inventory/no-op contracts; no HTTP, models, import or notification."""
from argparse import Namespace
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from editorial_worker import runner, sources

FIXTURES = Path(__file__).parent / 'fixtures'
DAY = '2026-10-24'
NOW = datetime(2026, 10, 24, 21, tzinfo=timezone.utc)
PETIT, TURF = 'rdj_petit_journal', 'rdj_turf_quinte'
PACKET = json.loads((FIXTURES / 'rdj-petit-20261024-excerpt.json').read_text('utf-8'))
JOURNAL = next(url for url in PACKET['pages'] if '/le-petit-journal/' in url)
COURSE = 'https://www.ruedesjoueurs.com/turf/pronostic-turf/course/24-10-2026/R1/C3/prix-de-beaune.html'


def configuration(now=NOW):
    # Typed identity projection of the three real manually published Free items.
    # The archive/excerpt and synthetic index wrappers are not a new live fetch.
    def team(name, logo):
        return {'name': name, 'logo': 'https://img.ruedesjoueurs.com/img/' + logo + '-2.png'}
    items = [
        {'sourceId': '5795487', 'sourceUrl': JOURNAL, 'kind': 'match', 'startsAtUtc': DAY + 'T16:30:00Z',
         'sport': {'key': 'football'}, 'competition': {'name': 'Premier League'},
         'teams': {'home': team('Chelsea', '8455'), 'away': team('Tottenham', '8586')}},
        {'sourceId': '5803298', 'sourceUrl': JOURNAL, 'kind': 'match', 'startsAtUtc': DAY + 'T18:45:00Z',
         'sport': {'key': 'football'}, 'competition': {'name': 'Ligue 2'},
         'teams': {'home': team('Saint-Etienne', '9853'), 'away': team('Nantes', '9830')}},
    ]
    race = {'sourceId': DAY + '-R1C3', 'sourceUrl': COURSE, 'kind': 'horse_racing',
            'startsAtUtc': DAY + 'T13:15:00Z', 'sport': {'key': 'horse_racing'},
            'race': {'meetingNumber': 1, 'raceNumber': 3}}
    return {'date': DAY, 'importEnabled': True, 'notificationsEnabled': False,
        'sources': [{'key': PETIT, 'access': 'free', 'categoryIds': ['a' * 24]},
                    {'key': TURF, 'access': 'free', 'categoryIds': ['b' * 24]},
                    {'key': 'rdj_multisport_analysis', 'access': 'vip', 'categoryIds': ['c' * 24]}],
        'publishedSourceWindows': {'version': 'published-source-windows-v1', 'editionDate': DAY,
            'checkedAtUtc': now.isoformat(), 'sources': [
                {'source': PETIT, 'ready': True, 'categoryId': 'a' * 24, 'count': 2,
                 'latestStartsAtUtc': items[1]['startsAtUtc'], 'items': items},
                {'source': TURF, 'ready': True, 'categoryId': 'b' * 24, 'count': 1,
                 'latestStartsAtUtc': race['startsAtUtc'], 'items': [race]}]}}


class ArchiveFetcher:
    def __init__(self):
        self.pages = {sources.SOURCES[PETIT]: '<a href="' + JOURNAL + '">Samedi 24 octobre 2026</a>',
            JOURNAL: PACKET['pages'][JOURNAL], sources.SOURCES[TURF]: '<a href="' + COURSE + '">Quinte du jour</a>',
            COURSE: (FIXTURES / 'turf-2026-10-24-course-current.html').read_text('utf-8')}
        self.calls, self.records, self.requests, self.budget_refusals = [], [], 0, []
    def html(self, url):
        self.calls.append(url)
        return sources.rdj.FetchedPage(url, self.pages[url])


def proof(source=PETIT, config=None, fetcher=None, now=NOW):
    return runner.published_source_window(source, config or configuration(now), DAY, fetcher or ArchiveFetcher(), now)


class PublishedSourceWindowTests(unittest.TestCase):
    def test_real_card_and_course_archives_match_three_manual_identities_without_details(self):
        config, fetcher = configuration(), ArchiveFetcher()
        before = deepcopy(config)
        journal, race = proof(config=config, fetcher=fetcher), proof(TURF, config, fetcher)
        self.assertEqual(journal['sourceIds'], ['5795487', '5803298'])
        self.assertEqual(race['sourceIds'], [DAY + '-R1C3'])
        self.assertTrue(journal['inventoryMatched'])
        self.assertEqual(fetcher.calls, [sources.SOURCES[PETIT], JOURNAL, sources.SOURCES[TURF], COURSE])
        self.assertEqual(config, before)

    def test_petit_cutoff_is_strict_and_future_only_never_fetches_inventory(self):
        for instant, expected in [('16:00:00', False), ('16:00:00.001', True), ('15:59:59.999', False)]:
            now = datetime.fromisoformat(DAY + 'T' + instant + '+00:00')
            fetcher = ArchiveFetcher()
            self.assertEqual(proof(config=configuration(now), fetcher=fetcher, now=now) is not None, expected)
            if not expected:
                self.assertEqual(fetcher.calls, [])

    def test_mixed_past_future_petit_matches_whole_inventory_and_retains_latest_max(self):
        now = datetime.fromisoformat(DAY + 'T17:00:00+00:00')
        config, fetcher = configuration(now), ArchiveFetcher()
        before = deepcopy(config)
        result = proof(config=config, fetcher=fetcher, now=now)
        self.assertEqual(result['sourceIds'], ['5795487', '5803298'])
        self.assertEqual(result['publishedCount'], 2)
        self.assertEqual(result['latestStartsAtUtc'], DAY + 'T18:45:00+00:00')
        self.assertTrue(result['inventoryMatched'])
        self.assertEqual(fetcher.calls, [sources.SOURCES[PETIT], JOURNAL])
        self.assertEqual(config, before)

    def test_mixed_petit_still_requires_complete_current_inventory_and_exact_latest(self):
        now = datetime.fromisoformat(DAY + 'T17:00:00+00:00')
        for mutation in ('partial_rows', 'extra_card', 'wrong_latest', 'wrong_logos', 'wrong_clock', 'wrong_day'):
            config, fetcher = configuration(now), ArchiveFetcher()
            window = config['publishedSourceWindows']['sources'][0]
            if mutation == 'partial_rows':
                window['items'].pop(); window['count'] = 1
                window['latestStartsAtUtc'] = window['items'][0]['startsAtUtc']
            if mutation == 'wrong_latest': window['latestStartsAtUtc'] = window['items'][0]['startsAtUtc']
            if mutation == 'wrong_logos': window['items'][1]['teams']['home']['logo'] = 'https://img.ruedesjoueurs.com/img/9999-2.png'
            if mutation == 'wrong_clock': window['items'][0]['startsAtUtc'] = DAY + 'T16:31:00Z'
            if mutation == 'wrong_day': config['publishedSourceWindows']['editionDate'] = '2026-10-23'
            if mutation == 'extra_card':
                original = sources.rdj._journal_cards
                def extra(*args, **kwargs):
                    cards = original(*args, **kwargs)
                    return cards + [deepcopy(cards[0])]
                with patch.object(sources.rdj, '_journal_cards', side_effect=extra):
                    self.assertIsNone(proof(config=config, fetcher=fetcher, now=now), mutation)
            else:
                self.assertIsNone(proof(config=config, fetcher=fetcher, now=now), mutation)

    def test_invalid_published_instants_cannot_close_a_mixed_batch(self):
        now = datetime.fromisoformat(DAY + 'T17:00:00+00:00')
        for value in ('invalid', DAY + 'T16:30:00', DAY + 'T25:30:00Z'):
            for field in ('first', 'second', 'latest'):
                config, fetcher = configuration(now), ArchiveFetcher()
                window = config['publishedSourceWindows']['sources'][0]
                if field == 'latest': window['latestStartsAtUtc'] = value
                else: window['items'][0 if field == 'first' else 1]['startsAtUtc'] = value
                self.assertIsNone(proof(config=config, fetcher=fetcher, now=now), (field, value))
                self.assertEqual(fetcher.calls, [])

    def test_turf_single_race_cutoff_remains_strict(self):
        for instant, expected in [('12:45:00', False), ('12:45:00.001', True), ('12:44:59.999', False)]:
            now = datetime.fromisoformat(DAY + 'T' + instant + '+00:00')
            fetcher = ArchiveFetcher()
            result = proof(TURF, configuration(now), fetcher, now)
            self.assertEqual(result is not None, expected)
            self.assertEqual(fetcher.calls, [sources.SOURCES[TURF], COURSE] if expected else [])

    def test_partial_duplicate_or_extra_card_inventory_falls_back_to_normal_collection(self):
        for change in ('partial_rows', 'duplicate_rows', 'extra_future_card', 'partial_cards'):
            config, fetcher = configuration(), ArchiveFetcher()
            if change == 'partial_rows':
                w = config['publishedSourceWindows']['sources'][0]
                w['items'].pop(0); w['count'] = 1
            elif change == 'duplicate_rows':
                w = config['publishedSourceWindows']['sources'][0]
                w['items'][1] = deepcopy(w['items'][0]); w['latestStartsAtUtc'] = w['items'][0]['startsAtUtc']
            else:
                root = sources.rdj.Document(fetcher.pages[JOURNAL]).root
                cards = sources.rdj._journal_cards(sources.rdj.FetchedPage(JOURNAL, fetcher.pages[JOURNAL]), datetime.fromisoformat(DAY).date())
                # Exact existing card markup is duplicated as an explicitly
                # synthetic unknown/future editorial card, never as source fact.
                def html(node):
                    if isinstance(node, str): return node
                    return '<' + node.tag + ''.join(' ' + k + '="' + v + '"' for k, v in node.attrs.items()) + '>' + ''.join(html(c) for c in node.children) + '</' + node.tag + '>'
                card = html(cards[0])
                if change == 'extra_future_card':
                    fetcher.pages[JOURNAL] = fetcher.pages[JOURNAL].replace('</section>', card + '</section>', 1)
                else:
                    fetcher.pages[JOURNAL] = '<html><h1>Le Petit Journal du Parieur - Samedi 24 octobre 2026</h1><main id="articleMainContent"><section id="tab-pronostics">' + card + '</section></main></html>'
            self.assertIsNone(proof(config=config, fetcher=fetcher), change)

    def test_clock_competition_logos_orientation_and_source_url_must_all_match(self):
        for mutation in ('clock', 'competition', 'logos', 'reverse', 'journal', 'range'):
            config = configuration(); w = config['publishedSourceWindows']['sources'][0]; item = w['items'][0]
            if mutation == 'clock': item['startsAtUtc'] = DAY + 'T16:31:00Z'
            if mutation == 'competition': item['competition']['name'] = 'Ligue 2'
            if mutation == 'logos': item['teams']['home']['logo'] = 'https://img.ruedesjoueurs.com/img/9999-2.png'
            if mutation == 'reverse': item['teams']['home'], item['teams']['away'] = item['teams']['away'], item['teams']['home']
            if mutation == 'journal': item['sourceUrl'] = JOURNAL.replace('74782', '74783')
            if mutation == 'range': item['startsAtUtc'] = '9999-12-31T23:59:59Z'; w['latestStartsAtUtc'] = item['startsAtUtc']
            self.assertIsNone(proof(config=config), mutation)

    def test_mapping_unknown_stale_or_next_day_is_never_reused(self):
        for mutation in ('unknown', 'mapping', 'vip', 'duplicate_mapping', 'stale', 'date'):
            config = configuration()
            if mutation == 'unknown': config['publishedSourceWindows']['sources'][0]['ready'] = False
            if mutation == 'mapping': config['sources'][0]['categoryIds'] = ['d' * 24]
            if mutation == 'vip': config['sources'][0]['access'] = 'vip'
            if mutation == 'duplicate_mapping': config['sources'].append(deepcopy(config['sources'][0]))
            if mutation == 'stale': config['publishedSourceWindows']['checkedAtUtc'] = DAY + 'T20:00:00Z'
            if mutation == 'date': config['publishedSourceWindows']['editionDate'] = '2026-10-23'
            self.assertIsNone(proof(config=config), mutation)
        self.assertIsNone(proof(now=datetime(2026, 10, 24, 22, tzinfo=timezone.utc)))

    def test_free_text_explicit_timezone_is_not_silently_reinterpreted_as_paris(self):
        for qualifier in ('UTC', 'GMT', 'CET', 'CEST', 'Europe/Paris', '+0200', '+02:00'):
            fetcher = ArchiveFetcher()
            self.assertIn('20h45', fetcher.pages[JOURNAL])
            fetcher.pages[JOURNAL] = fetcher.pages[JOURNAL].replace('20h45', '20h45 ' + qualifier)
            self.assertIsNone(proof(fetcher=fetcher), qualifier)

    def test_turf_requires_unique_current_identity_clock_and_title_before_analysis(self):
        for mutation in ('extra_race', 'id', 'url', 'clock', 'title', 'missing'):
            config, fetcher = configuration(), ArchiveFetcher()
            item = config['publishedSourceWindows']['sources'][1]['items'][0]
            if mutation == 'extra_race': fetcher.pages[sources.SOURCES[TURF]] += '<a href="' + COURSE.replace('/C3/', '/C4/') + '">Quinte autre</a>'
            if mutation == 'id': item['sourceId'] = DAY + '-R1C4'
            if mutation == 'url': item['sourceUrl'] = COURSE.replace('/C3/', '/C4/')
            if mutation == 'clock': item['startsAtUtc'] = DAY + 'T13:16:00Z'; config['publishedSourceWindows']['sources'][1]['latestStartsAtUtc'] = item['startsAtUtc']
            if mutation == 'title': fetcher.pages[COURSE] = fetcher.pages[COURSE].replace('R1C3', 'R1C4')
            if mutation == 'missing': fetcher.pages[sources.SOURCES[TURF]] = ''
            self.assertIsNone(proof(TURF, config, fetcher), mutation)

    def test_inventory_errors_cannot_authorize_a_skip(self):
        fetcher = ArchiveFetcher()
        fetcher.html = lambda url: (_ for _ in ()).throw(OSError('private error'))
        self.assertIsNone(proof(fetcher=fetcher))
        self.assertIsNone(proof(TURF, fetcher=fetcher))
        self.assertIsNone(proof('rdj_multisport_analysis'))

    def test_runner_skips_only_proven_free_keeps_vip_and_existing_payload_bytes(self):
        config, fetcher = configuration(), ArchiveFetcher()
        class Api:
            def request(self, route, payload=None):
                if route != '/api/internal/editorial/config' or payload is not None: raise AssertionError('no POST')
                return config
        with tempfile.TemporaryDirectory() as directory:
            args = Namespace(edition=DAY, source=[PETIT, TURF, 'rdj_multisport_analysis'], output=directory,
                api_base='http://localhost:4300', publish=False, translate=False,
                minimum_lead_minutes=30, max_requests=40, max_seconds=240, cache_ttl_seconds=600)
            saved = Path(directory) / 'editions' / DAY / (PETIT + '.json')
            saved.parent.mkdir(parents=True); saved.write_bytes(b'{"items":[]}\n')
            digest = hashlib.sha256(saved.read_bytes()).hexdigest()
            with patch.object(runner, 'collect', return_value={'status': 'source_absent', 'items': [], 'issues': []}) as collect:
                report = runner.run(args, fetcher=fetcher, now=NOW, api_client=Api(), clock=lambda: NOW)
            self.assertNotIn('blocked', report)
            self.assertFalse(report['published'])
            self.assertEqual([r['status'] for r in report['sources'][:2]], ['outside_publication_window'] * 2)
            self.assertEqual(collect.call_count, 1)
            self.assertEqual(collect.call_args.args[0], 'rdj_multisport_analysis')
            self.assertEqual(collect.call_args.kwargs['exclude_ids'], {'5795487', '5803298'})
            self.assertEqual(hashlib.sha256(saved.read_bytes()).hexdigest(), digest)


if __name__ == '__main__':
    unittest.main()
