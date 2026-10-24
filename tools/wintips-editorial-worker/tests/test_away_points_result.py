import json
from pathlib import Path
import unittest

from editorial_worker.translation import _fixture, _prompt, validate_english_sentence
from editorial_worker.vendor import rdj_translation as guard


FIXTURE = Path(__file__).parent / 'fixtures/away-points-20261024.json'


class AwayPointResultTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads(FIXTURE.read_bytes().decode('utf-8'))
        self.source = self.fixture['responses'][0]['source']
        self.good = next(r['target'] for r in self.fixture['responses'] if r['expectedPassedAfterFix'])
        self.item = {'sport': {'key': 'football'}, 'editionDate': '2026-10-24',
                     'teams': {'home': {'name': 'Rayo Vallecano'}, 'away': {'name': 'Elche'}}}

    def check(self, source, target, expected=True, item=None):
        _, proof = validate_english_sentence(source, target, item or self.item)
        self.assertEqual(proof['passed'], expected, proof)
        return proof

    def test_three_genuine_responses_accept_only_the_faithful_local_order(self):
        self.assertEqual(len(self.fixture['responses']), 3)
        self.assertIn('sont allés prendre un point', self.source)
        self.assertNotIn('Ã', self.source)
        for row in self.fixture['responses']:
            self.assertEqual(len(row['nativeSha256']), 64)
            self.check(row['source'], row['target'], row['expectedPassedAfterFix'])

    def test_both_internal_point_venue_orders_keep_the_same_outer_token_order(self):
        predicate = 'went away to Getafe and took a point'
        for replacement in ('earned one point away to Getafe', 'took a point at Getafe',
                            'went to Getafe to earn a point', 'went away to Getafe and picked up one point'):
            proof = self.check(self.source, self.good.replace(predicate, replacement))
            self.assertEqual(proof['remasking_proof']['source_token_order'], proof['remasking_proof']['accepted_token_order'])
            self.assertTrue(proof['ordered_facts_preserved'])
            self.assertEqual(sum(a['kind'] == 'away_point_result' for a in proof['anchors']), 1)
            self.assertEqual(sum(a['kind'] == 'recent_result_matchday' for a in proof['anchors']), 1)

    def test_latest_round_is_not_an_asserted_final_first_or_next_round(self):
        for recent in ('latest', 'most recent', 'last'):
            self.check(self.source, self.good.replace('last matchday', recent + ' matchday'))
        for wrong in ('final', 'first', 'next', 'penultimate', 'season-ending'):
            self.check(self.source, self.good.replace('last matchday', wrong + ' matchday'), False)
        self.check(self.source, self.good.replace('(1-1).', '(1-1), the final round of the season.'), False)

    def test_french_soir_preserves_evening_or_night_but_never_morning(self):
        for period in ('evening', 'night'):
            proof = self.check(self.source, self.good.replace('Monday evening', 'Monday ' + period))
            self.assertEqual(proof['remasking_proof']['source_token_order'], proof['remasking_proof']['accepted_token_order'])
        for period in ('morning', 'afternoon'):
            self.check(self.source, self.good.replace('Monday evening', 'Monday ' + period), False)

    def test_other_actor_home_venue_quantity_or_negative_result_cannot_satisfy_frame(self):
        for wrong in (self.good.replace('Rayo Vallecano', 'Elche'), self.good.replace('Getafe', 'Osasuna'),
                      self.good.replace('went away to', 'played at home against'),
                      self.good.replace('went away to', 'went home to'),
                      self.good.replace('a point', 'two points'), self.good.replace('a point', 'zero points'),
                      self.good.replace('took a point', 'lost a point'), self.good.replace('took a point', 'conceded a point'),
                      self.good.replace('a point', 'a point and a half'), self.good.replace('a point', 'a goal'),
                      self.good.replace('(1-1)', '(1-2)'), self.good.replace('(1-1)', '(2-1)')):
            self.check(self.source, wrong, False)

    def test_denial_claim_counterfactual_and_an_extra_actor_are_not_affirmative_past_results(self):
        for wrong in (self.good.replace('took a point', 'did not take a point'),
                      self.good.replace('went away', 'did not go away'),
                      self.good.replace('players went', 'players denied that they went'),
                      self.good.replace('players went', 'players claimed that they went'),
                      self.good.replace('players went', 'players watched Elche as they went'),
                      self.good.replace('players went', 'players could go'),
                      'They denied the claim that ' + self.good,
                      self.good + ' They did not take a point.'):
            self.check(self.source, wrong, False)

    def test_weekday_actor_and_cross_clause_order_are_not_permutable(self):
        for wrong in (self.good.replace('Monday', 'Tuesday'), self.good.replace('evening', 'morning'),
                      self.good.replace("Rayo Vallecano's players", "Getafe's players").replace('to Getafe', 'to Rayo Vallecano'),
                      "Went away to Getafe and took a point, Rayo Vallecano's players on Monday evening during the last matchday (1-1).",
                      self.good.replace('during the last matchday', 'at home during the last matchday'),
                      self.good.replace('during the last matchday', 'after Elche played during the last matchday')):
            self.check(self.source, wrong, False)

    def test_verified_other_team_day_and_three_point_win_use_same_general_rule(self):
        source = 'Vendredi matin, les joueurs du Stade Rennais sont allés prendre trois points sur la pelouse de Nantes lors de la dernière journée (0-1).'
        item = {'sport': {'key': 'football'}, 'editionDate': '2026-10-24',
                'teams': {'home': {'name': 'Stade Rennais'}, 'away': {'name': 'Lyon'}}}
        good = 'On Friday morning, the players from Stade Rennais earned three points away to Nantes during the most recent matchday (0-1).'
        self.check(source, good, item=item)
        self.check(source, good.replace('(0-1)', '(1-0)'), False, item)
        self.check(source, good.replace('three points', 'one point'), False, item)
        self.check(source, good.replace('earned three points', 'lost three points'), False, item)
        for inconsistent in ('2-0', '1-0', '0-0'):
            self.assertIsNone(guard._away_point_source_frame(source.replace('0-1', inconsistent), _fixture(item)))

    def test_scope_requires_verified_actor_finite_past_and_explicit_consistent_result(self):
        for changed in (self.source.replace('sont allés', 'vont aller'),
                        self.source.replace('un point', 'deux points'),
                        self.source.replace('(1-1)', '(1-2)'),
                        self.source.replace('lors de la dernière journée', 'lors de la dernière journée de la saison'),
                        self.source.replace('Rayo Vallecano', 'Osasuna')):
            self.assertIsNone(guard._away_point_source_frame(changed, _fixture(self.item)))
        other = dict(self.item, sport={'key': 'basketball'})
        self.assertIsNone(guard._away_point_source_frame(self.source, _fixture(other)))
        self.assertIsNone(guard._away_point_source_frame('Lors de la dernière journée.', _fixture(self.item)))

    def test_prompt_and_restored_names_preserve_the_exact_original_french(self):
        masked, anchors = guard._protect(self.source, _fixture(self.item))
        prompt = _prompt(masked, anchors)
        self.assertEqual(prompt.rpartition('\n\n\n')[2], self.source)
        result = next(a for a in anchors if a['kind'] == 'away_point_result')
        self.assertEqual(result['away_result_scope']['actor'], 'Rayo Vallecano')
        self.assertEqual(result['away_result_scope']['venue'], 'Getafe')
        self.assertEqual(result['away_result_scope']['quantity'], 1)
        self.assertEqual(result['away_result_scope']['score'], '1-1')


if __name__ == '__main__':
    unittest.main()
