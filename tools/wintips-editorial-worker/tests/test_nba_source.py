"""Offline integration: Basket USA remains its own edition and night calendar."""
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch

from editorial_worker import nba
from editorial_worker.runner import validate_item, run_summary
from editorial_worker.sources import SOURCES, collect, eligible
from editorial_worker.http import public_url, FetchError

DAY = '2026-11-08'
NOW = datetime(2026, 11, 8, 12, tzinfo=timezone.utc)
URL = nba.INDEX_URL + '#pari-kings-spurs'


def packet():
    return {'edition': DAY, 'status': 'ready', 'journal_kind': 'nba', 'source_key': nba.SOURCE,
        'source_url': nba.INDEX_URL, 'source_published_at': '2026-11-08T09:00:00Z', 'issues': [],
        'fixtures': [{'id': 'basketusa:123456:abc123', 'source_url': URL,
            'home': 'Sacramento Kings', 'away': 'San Antonio Spurs', 'sport': 'basketball', 'competition': 'NBA',
            'kickoff_utc': '2026-11-09T02:00:00Z', 'headline_fr': 'Le contexte de la rencontre',
            'analysis_fr': 'Les Kings cherchent à confirmer leur dernière victoire.',
            'teaser_fr': 'Kings et Spurs se retrouvent cette nuit.', 'pick_fr': 'Victoire Sacramento Kings', 'odds': '1.85'}]}


