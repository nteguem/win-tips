"""Reduced publisher structures observed on 25 November, without article prose."""
import unittest

from editorial_worker import daily_vip as d
from editorial_worker.vendor.rdj_collector import Document


def page(home, away, fixture, pick, *, before='', after=''):
    return Document('<main>' + before
        + '<h2 data-trans="tips.conclusion %homeTeam% %awayTeam%">Notre prono '
        + home + ' vs ' + away + '</h2><div class="prose dark:text-white"><p>'
        + 'Notre pronostic ' + fixture + ' : ' + pick + ' !</p></div>'
        + '<h2 data-trans="tips.secondary.tips.title %homeTeam% %awayTeam%">Autres pronostics</h2>'
        + after + '</main>').root


def teams(home, away):
    return {'home': {'name': home}, 'away': {'name': away}}


class AuthorSectionTests(unittest.TestCase):
    def test_publisher_conclusion_owns_pick_even_when_other_widget_names_same_fixture(self):
        duplicate = '<p>Notre pronostic Stoke City - Millwall FC : victoire de Millwall FC !</p>'
        root = page('Stoke City', 'Millwall FC', 'Stoke City - Millwall',
                    'victoire de Stoke City', before=duplicate, after=duplicate)
        result = d.recommendation(root, teams('Stoke City', 'Millwall FC'), 'football')
        self.assertEqual(result['side'], '1')

    def test_wrong_opponent_in_source_conclusion_is_not_replaced_by_heading(self):
        root = page('Slavia Prague', 'Villarreal CF', 'Slavia Prague - Barcelone',
                    'plus de 2.5 buts dans le match')
        with self.assertRaisesRegex(d.DailyVipError, 'recommendation_identity_conflict'):
            d.recommendation(root, teams('Slavia Prague', 'Villarreal CF'), 'football')

    def test_wrong_or_reversed_heading_does_not_borrow_other_page_text(self):
        for home, away in [('Other club', 'Millwall FC'), ('Millwall FC', 'Stoke City')]:
            root = page(home, away, 'Stoke City - Millwall FC', 'victoire de Stoke City')
            with self.subTest(home=home), self.assertRaisesRegex(d.DailyVipError, 'recommendation_identity_conflict'):
                d.recommendation(root, teams('Stoke City', 'Millwall FC'), 'football')

    def test_duplicate_conclusion_landmarks_remain_ambiguous(self):
        body = '<h2 data-trans="tips.conclusion %homeTeam% %awayTeam%">Notre prono Stoke City vs Millwall FC</h2>'
        root = Document(body + body).root
        with self.assertRaisesRegex(d.DailyVipError, 'editorial_conclusion_ambiguous'):
            d.recommendation(root, teams('Stoke City', 'Millwall FC'), 'football')

    def test_observed_editorial_phrase_and_nba_nickname(self):
        root = Document('<p>Le pronostic de la rédaction pour le match Philadelphie 76ers - Miami Heat en NBA est : Victoire des Sixers !</p>').root
        result = d.recommendation(root, teams('Philadelphie 76ers', 'Miami Heat'), 'basketball')
        self.assertEqual(result['betType'], 'match_winner')
        self.assertEqual(result['side'], '1')

    def test_missing_author_pick_does_not_borrow_related_winner(self):
        root = page('Stoke City', 'Millwall FC', 'Stoke City - Millwall FC',
            'Stoke City gagne en première mi-temps',
            after='<p>Notre pronostic Stoke City - Millwall FC : victoire de Stoke City !</p>')
        with self.assertRaisesRegex(d.DailyVipError, 'recommended_market_unsupported'):
            d.recommendation(root, teams('Stoke City', 'Millwall FC'), 'football')


if __name__ == '__main__':
    unittest.main()
