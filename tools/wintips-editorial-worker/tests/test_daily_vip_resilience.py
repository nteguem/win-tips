"""Regression coverage for proven events with optional publisher details."""
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
import unittest
from unittest.mock import patch

from editorial_worker import daily_vip as d
from editorial_worker.daily_vip_markets import parse_recommendation
from editorial_worker.vendor.rdj_collector import Document
from test_daily_vip import candidate, NOW, DAY

FIXTURES = Path(__file__).parent / 'fixtures' / 'daily-vip'
MEXICO = 'https://www.sportytrader.com/pronostics/mexique-jamaique-387953/'
TODAY = datetime(2026, 11, 18, 1, 45, tzinfo=timezone.utc)


def observed(name, url):
    return {'url': url, 'final_url': url, 'status': 200, 'saved': TODAY.timestamp(),
            'body': (FIXTURES / name).read_text('utf-8')}


class ResilienceTests(unittest.TestCase):
    def test_mexico_four_level_trail_and_singular_goal_section_keep_exact_btts_price(self):
        detail = d.prediction(observed('mexico-prediction.html', MEXICO), MEXICO, '2026-11-18', TODAY)
        self.assertEqual(detail['competition'], {})
        self.assertEqual(detail['pick']['betType'], 'btts')
        self.assertEqual(detail['startsAtUtc'], '2026-11-18T02:30:00Z')
        quotes, _ = d.prices(observed('mexico-odds.html', detail['oddsUrl']), detail, TODAY)
        self.assertEqual(quotes['PMU Play'], Decimal('2.02'))
        self.assertEqual(detail['competition']['name'], 'CONCACAF Nations League')
        # Adjacent Yes/No markets and other bookmakers must not replace this quote.
        self.assertNotEqual(quotes['PMU Play'], Decimal('1.68'))

    def test_controlled_basketball_alias_and_french_article_keep_author_choice(self):
        teams = {'home': {'name': 'LA Clippers'}, 'away': {'name': 'Utah Jazz'}}
        root = Document('<p>Notre pronostic Los Angeles Clippers - Utah Jazz : victoire des Clippers !</p>').root
        pick = d.recommendation(root, teams, 'basketball')
        self.assertEqual(pick['side'], '1')
        self.assertEqual(pick['betType'], 'match_winner')

    def test_french_articles_never_cut_lakers_or_denver_names(self):
        for name in ['Lakers', 'Denver Nuggets', 'Trinité et Tobago']:
            teams = {'home': {'name': name}, 'away': {'name': 'Opponent'}}
            sport = 'football' if name == 'Trinité et Tobago' else 'basketball'
            self.assertEqual(parse_recommendation('Victoire de ' + name, teams, sport)['side'], '1')

    def test_besiktas_basketball_name_variant_keeps_the_proven_fixture(self):
        teams = {'home': {'name': 'BesiktasJK'}, 'away': {'name': 'Real Madrid'}}
        root = Document('<p>Notre pronostic Besiktas - Real Madrid : victoire de Real Madrid !</p>').root
        self.assertEqual(d.recommendation(root, teams, 'basketball')['side'], '2')

    def test_integer_total_line_never_uses_scientific_notation(self):
        pick = parse_recommendation('Plus de 200 points', {}, 'basketball')
        self.assertEqual(pick['line'], '200')
        self.assertEqual(pick['side'], '+200')

    def test_aliases_cannot_create_two_legs_for_the_same_participant(self):
        first, second = candidate(), candidate()
        first.update(sourceId='sp100', sport={'key': 'basketball', 'name': 'Basketball'},
                     teams={'home': {'name': 'LA Clippers'}, 'away': {'name': 'Utah Jazz'}},
                     prices={'Unibet': Decimal('1.60')})
        second.update(sourceId='sp101', sport={'key': 'basketball', 'name': 'Basketball'},
                      teams={'home': {'name': 'Clippers'}, 'away': {'name': 'LA Lakers'}},
                      prices={'Unibet': Decimal('2.00')})
        self.assertIsNone(d.choose([first, second]))

    def test_distinct_sports_with_a_shared_club_name_remain_independent(self):
        first, second = candidate(), candidate()
        first.update(sourceId='sp100', sport={'key': 'basketball', 'name': 'Basketball'},
                     teams={'home': {'name': 'Real Madrid'}, 'away': {'name': 'Besiktas'}},
                     prices={'Unibet': Decimal('1.60')})
        second.update(sourceId='sp101', sport={'key': 'football', 'name': 'Football'},
                      teams={'home': {'name': 'Real Madrid'}, 'away': {'name': 'Barcelona'}},
                      prices={'Unibet': Decimal('2.00')})
        self.assertIsNotNone(d.choose([first, second]))

    def test_report_distinguishes_unusable_candidates_from_absent_source(self):
        class Fetch:
            def get(self, url):
                return {'status': 200, 'final_url': url, 'saved': NOW.timestamp(),
                        'body': '<a href="/pronostics/test-123/">Fixture</a>' if url == d.INDEX_URL else '<p>Incomplete</p>'}
        result = d.collect(DAY, Fetch(), now=NOW)
        self.assertEqual(result['status'], 'candidates_unusable')
        self.assertEqual(result['dailyVipAudit']['discoveredCount'], 1)
        self.assertEqual(result['dailyVipAudit']['verifiedCandidateCount'], 0)
        with patch.object(d, 'discovery', return_value=[]):
            self.assertEqual(d.collect(DAY, Fetch(), now=NOW)['status'], 'source_absent')


if __name__ == '__main__':
    unittest.main()