class NbaSourceTests(unittest.TestCase):
    def setUp(self):
        self.fetcher = SimpleNamespace(html=lambda url: None, json=lambda url: None, budget_refusals=[])

    def adapted(self, value=None, **kwargs):
        with patch.object(nba, 'owner', return_value=SimpleNamespace(collect=lambda *a, **k: value or packet())):
            return collect(nba.SOURCE, DAY, self.fetcher, now=NOW, **kwargs)

    def test_dedicated_nba_source_keeps_full_analysis_and_pick_out_of_the_teaser(self):
        self.assertIn(nba.SOURCE, SOURCES)
        value = self.adapted()
        self.assertEqual(value['status'], 'ready')
        item = value['items'][0]
        self.assertEqual(item['source'], nba.SOURCE)
        self.assertEqual(item['competition']['name'], 'NBA')
        self.assertEqual(item['sourceUrl'], URL)
        self.assertEqual(item['summary']['fr'], packet()['fixtures'][0]['teaser_fr'])
        self.assertEqual(item['analysis']['fr'][0]['paragraphs'], [packet()['fixtures'][0]['analysis_fr']])
        self.assertEqual(item['selection']['odds'], 1.85)
        validate_item(item, nba.SOURCE, DAY, NOW, 30)

    def test_source_identity_is_stable_across_retries_and_distinct_from_rdj(self):
        first = self.adapted()['items'][0]
        second = self.adapted()['items'][0]
        self.assertEqual(first['sourceId'], second['sourceId'])
        self.assertRegex(first['sourceId'], r'^basketusa_[a-f0-9]{32}$')
        changed = packet()
        changed['fixtures'][0]['id'] += '_another_fixture'
        self.assertNotEqual(first['sourceId'], self.adapted(changed)['items'][0]['sourceId'])

    def test_night_proof_is_bound_to_source_day_teams_and_clock(self):
        item = self.adapted()['items'][0]
        self.assertTrue(eligible(item, DAY, NOW))
        for key, wrong in [('editionDate', '2026-11-07'), ('articlePublishedAt', '2026-11-07T09:00:00Z'),
                ('matchedParticipants', ['Wrong team', 'San Antonio Spurs']), ('startsAtUtc', '2026-11-09T03:00:00Z'),
                ('provider', 'rdj'), ('sourceId', 'basketusa_wrong')]:
            bad = deepcopy(item)
            bad['scheduleProof'][key] = wrong
            self.assertFalse(eligible(bad, DAY, NOW), key)

    def test_daytime_fixtures_do_not_receive_an_overnight_exception(self):
        value = packet()
        value['fixtures'][0]['kickoff_utc'] = '2026-11-08T20:00:00Z'
        item = self.adapted(value)['items'][0]
        self.assertNotIn('editionConvention', item)
        self.assertTrue(eligible(item, DAY, NOW))

    def test_stale_publication_or_a_following_afternoon_never_becomes_today(self):
        for field, wrong in [('source_published_at', '2026-11-06T09:00:00Z'), ('kickoff_utc', '2026-11-09T13:00:00Z')]:
            value = packet()
            if field == 'kickoff_utc': value['fixtures'][0][field] = wrong
            else: value[field] = wrong
            result = self.adapted(value)
            self.assertEqual(result['status'], 'source_incomplete')
            self.assertEqual(result['items'], [])

    def test_an_absent_nba_source_does_not_mark_other_sources_failed(self):
        value = packet()
        value.update(status='source_absent', fixtures=[])
        result = self.adapted(value)
        self.assertEqual(result['items'], [])
        report = run_summary({'mode': 'publish', 'sources': [
            {'source': 'rdj_petit_journal', 'status': 'ready', 'itemCount': 2, 'imported': True},
            {'source': nba.SOURCE, 'status': result['status'], 'itemCount': 0, 'imported': False}]})
        self.assertEqual(report['status'], 'complete')
        self.assertEqual(report['publishedSources'], ['rdj_petit_journal'])

    def test_a_started_fixture_never_leaves_a_partial_nba_edition(self):
        value = packet()
        other = deepcopy(value['fixtures'][0])
        other.update(id='basketusa:123456:other', kickoff_utc='2026-11-08T12:15:00Z')
        value['fixtures'].append(other)
        result = self.adapted(value)
        self.assertEqual(result['status'], 'outside_publication_window')
        self.assertEqual(result['items'], [])

    def test_public_urls_are_bounded_to_the_reviewed_publisher(self):
        self.assertEqual(public_url(nba.INDEX_URL), nba.INDEX_URL)
        self.assertEqual(nba.publisher_url(URL), URL)
        for bad in [URL.replace('www.basketusa.com', 'example.com'), URL + '?q=anything',
                URL.replace('#pari-', '#unreviewed-'), 'https://www.basketusa.com/other/']:
            with self.assertRaises(ValueError): nba.publisher_url(bad)
        with self.assertRaises(FetchError): public_url('https://basketusa.example.com/')

    def test_authored_player_names_are_protected_during_translation(self):
        from editorial_worker.translation import _names
        value = packet()
        value['fixtures'][0]['protected_names'] = ['Sacramento Kings', 'San Antonio Spurs', 'Domantas Sabonis']
        item = self.adapted(value)['items'][0]
        self.assertIn('Domantas Sabonis', _names(item))

    @unittest.skipUnless(os.environ.get('NBA_TEST_CANONICAL_ROOT'), 'explicit canonical NBA checkout required')
    def test_real_publisher_archive_crosses_canonical_collector_adapter_and_actual_api_validator(self):
        root = Path(os.environ['NBA_TEST_CANONICAL_ROOT']).resolve()
        source = root / 'journal_worker/tests/fixtures/basketusa-nba-20261106.html'
        fetcher = SimpleNamespace(html=lambda url: source.read_text(encoding='utf-8'),
            json=lambda url: None, budget_refusals=[])
        instant = datetime(2026, 11, 6, 17, tzinfo=timezone.utc)
        with patch.dict(os.environ, {'NBA_JOURNAL_CODE_ROOT': str(root)}):
            result = collect(nba.SOURCE, '2026-11-06', fetcher, now=instant)
        self.assertEqual(result['status'], 'ready', result['issues'])
        self.assertEqual(len(result['items']), 4)
        for item in result['items']:
            validate_item(item, nba.SOURCE, '2026-11-06', instant, 30)
        # Pure Node validation only, no checkout proof, database/API or write.
        api_root = Path(__file__).resolve().parents[3]
        script = "const fs=require('fs');const v=require('./tools/wintips-editorial-worker/validate-api-payload.cjs');console.log(JSON.stringify(v.validate(fs.readFileSync(0),new Date('2026-11-06T17:00:00Z'))));"
        done = subprocess.run([shutil.which('node'), '-e', script], cwd=api_root,
            input=json.dumps({'source': nba.SOURCE, 'editionDate': '2026-11-06', 'items': result['items']}).encode(),
            capture_output=True, timeout=30)
        report = json.loads(done.stdout)
        self.assertTrue(report['passed'], report)


if __name__ == '__main__':
    unittest.main()
