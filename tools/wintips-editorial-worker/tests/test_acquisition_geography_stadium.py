import json
from pathlib import Path
import unittest

from editorial_worker.translation import _fixture, _prompt, validate_english_sentence
from editorial_worker.vendor import rdj_translation as guard


FIXTURE = Path(__file__).parent / 'fixtures/acquisition-geography-stadium-20261024.json'


class AcquisitionGeographyStadiumTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads(FIXTURE.read_bytes().decode('utf-8'))
        self.rows = self.fixture['responses']

    def row(self, prefix):
        return next(row for row in self.rows if row['nativeFile'].startswith(prefix))

    def item(self, row):
        return {'editionDate': self.fixture['editionDate'], 'sport': {'key': 'football'}, 'teams': row['teams']}

    def check(self, row, target=None, expected=True, item=None):
        _, proof = validate_english_sentence(row['source'], target or row['target'], item or self.item(row))
        self.assertEqual(proof['passed'], expected, proof)
        return proof

    def test_nine_genuine_responses_reject_both_passed_mistranslations(self):
        self.assertEqual(len(self.rows), 9)
        self.assertEqual(len(self.fixture['provenanceManifestSha256']), 64)
        for row in self.rows:
            self.assertEqual(len(row['nativeSha256']), 64)
            self.check(row, expected=row['expectedPassedAfterFix'])

    def test_affirmative_acquisition_keeps_english_deictic_and_result(self):
        row = self.row('a8723c')
        for pronoun in ('This', 'It', 'That'):
            for predicate in ('was secured', 'was achieved', 'was earned', 'was obtained', 'has been secured'):
                proof = self.check(row, row['target'].replace('This was secured', pronoun + ' ' + predicate))
                self.assertEqual(proof['remasking_proof']['source_token_order'], proof['remasking_proof']['accepted_token_order'])
                self.assertEqual(sum(a['kind'] == 'deictic_acquisition' for a in proof['anchors']), 1)

    def test_acquisition_cannot_be_lost_negated_claimed_or_left_in_french(self):
        row = self.row('a8723c')
        for predicate in ('This lost', 'This was a loss', 'This was not secured', 'This failed to be secured',
                          'This was secured but was lost', 'Celle-ci was secured',
                          'They denied that this was secured', 'They claimed this was secured'):
            self.check(row, row['target'].replace('This was secured', predicate), False)
        for wrong in (row['target'].replace('Espanyol Barcelone', 'Girona'),
                      row['target'].replace('(1-3)', '(3-1)'),
                      row['target'] + ' This was a defeat.'):
            self.check(row, wrong, False)

    def test_explicit_participant_name_is_never_overridden_by_deictic_grammar(self):
        row = self.row('a8723c')
        item = self.item(row)
        item['teams'] = {'home': {'name': 'Celle-ci'}, 'away': {'name': 'Elche'}}
        masked, anchors = guard._protect(row['source'], _fixture(item))
        self.assertFalse(any(a['kind'] == 'deictic_acquisition' for a in anchors))
        self.assertTrue(any(a['kind'] == 'name' and a['source'] == 'Celle-ci' for a in anchors))
        self.check(row, expected=False, item=item)

    def test_survival_against_an_opponent_does_not_assert_a_victory(self):
        row = self.row('3824e5')
        for acquisition in ('survival secured only against Girona', 'survival narrowly secured against Girona',
                            'survival achieved against Girona', 'survival earned narrowly against Girona'):
            self.check(row, row['target'].replace('survival secured only against Girona', acquisition))
        for wrong in ('survival secured with a victory against Girona', 'survival secured by beating Girona',
                      'survival secured against Getafe', 'survival lost against Girona',
                      'survival secured only against Girona and Girona'):
            self.check(row, row['target'].replace('survival secured only against Girona', wrong), False)
        # An explicit win in another clause remains allowed and independently counted.
        self.check(row)

    def test_genuine_v45_survival_participle_keeps_all_outer_facts_in_order(self):
        row = self.row('3824e5')
        # Exact native targets from the 03:21 canonical preparation. French
        # source bytes are identical to the immutable 02:08 source fixture.
        good = ("Having already been in a precarious position last season, narrowly securing survival against Girona, "
                "Elche now finds itself in the relegation zone, in 18th place, with only one small victory to its name.")
        # Qwen da708d... / SHA e2d1e327... and Gemma dd969e... / SHA
        # b87416ab... produced this same target independently; no cache edited.
        proof = self.check(row, good)
        self.assertEqual(proof['remasking_proof']['source_token_order'], proof['remasking_proof']['accepted_token_order'])
        survival = next(a for a in proof['anchors'] if a['kind'] == 'survival_without_asserted_win')
        self.assertEqual(survival['typed_scope']['opponent'], 'Girona')
        # The first real Qwen answer left the relegation adjective in French.
        bad = ("Already on life support last season with survival narrowly secured against Girona, "
               "Elche finds itself relégable, in 18th place, with only a small victory to its credit.")
        self.check(row, bad, False)
        for wrong in (good.replace('securing survival', 'securing a victory'),
                      good.replace('against Girona', 'by beating Girona'),
                      good.replace('against Girona', 'against Getafe'),
                      good.replace('narrowly securing', 'not narrowly securing'),
                      good.replace('narrowly securing', 'narrowly losing'),
                      good.replace('Elche', 'Rayo Vallecano'),
                      good.replace('18th', '17th'),
                      good.replace('one small victory', 'two small victories'),
                      good.replace('Girona, Elche', 'Elche, Girona'),
                      good.replace('against Girona', 'against Girona and Girona')):
            self.check(row, wrong, False)

    def test_typed_geography_keeps_alps_separate_from_team_side(self):
        for row in self.rows[:3]:
            proof = self.check(row)
            geography = next(a for a in proof['anchors'] if a['kind'] == 'geographic_landmark_side')
            self.assertEqual(geography['typed_scope']['sourceName'], 'Alpes')
            self.assertEqual(geography['typed_scope']['targetName'], 'Alps')
            self.assertEqual(geography['typed_scope']['sources'], list(guard.ALPS_GEOGRAPHY_SOURCES))
            self.assertFalse(any(a['kind'] == 'name' and a['source'] == 'Alpes' for a in proof['anchors']))

    def test_geographic_alias_cannot_change_region_duplicate_or_move_actor(self):
        row = self.row('dccf9f')
        for wrong in (row['target'].replace('Alps', 'Pyrenees'),
                      row['target'].replace('other side of the Alps', 'Alps team'),
                      row['target'] + ' The Alps also won.',
                      row['target'].replace('other side', 'same side'),
                      row['target'].replace('Lombard team', 'Alps team'),
                      'On the other side of the Alps, ' + row['target'].split(' on the other side')[0] + '.'):
            self.check(row, wrong, False)

    def test_geographic_alias_does_not_apply_to_a_team_or_bare_geographic_name(self):
        item = {'sport': {'key': 'football'}, 'teams': {'home': {'name': 'Alpes'}, 'away': {'name': 'Lyon'}}}
        _, proof = validate_english_sentence('Alpes a gagné.', 'Alps won.', item)
        self.assertFalse(proof['passed'])
        row = dict(self.row('dccf9f'), source='Alpes joue vendredi.', target='Alps plays Friday.')
        self.check(row, expected=False)

    def test_stadium_is_a_location_never_the_opponent(self):
        row = self.row('026bbc')
        for location in ('at the Ceramica of Villarreal', 'in the Ceramica de Villarreal'):
            proof = self.check(row, row['target'].replace('against the Ceramica of Villarreal', location))
            venue = next(a for a in proof['anchors'] if a.get('venue_scope', {}).get('rule') == 'verified_stadium_location')
            self.assertEqual(venue['venue_scope']['sourceUrl'], guard.CERAMICA_STADIUM_SOURCE)
        for wrong in ('against the Ceramica of Villarreal', 'facing the Ceramica of Villarreal',
                      'at the Ceramica against Villarreal', 'at the Ceramica of Valencia',
                      'at the Ceramica and Villarreal', 'at the Ceramica of Villarreal and the Ceramica'):
            self.check(row, row['target'].replace('against the Ceramica of Villarreal', wrong), False)

    def test_all_original_french_is_reconstructed_byte_for_byte_in_model_prompt(self):
        for row in self.rows:
            masked, anchors = guard._protect(row['source'], _fixture(self.item(row)))
            self.assertEqual(_prompt(masked, anchors).rpartition('\n\n\n')[2].encode('utf-8'), row['source'].encode('utf-8'))


if __name__ == '__main__':
    unittest.main()
