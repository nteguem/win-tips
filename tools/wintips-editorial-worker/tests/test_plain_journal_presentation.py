"""Offline replay of the actual 15 November cards with the copied wrong URL."""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
SHARED = Path(os.environ['WINTIPS_JOURNAL_TEXT_CODE_ROOT'])
sys.path.insert(0, str(SHARED))
from journal_worker import editorial_source
from editorial_worker import plain_journal
from editorial_worker.plain_journal_presentation import enrich_packet, presentation

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / 'tests/fixtures/presentation'
JOURNAL = 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/75013-le-petit-journal-du-parieur-dimanche-15-novembre-2026.html'
INDEX = 'https://www.ruedesjoueurs.com/pronostics/foot.html'
DAY = '2026-11-15'


class FakeFetcher:
    def __init__(self, index=None):
        self.requests = []
        self.index = index if index is not None else (FIXTURES / 'football-cards-real-20261115.html').read_text(encoding='utf-8')

    def html(self, url):
        self.requests.append(url)
        if url == INDEX:
            if isinstance(self.index, Exception):
                raise self.index
            return SimpleNamespace(url=url, html=self.index, status=200)
        if url == JOURNAL:
            body = (FIXTURES / 'journal-cards-real-20261115.html').read_text(encoding='utf-8')
            return SimpleNamespace(url=url, html=body, status=200)
        if url.endswith('/paris-sportifs/le-petit-journal.html'):
            return SimpleNamespace(url=url, html='<a href="' + JOURNAL + '">Petit Journal</a>', status=200)
        return SimpleNamespace(url=url, html='', status=503)


class PresentationTests(unittest.TestCase):
    def collect(self, fetcher):
        translator = SimpleNamespace(translate=lambda packet, **options: deepcopy(packet))
        modules = {'editorial_source': editorial_source, 'text_translation': translator}
        with patch.object(plain_journal, 'shared', side_effect=modules.__getitem__):
            return plain_journal.collect_text(DAY, fetcher, datetime(2026, 11, 15, 23, tzinfo=timezone.utc))

    def test_actual_wrong_link_cards_keep_two_separate_analyses_with_both_pairs(self):
        fetcher = FakeFetcher()
        result = self.collect(fetcher)
        self.assertEqual(result['status'], 'ready')
        first, second = result['items']
        self.assertEqual(first['teams'], {
            'home': {'name': 'France', 'logo': 'https://img.ruedesjoueurs.com/img/6723-5.png'},
            'away': {'name': 'Turquie', 'logo': 'https://img.ruedesjoueurs.com/img/6595-13.png'},
        })
        self.assertEqual(second['teams']['home']['name'], 'Belgique')
        self.assertEqual(second['teams']['away']['name'], 'Italie')
        self.assertTrue(all(side.get('logo') for side in second['teams'].values()))
        self.assertEqual([row['sourceTimeLabel'] for row in result['items']], ['21:00', '20:45'])
        self.assertTrue(all(row['startsAtUtc'] is None for row in result['items']))
        self.assertEqual(len({row['sourceId'] for row in result['items']}), 2)
        self.assertIn('Turquie', first['selection']['label']['fr'])
        self.assertNotEqual(first['analysis'], second['analysis'])
        self.assertEqual(fetcher.requests.count(INDEX), 1)

    def test_index_outage_does_not_block_or_change_source_prose(self):
        good = self.collect(FakeFetcher())
        class RetryableHTTPError(Exception):
            pass
        for kind in (OSError, RuntimeError, RetryableHTTPError):
            with self.subTest(error=kind.__name__):
                unavailable = self.collect(FakeFetcher(kind('offline replay')))
                self.assertEqual(unavailable['status'], 'ready')
                self.assertEqual(len(unavailable['items']), 2)
                for left, right in zip(good['items'], unavailable['items']):
                    self.assertEqual(left['analysis'], right['analysis'])
                    self.assertEqual(left['selection'], right['selection'])
                    self.assertEqual(left['sourceId'], right['sourceId'])

    def test_old_index_or_wrong_opponent_cannot_supply_missing_names(self):
        html = FakeFetcher().index
        for bad in (html.replace('2026-11-15T', '2026-11-14T'),
                    html.replace('6595-13.png', '9999-1.png')):
            result = self.collect(FakeFetcher(bad))
            self.assertEqual(result['status'], 'ready')
            self.assertNotIn('teams', result['items'][0])

    def test_optional_media_malformed_values_are_ignored_not_publication_errors(self):
        row = {'home': 'France', 'away': 'Turquie', 'source_clock_label': 'Heure a confirmer',
               'participant_images': {'home': 'https://img.ruedesjoueurs.com:bad/a.png',
                                      'away': 'https://example.invalid/turkey.png'},
               'image_url': 'https://img.ruedesjoueurs.com/images/promo/banner.png'}
        self.assertEqual(presentation(row), {'teams': {'home': {'name': 'France'}, 'away': {'name': 'Turquie'}}})
        for clock in ('24h00', '20:99', None, 21):
            self.assertNotIn('sourceTimeLabel', presentation({'source_clock_label': clock}))


if __name__ == '__main__':
    unittest.main()
