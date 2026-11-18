"""Typed source choices and exact observed SportyTrader table boundaries."""
from decimal import Decimal
import unittest

from editorial_worker.daily_vip_markets import parse_recommendation as parse, extract_exact_market_prices as prices, DailyVipMarketError
from editorial_worker.vendor.rdj_collector import Document


def table(title, labels, rows, section='RESULT', panel=None):
    body = '<span class="design-title title-h4">' + title + '</span>'
    body += '<div class="grid font-semibold">' + ''.join('<span>' + x + '</span>' for x in ['Bookmaker', *labels, 'Bonus']) + '</div>'
    for book, values in rows:
        body += f'<a href="/book/{book}/odds">' + ''.join('<div>' + x + '</div>' for x in [*values, '100€']) + '</a>'
    body = '<div>' + body + '</div>'
    if panel:
        body = '<div data-panel-key="' + panel + '">' + body + '</div>'
    return '<section id="' + section + '">' + body + '</section>'


class MarketTests(unittest.TestCase):
    def setUp(self):
        self.teams = {'home': {'name': 'Santos'}, 'away': {'name': 'Coritiba'}}

    def test_exact_simple_and_btts_formulations(self):
        self.assertEqual(parse('Victoire de Santos', self.teams, 'football')['side'], '1')
        self.assertEqual(parse('but pour les deux équipes', self.teams, 'football')['betType'], 'btts')
        self.assertEqual(parse('Santos ou nul', self.teams, 'football')['side'], '1N')

    def test_composite_is_preserved_not_simplified(self):
        pick = parse('Santos ou nul et moins de 3.5 buts', self.teams, 'football')
        self.assertEqual(pick['betType'], 'combined_market')
        self.assertEqual([p['betType'] for p in pick['components']], ['double_chance', 'over_under_goals'])
        with self.assertRaisesRegex(DailyVipMarketError, 'exact_market_price_unavailable'):
            prices(Document(table('Double Chance - Vainqueur', ['1N', 'N2', '12'], [('unibet', ['1.2', '2.3', '1.1'])])).root, pick, self.teams, 'football')

    def test_tennis_combined_total_and_player_points_remain_exact(self):
        teams = {'home': {'name': 'Carlos Alcaraz'}, 'away': {'name': 'Daniil Medvedev'}}
        pick = parse('victoire de Carlos Alcaraz en plus de 21,5 jeux', teams, 'tennis')
        self.assertEqual(pick['betType'], 'combined_market')
        self.assertEqual(pick['components'][1]['side'], '+21.5')
        prop = parse('Luka Doncic marque plus de 29.5 points', self.teams, 'basketball')
        self.assertEqual(prop['player'], 'Luka Doncic')
        self.assertEqual(prop['side'], '+29.5')

    def test_winner_with_clean_sheet_needs_its_exact_combined_quote(self):
        pick = parse('Santos gagne & garde sa cage inviolée', self.teams, 'football')
        fragment = table('Équipe 1 gagne sans encaisser', ['Oui', 'Non'], [('unibet', ['1.80', '1.60'])])
        self.assertEqual(prices(Document(fragment).root, pick, self.teams, 'football'), {'Unibet': Decimal('1.80')})
        with self.assertRaisesRegex(DailyVipMarketError, 'exact_market_price_unavailable'):
            prices(Document(fragment.replace('gagne sans encaisser', 'garde sa cage inviolée')).root, pick, self.teams, 'football')

    def test_unknown_condition_and_partial_period_are_not_partial_winner(self):
        for text in ['Santos gagne et reçoit 2 cartons', 'Santos gagne le premier set', 'Un inconnu gagne']:
            self.assertIsNone(parse(text, self.teams, 'football'))

    def test_exact_double_chance_column_and_full_match_only(self):
        pick = parse('Santos ou nul', self.teams, 'football')
        valid = table('Double Chance - Vainqueur', ['1N', 'N2', '12'], [('unibet', ['1.01', '2.30', '1.03']), ('pmu', ['1.02', '5.00', '1.06'])])
        wrong = table('Double Chance - 1ère mi-temps', ['1N', 'N2', '12'], [('unibet', ['8.8', '9.9', '7.7'])], section='PERIOD')
        self.assertEqual(prices(Document(valid + wrong).root, pick, self.teams, 'football'), {'Unibet': Decimal('1.01'), 'PMU Play': Decimal('1.02')})

    def test_draw_no_bet_has_its_own_title(self):
        pick = parse('Santos remboursé si match nul', self.teams, 'football')
        valid = table('Vainqueur (remboursé si match nul)', ['1', '2'], [('unibet', ['1.02', '4.50'])])
        self.assertEqual(prices(Document(valid).root, pick, self.teams, 'football'), {'Unibet': Decimal('1.02')})
        with self.assertRaisesRegex(DailyVipMarketError, 'exact_market_price_unavailable'):
            prices(Document(valid.replace('Vainqueur (remboursé si match nul)', 'Vainqueur')).root, pick, self.teams, 'football')

    def test_handicap_requires_exact_line_and_side(self):
        pick = parse('Santos gagne de 5 points ou plus', self.teams, 'basketball')
        self.assertEqual(pick['line'], '-4.5')
        fragment = table('Handicap -4.5', ['1 (-4.5)', '2 (+4.5)'], [('betclic', ['1.65', '1.95']), ('bwin', ['1.62', '1.95'])], section='SPREAD')
        self.assertEqual(prices(Document(fragment).root, pick, self.teams, 'basketball'), {'Betclic': Decimal('1.65'), 'Bwin': Decimal('1.62')})
        pick['line'] = '-5.5'
        with self.assertRaisesRegex(DailyVipMarketError, 'exact_market_price_unavailable'):
            prices(Document(fragment).root, pick, self.teams, 'basketball')

    def test_points_total_exact_panel_and_no_cross_book_multiplication(self):
        pick = parse('plus de 228.5 points', self.teams, 'basketball')
        valid = table('Plus / Moins', ['-228.5', '+228.5'], [('betclic', ['1.67', '1.92']), ('winamax', ['1.56', '1.90'])], section='UNDER_OVER', panel='UNDER_OVER_228_5')
        other = table('Plus / Moins', ['-229.5', '+229.5'], [('unibet', ['1.55', '1.90'])], section='UNDER_OVER', panel='UNDER_OVER_229_5')
        self.assertEqual(prices(Document(valid + other).root, pick, self.teams, 'basketball'), {'Betclic': Decimal('1.92'), 'Winamax': Decimal('1.90')})

    def test_tennis_games_never_prices_set_total(self):
        pick = parse('plus de 21.5 jeux', self.teams, 'tennis')
        fragment = table('Plus / Moins Jeux', ['-21.5', '+21.5'], [('unibet', ['1.8', '1.9'])], section='UNDER_OVER', panel='UNDER_OVER_21_5')
        self.assertEqual(prices(Document(fragment).root, pick, self.teams, 'tennis'), {'Unibet': Decimal('1.9')})
        with self.assertRaisesRegex(DailyVipMarketError, 'exact_market_price_unavailable'):
            prices(Document(fragment.replace('Plus / Moins Jeux', 'Plus / Moins Set')).root, pick, self.teams, 'tennis')

    def test_duplicate_quote_table_and_unsupported_player_price_fail_closed(self):
        pick = parse('Santos ou nul', self.teams, 'football')
        fragment = table('Double Chance - Vainqueur', ['1N', 'N2', '12'], [('unibet', ['1.1', '2.3', '1.2'])])
        with self.assertRaisesRegex(DailyVipMarketError, 'odds_market_ambiguous'):
            prices(Document(fragment + fragment).root, pick, self.teams, 'football')
        prop = parse('Luka Doncic marque plus de 29.5 points', self.teams, 'basketball')
        with self.assertRaisesRegex(DailyVipMarketError, 'exact_market_price_unavailable'):
            prices(Document(fragment).root, prop, self.teams, 'basketball')


if __name__ == '__main__':
    unittest.main()
