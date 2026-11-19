"""The current fixture owns its conclusion; adjacent matches cannot supply it."""
import unittest

from editorial_worker import daily_vip as d
from editorial_worker.vendor.rdj_collector import Document


def teams(home='Santos', away='Coritiba'):
    return {'home': {'name': home}, 'away': {'name': away}}


def paragraph(fixture='Santos - Coritiba', pick='victoire de Santos'):
    return '<p>Notre pronostic ' + fixture + ' : ' + pick + ' !</p>'


def recommend(body, expected=None, sport='football'):
    return d.recommendation(Document(body).root, expected or teams(), sport)


class DailyVipRecommendationTests(unittest.TestCase):
    def test_related_fixture_does_not_invalidate_the_current_author_recommendation(self):
        main = '<main>' + paragraph() + '</main>'
        related = '<aside>' + paragraph('Autre A - Autre B', 'victoire de Autre A') + '</aside>'
        for body in [main + related, related + main]:
            with self.subTest(body=body):
                pick = recommend(body)
                self.assertEqual(pick['betType'], 'match_winner')
                self.assertEqual(pick['side'], '1')
                self.assertEqual(pick['raw'], 'victoire de Santos')

    def test_prose_wrapper_does_not_merge_its_paragraphs_into_a_new_pick(self):
        body = '<div class="prose dark:text-white">' + paragraph() + paragraph(
            'Autre A - Autre B', 'victoire de Autre A') + '</div>'
        self.assertEqual(recommend(body)['side'], '1')

    def test_duplicate_matching_conclusions_are_one_pick_even_inside_nested_prose(self):
        body = '<div class="prose dark:text-white"><div class="prose dark:text-white">'
        body += paragraph() + paragraph() + '</div></div>'
        self.assertEqual(recommend(body)['side'], '1')

    def test_conclusion_directly_in_a_prose_div_remains_supported(self):
        body = '<div class="prose dark:text-white">Notre pronostic Santos - Coritiba : '
        body += '<strong>victoire de Santos</strong> !</div>'
        self.assertEqual(recommend(body)['side'], '1')

    def test_only_foreign_reversed_youth_or_gender_changed_conclusions_still_fail_identity(self):
        for fixture in ['Autre A - Autre B', 'Coritiba - Santos', 'Santos U21 - Coritiba', 'Santos F - Coritiba F']:
            with self.subTest(fixture=fixture), self.assertRaisesRegex(d.DailyVipError, 'recommendation_identity_conflict'):
                recommend(paragraph(fixture))

    def test_foreign_conclusion_cannot_rescue_the_current_unsupported_pick(self):
        body = paragraph(pick='Santos gagne en première mi-temps')
        body += paragraph('Autre A - Autre B', 'victoire de Autre A')
        with self.assertRaisesRegex(d.DailyVipError, 'recommended_market_unsupported'):
            recommend(body)

    def test_two_different_picks_for_the_current_fixture_remain_ambiguous(self):
        body = paragraph() + paragraph(pick='victoire de Coritiba')
        with self.assertRaisesRegex(d.DailyVipError, 'recommendation_missing_or_ambiguous'):
            recommend(body)

    def test_missing_conclusion_cannot_use_an_automatic_prediction(self):
        with self.assertRaisesRegex(d.DailyVipError, 'recommendation_missing_or_ambiguous'):
            recommend('<p>Notre algorithme prévoit Santos vainqueur à 68 %.</p>')

    def test_observed_november_19_football_and_nba_recommendations_keep_their_full_picks(self):
        cases = [
            ('Corinthians', 'Botafogo', 'Corinthians - Botafogo RJ', 'victoire de Corinthians', 'football', 'match_winner', '1'),
            ('Paris FC F', 'HB Koege F', 'Paris FC - Koge', 'victoire du Paris FC', 'football', 'match_winner', '1'),
            ('Barcelone F', 'Servette FC Chênois F', 'FC Barcelone - Servette FC', 'plus de 5,5 buts dans le match', 'football', 'over_under_goals', '+5.5'),
            ('Toronto Raptors', 'Washington Wizards', 'Toronto Raptors - Washington Wizards', 'Victoire des Raptors', 'basketball', 'match_winner', '1'),
            ('Dallas Mavericks', 'Other away', 'Dallas Mavericks - Other away', 'Victoire des Mavericks', 'basketball', 'match_winner', '1'),
            ('Detroit Pistons', 'Other away', 'Detroit Pistons - Other away', 'Victoire des Pistons', 'basketball', 'match_winner', '1'),
        ]
        for home, away, fixture, raw, sport, kind, side in cases:
            with self.subTest(fixture=fixture):
                pick = recommend(paragraph(fixture, raw), teams(home, away), sport)
                self.assertEqual(pick['betType'], kind)
                self.assertEqual(pick['side'], side)
                self.assertEqual(pick['raw'], raw)

    def test_rugby_alias_never_simplifies_an_unsupported_margin_into_a_winner(self):
        raw = 'Provence Rugby ne perd pas ou perd de 7 ou moins'
        body = paragraph('Grenoble - Provence Rugby', raw)
        try:
            pick = recommend(body, teams('Grenoble Rugby', 'Provence Rugby'), 'rugby')
        except d.DailyVipError as exc:
            self.assertEqual(exc.code, 'daily_vip_recommended_market_unsupported')
        else:
            # A dedicated market adapter may support this later. The alias
            # repair must still never drop the condition or price a winner.
            self.assertEqual(pick['betType'], 'handicap')
            self.assertEqual(pick['raw'], raw)


if __name__ == '__main__':
    unittest.main()
