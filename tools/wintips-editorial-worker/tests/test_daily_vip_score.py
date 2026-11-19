"""Observed 2026-11-19 tennis SCORE DOM, with strict negative market boundaries."""
from copy import deepcopy
from datetime import datetime
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import unittest

from editorial_worker import daily_vip as d
from editorial_worker.daily_vip_markets import parse_recommendation as parse, extract_exact_market_prices as prices, DailyVipMarketError
from editorial_worker.vendor.rdj_collector import Document

CAPTURES = json.loads((Path(__file__).parent / 'fixtures/daily-vip/tennis-score-20261119.json').read_text('utf-8'))
SHELTON, ZVEREV = CAPTURES
TEAMS = {'home': {'name': 'Ben Shelton'}, 'away': {'name': 'Rafael Jodar'}}


def pick(away=False):
    return parse('Victoire de ' + ('Rafael Jodar' if away else 'Ben Shelton') + ' en 2 sets', TEAMS, 'tennis')


def quotes(body=None, choice=None):
    return prices(Document(SHELTON['compactHtml'] if body is None else body).root, choice or pick(), TEAMS, 'tennis')


class DailyVipScoreTests(unittest.TestCase):
    def test_captured_public_source_fragments_have_bounded_provenance_and_exact_hashes(self):
        for row in CAPTURES:
            self.assertTrue(row['sourceUrl'].startswith('https://www.sportytrader.com/cotes/'))
            self.assertRegex(row['sourceSha256'], r'^[a-f0-9]{64}$')
            self.assertEqual(hashlib.sha256(row['compactHtml'].encode('utf-8')).hexdigest(), row['compactSha256'])
            self.assertLess(row['sourceBytes'], 8_000_000)
            self.assertEqual(datetime.fromisoformat(row['retrievedAtUtc']).date().isoformat(), '2026-11-19')
        self.assertEqual(SHELTON['scoreSections'], 1)
        self.assertEqual(ZVEREV['scoreSections'], 0)

    def test_author_forms_preserve_straight_sets_and_source_participant_order(self):
        for raw in ['victoire de Ben Shelton en 2 sets', 'Ben Shelton gagne en 2 sets']:
            value = parse(raw, TEAMS, 'tennis')
            self.assertEqual(value['betType'], 'correct_score')
            self.assertEqual(value['side'], '2-0')
            self.assertEqual(value['raw'], raw)
        self.assertEqual(pick(away=True)['side'], '0-2')
        zverev_teams = {'home': {'name': 'Alexander Zverev'}, 'away': {'name': 'Arthur Fils'}}
        self.assertEqual(parse('Alexander Zverev gagne en 2 sets', zverev_teams, 'tennis')['side'], '2-0')

    def test_wrong_participant_sport_period_and_set_conditions_cannot_become_a_match_score(self):
        for raw in ['Un autre gagne en 2 sets', 'Ben Shelton gagne le premier set',
                    'Ben Shelton gagne en 3 sets', 'Ben Shelton gagne en 2 sets au premier set',
                    'Ben Shelton gagne en 2 sets pendant le tie break']:
            self.assertIsNone(parse(raw, TEAMS, 'tennis'), raw)
        self.assertIsNone(parse('Ben Shelton gagne en 2 sets', TEAMS, 'football'))
        composite = parse('Ben Shelton gagne en 2 sets et plus de 21.5 jeux', TEAMS, 'tennis')
        self.assertEqual(composite['betType'], 'combined_market')
        with self.assertRaisesRegex(DailyVipMarketError, 'exact_market_price_unavailable'):
            quotes(choice=composite)

    def test_real_full_match_score_uses_only_its_exact_primary_and_hidden_bookmaker_rows(self):
        self.assertEqual(quotes(), {'PMU Play': Decimal('2.20'), 'Unibet': Decimal('2.10')})
        self.assertEqual(quotes(choice=pick(away=True)), {'PMU Play': Decimal('4.40'), 'Unibet': Decimal('4.15')})

    def test_real_zverev_total_sets_is_not_an_exact_score_quote(self):
        self.assertIn('Score en sets', ZVEREV['compactHtml'])
        with self.assertRaisesRegex(DailyVipMarketError, 'exact_market_price_unavailable'):
            quotes(ZVEREV['compactHtml'])

    def test_real_score_fragment_passes_event_identity_clock_and_bookmaker_checks(self):
        observed = datetime.fromisoformat(SHELTON['retrievedAtUtc'])
        entry = {'final_url': SHELTON['sourceUrl'], 'status': 200, 'saved': observed.timestamp(), 'body': SHELTON['compactHtml']}
        detail = {'oddsUrl': SHELTON['sourceUrl'], 'teams': deepcopy(TEAMS), 'startsAtUtc': '2026-11-19T13:00:00Z',
                  'sport': {'key': 'tennis', 'name': 'Tennis'}, 'competition': {}, 'pick': pick()}
        available, _ = d.prices(entry, detail, observed)
        self.assertEqual(available['Unibet'], Decimal('2.10'))
        detail['teams']['away']['name'] = 'Other participant'
        with self.assertRaisesRegex(d.DailyVipError, 'odds_event_identity_conflict'):
            d.prices(entry, detail, observed)

    def test_period_and_mislabelled_score_blocks_never_supply_match_prices(self):
        original = SHELTON['compactHtml']
        for wrong in [original.replace('id="SCORE"', 'id="PERIOD"'),
                      '<section id="PERIOD">' + original + '</section>',
                      original.replace('Score exact', 'Score en sets'),
                      original.replace('Score exact', 'Score exact - premier set'),
                      original.replace('Score exact', 'Score exact - tie break'),
                      original.replace('Score exact', 'Vainqueur')]:
            with self.subTest(body=wrong[:80]), self.assertRaisesRegex(DailyVipMarketError, 'exact_market_price_unavailable'):
                quotes(wrong)

    def test_score_marker_and_visible_score_must_agree_before_hidden_rows_can_inherit_it(self):
        wrong = SHELTON['compactHtml'].replace('data-oddtype="_2_0"', 'data-oddtype="_0_2"', 1)
        with self.assertRaisesRegex(DailyVipMarketError, 'exact_market_price_unavailable'):
            quotes(wrong)
        # The hidden quote cannot borrow a different score group from elsewhere.
        moved = SHELTON['compactHtml'].replace('class="_2_0 hidden', 'class="_0_2 hidden')
        self.assertEqual(quotes(moved), {'PMU Play': Decimal('2.20')})

    def test_duplicate_score_sections_or_conflicting_same_bookmaker_quotes_are_ambiguous(self):
        original = SHELTON['compactHtml']
        with self.assertRaisesRegex(DailyVipMarketError, 'odds_market_ambiguous'):
            quotes(original + original)
        # Source already has equal PMU primary/hidden quotes, which agree.
        self.assertEqual(quotes()['PMU Play'], Decimal('2.20'))
        with self.assertRaisesRegex(DailyVipMarketError, 'odds_market_ambiguous'):
            quotes(original.replace('2.20', '2.21', 1))

    def test_suspended_book_does_not_replace_the_score_with_another_market_or_book(self):
        suspended = SHELTON['compactHtml'].replace('2.20', '0')
        self.assertEqual(quotes(suspended), {'Unibet': Decimal('2.10')})
        with self.assertRaisesRegex(DailyVipMarketError, 'exact_market_price_unavailable'):
            quotes(suspended.replace('2.10', '0'))


if __name__ == '__main__':
    unittest.main()
