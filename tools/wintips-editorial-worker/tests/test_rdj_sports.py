"""Canonical RDJ sports adapter, calendar guards and real API preflight."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from editorial_worker import rdj_sports as adapter
from editorial_worker.sources import SOURCES, collect, eligible
from editorial_worker.runner import validate_item

DAY = '2026-11-09'
NOW = datetime(2026, 11, 9, 8, tzinfo=timezone.utc)


def packet(sport='nba', night=True):
    key = 'basketball' if sport == 'nba' else 'tennis'
    start = '2026-11-10T02:00:00Z' if night else DAY + 'T15:00:00Z'
    url = 'https://www.ruedesjoueurs.com/pronostic/a-b-123.html'
    return {'edition': DAY, 'source_key': 'rdj_' + sport, 'journal_kind': sport,
        'source_url': adapter.INDEXES[sport], 'status': 'ready', 'issues': [], 'fixtures': [{
            'id': '123', 'source_url': url, 'home': 'Player A', 'away': 'Player B', 'sport': key,
            'competition': 'NBA' if sport == 'nba' else 'ATP Stockholm', 'kickoff_utc': start,
            'headline_fr': 'La rencontre', 'pick_fr': 'Victoire Player A', 'odds': '1.58',
            'analysis_fr': 'Analyse originale.', 'provenance': {'analysis_paragraphs_fr': ['Analyse originale.'],
                'sport_edition_membership': {'method': 'rdj_sport_detail_clock_v1', 'edition': DAY,
                    'sport': key, 'source_url': url, 'source_id': '123', 'index_url': adapter.INDEXES[sport],
                    'matched_participants': ['Player A', 'Player B'], 'starts_at_utc': start, 'following_night': night}}}]}


class RdjSportsTests(unittest.TestCase):
    def adapted(self, value=None, sport='nba', **kwargs):
        fetcher = SimpleNamespace(html=lambda url: None, json=lambda url: self.fail('No schedule HTTP'), budget_refusals=[])
        with patch.object(adapter, 'owner', return_value=SimpleNamespace(collect=lambda *a, **k: value or packet(sport))):
            return collect('rdj_' + sport, DAY, fetcher, now=NOW, **kwargs)

    def test_active_sources_replace_basketusa_and_do_not_copy_the_core_parser(self):
        self.assertNotIn('basketusa_nba', SOURCES)
        self.assertIn('rdj_nba', SOURCES)
        self.assertIn('rdj_tennis', SOURCES)
        with patch.dict(os.environ, {'RDJ_HUB_CODE_ROOT': '', 'RDJ_SPORTS_CODE_ROOT': ''}):
            with self.assertRaises(ValueError): adapter.owner()

    def test_nba_night_retains_fr_paragraphs_pick_price_and_bound_clock(self):
        result = self.adapted()
        self.assertEqual(result['status'], 'ready', result['issues'])
        item = result['items'][0]
        self.assertEqual(item['analysis']['fr'][0]['paragraphs'], ['Analyse originale.'])
        self.assertEqual(item['selection'], {'label': {'fr': 'Victoire Player A'}, 'odds': 1.58})
        self.assertEqual(item['editionConvention'], 'rdj_sport_following_night')
        self.assertTrue(eligible(item, DAY, NOW))
        validate_item(item, 'rdj_nba', DAY, NOW, 30)

    def test_tennis_is_same_day_only_and_nba_cannot_use_a_following_afternoon(self):
        result = self.adapted(packet('tennis', False), sport='tennis')
        self.assertEqual(result['status'], 'ready', result['issues'])
        self.assertNotIn('editionConvention', result['items'][0])
        self.assertEqual(self.adapted(packet('tennis', True), sport='tennis')['status'], 'source_incomplete')
        value = packet(); value['fixtures'][0]['kickoff_utc'] = '2026-11-10T13:00:00Z'
        value['fixtures'][0]['provenance']['sport_edition_membership']['starts_at_utc'] = '2026-11-10T13:00:00Z'
        self.assertEqual(self.adapted(value)['status'], 'source_incomplete')

    def test_malformed_membership_identity_sport_or_odds_is_rejected_before_publication(self):
        for field, wrong in [('source_id', '999'), ('index_url', adapter.INDEXES['tennis']), ('sport', 'tennis'),
                             ('matched_participants', ['Player B', 'Player A']), ('starts_at_utc', '2026-11-10T03:00:00Z')]:
            value = packet(); value['fixtures'][0]['provenance']['sport_edition_membership'][field] = wrong
            self.assertEqual(self.adapted(value)['status'], 'source_incomplete', field)
        for field, wrong in [('id', '999'), ('source_url', 'https://evil.example/pronostic/a-b-123.html'),
                             ('competition', 'WNBA'), ('odds', 'nan'), ('odds', True), ('odds', '1.00')]:
            value = packet(); value['fixtures'][0][field] = wrong
            self.assertEqual(self.adapted(value)['status'], 'source_incomplete', field)

    def test_bound_proof_cannot_be_reused_for_other_teams_or_clock_and_lead_is_thirty_minutes(self):
        item = self.adapted()['items'][0]
        for field, wrong in [('sourceId', '999'), ('provider', 'espn'), ('editionDate', '2026-11-08'),
                             ('matchedParticipants', ['Other', 'Player B']), ('startsAtUtc', '2026-11-10T03:00:00Z')]:
            changed = deepcopy(item); changed['scheduleProof'][field] = wrong
            self.assertFalse(eligible(changed, DAY, NOW), field)
        value = packet('nba', False); start = DAY + 'T08:29:59Z'
        value['fixtures'][0]['kickoff_utc'] = start
        value['fixtures'][0]['provenance']['sport_edition_membership']['starts_at_utc'] = start
        self.assertEqual(self.adapted(value)['status'], 'source_incomplete')
        self.assertEqual(self.adapted(lead=29)['status'], 'source_incomplete')

    def test_existing_api_preflight_accepts_original_french_with_english_fallback(self):
        root = Path(__file__).resolve().parents[3]
        for sport, night in [('nba', True), ('tennis', False)]:
            result = self.adapted(packet(sport, night), sport=sport)
            script = "const v=require('./tools/wintips-editorial-worker/validate-api-payload.cjs');console.log(JSON.stringify(v.validate(require('fs').readFileSync(0),new Date('2026-11-09T08:00:00Z'))))"
            done = subprocess.run([shutil.which('node'), '-e', script], cwd=root,
                input=json.dumps({'source': 'rdj_' + sport, 'editionDate': DAY, 'items': result['items']}).encode(),
                capture_output=True, timeout=30)
            self.assertEqual(done.returncode, 0, done.stderr.decode())
            self.assertTrue(json.loads(done.stdout)['passed'], done.stdout)

    @unittest.skipUnless(os.environ.get('RDJ_TEST_SPORTS_ROOT'), 'Explicit canonical BigWin checkout required')
    def test_real_rdg_archive_crosses_the_canonical_collector_and_actual_win_api_validator(self):
        instant = datetime(2026, 11, 9, 12, tzinfo=timezone.utc)
        root = Path(os.environ['RDJ_TEST_SPORTS_ROOT']).resolve()
        data = json.loads((root / 'journal_worker/tests/fixtures/rdj-sports-20261109-excerpt.json').read_text('utf-8'))
        with patch.dict(os.environ, {'RDJ_SPORTS_CODE_ROOT': str(root), 'RDJ_CONTENT_HUB_DIR': ''}):
            core = adapter.owner()
            physical = []
            def raw(url):
                physical.append(url)
                self.assertIn(url, data['pages'])
                return core.rdj.FetchedPage(url, data['pages'][url])
            fetcher = SimpleNamespace(html=raw, json=lambda url: self.fail('No schedule HTTP'), budget_refusals=[])
            with patch('urllib.request.OpenerDirector.open', side_effect=AssertionError('No external HTTP')):
                for sport, expected in [('nba', ['6019800', '6019802']), ('tennis', ['6578491', '6558663'])]:
                    result = collect('rdj_' + sport, DAY, fetcher, now=instant)
                    self.assertEqual(result['status'], 'ready', result['issues'])
                    self.assertEqual(sorted(row['sourceId'] for row in result['items']), sorted(expected))
                    for row in result['items']:
                        validate_item(row, 'rdj_' + sport, DAY, instant, 30)
                    script = "const v=require('./tools/wintips-editorial-worker/validate-api-payload.cjs');console.log(JSON.stringify(v.validate(require('fs').readFileSync(0),new Date('2026-11-09T12:00:00Z'))))"
                    done = subprocess.run([shutil.which('node'), '-e', script], cwd=Path(__file__).resolve().parents[3],
                        input=json.dumps({'source': 'rdj_' + sport, 'editionDate': DAY, 'items': result['items']}).encode(),
                        capture_output=True, timeout=30)
                    self.assertEqual(done.returncode, 0, done.stderr.decode())
                    self.assertTrue(json.loads(done.stdout)['passed'], done.stdout)
            self.assertEqual(len(physical), 6)


if __name__ == '__main__':
    unittest.main()
