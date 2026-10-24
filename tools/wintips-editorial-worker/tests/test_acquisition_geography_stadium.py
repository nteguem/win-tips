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
        # Unit-test candidates only: the actual native target remains rejected
        # above. The compound must first express its exact source goal count.
        target = row['target'].replace('two clean draws at home against Celta Vigo', 'two goalless draws against Celta Vigo at home')
        for location in ('at the Ceramica of Villarreal', 'in the Ceramica de Villarreal',
                         'at the Ceramica stadium in Villarreal', 'in the Ceramica in Villarreal'):
            proof = self.check(row, target.replace('against the Ceramica of Villarreal', location))
            venue = next(a for a in proof['anchors'] if a.get('venue_scope', {}).get('rule') == 'verified_stadium_location')
            self.assertEqual(venue['venue_scope']['sourceUrl'], guard.CERAMICA_STADIUM_SOURCE)
        for wrong in ('against the Ceramica of Villarreal', 'facing the Ceramica of Villarreal',
                      'at the Ceramica against Villarreal', 'at the Ceramica of Valencia',
                      'at the Ceramica and Villarreal', 'at the Ceramica of Villarreal and the Ceramica',
                      'at the Ceramica stadium against Villarreal',
                      'at the Ceramica where they played in Villarreal',
                      'at the Ceramica stadium in Getafe'):
            self.check(row, target.replace('against the Ceramica of Villarreal', wrong), False)

    def test_three_v45_short_native_draw_responses_remain_refused(self):
        row = self.row('026bbc')
        # Exact raw English from 5fb2e80b... and f710e10a...; the third native
        # b5021e9d... equals the immutable 026bbc fixture target. No cached
        # native is corrected or relabelled as an accepted model response.
        targets = (
            'Since the return from the break, the Franjiverdes have recorded two draws and goalless draws against Celta Vigo at home (0-0) and last weekend at the Ceramica stadium in Villarreal (0-0), which remains, in the end, quite encouraging for the teammates of Thomas Lemar.',
            'Since the end of the break, Franjiverdes have recorded two draws and goalless draws against Celta Vigo at home (0-0) and last weekend at the Ceramica stadium in Villarreal (0-0), which remains quite encouraging for the team alongside Thomas Lemar.',
            row['target'],
        )
        for target in targets:
            self.check(row, target, False)

    def test_counted_goalless_draw_compound_keeps_count_result_and_outer_facts(self):
        row = self.row('026bbc')
        target = row['target'].replace('two clean draws at home against Celta Vigo', 'two goalless draws against Celta Vigo at home').replace(
            'against the Ceramica of Villarreal', 'at the Ceramica stadium in Villarreal')
        for count in ('two', '2'):
            for adjective in ('goalless', 'scoreless'):
                proof = self.check(row, target.replace('two goalless draws', count + ' ' + adjective + ' draws'))
                anchor = next(a for a in proof['anchors'] if a['kind'] == 'counted_goalless_draws')
                self.assertEqual(anchor['source'], 'deux matchs nuls et vierges')
                self.assertEqual(anchor['typed_scope']['quantity'], 2)
                self.assertEqual(proof['remasking_proof']['source_token_order'], proof['remasking_proof']['accepted_token_order'])
        for wrong in ('one goalless draw', 'three goalless draws', 'two scoring draws',
                      'two clean draws', 'two goalless wins', 'two scoreless defeats',
                      'two draws and goalless draws', 'two goalless draws and more draws',
                      'two goalless draws and two draws', 'two goalless draws and one defeat',
                      'two goalless draws and a victory'):
            self.check(row, target.replace('two goalless draws', wrong), False)
        for wrong in (target.replace('Celta Vigo', 'Getafe'),
                      target.replace('Franjiverdes', 'Rayo Vallecano'),
                      target.replace('at home', 'away'),
                      target.replace('last weekend', 'next weekend'),
                      target.replace('(0-0)', '(0-1)', 1),
                      target.replace('Celta Vigo at home', 'at home against Celta Vigo and Elche')):
            self.check(row, wrong, False)

    def test_counted_draw_rule_is_source_scoped_and_reproducible_for_other_counts(self):
        item = self.item(self.row('026bbc'))
        for source, count in (('trois matchs nuls et vierges', 'three'), ('5 matchs nuls et vierges', 'five')):
            french = 'Elche a signé ' + source + '.'
            english = 'Elche recorded ' + count + ' goalless draws.'
            _, proof = validate_english_sentence(french, english, item)
            self.assertTrue(proof['passed'], proof)
            _, bad = validate_english_sentence(french, english.replace(count, 'two'), item)
            self.assertFalse(bad['passed'])
        masked, anchors = guard._protect('Elche a signé deux matchs nuls.', _fixture(item))
        self.assertFalse(any(a['kind'] == 'counted_goalless_draws' for a in anchors))

    def test_prompt_guidance_preserves_typed_stadium_role_and_source_bytes(self):
        row = self.row('026bbc')
        masked, anchors = guard._protect(row['source'], _fixture(self.item(row)))
        prompt = _prompt(masked, anchors)
        self.assertIn('two goalless draws', prompt)
        self.assertIn('verified stadium location: "Ceramica"', prompt)
        self.assertIn('"Villarreal"', prompt)
        self.assertIn('never against/facing/playing the stadium', prompt)
        self.assertEqual(prompt.rpartition('\n\n\n')[2].encode('utf-8'), row['source'].encode('utf-8'))
        other = self.row('3824e5')
        masked, anchors = guard._protect(other['source'], _fixture(self.item(other)))
        self.assertNotIn('verified stadium location:', _prompt(masked, anchors))

    def test_source_home_result_allows_only_local_home_opponent_commutation(self):
        row = self.row('026bbc')
        target = row['target'].replace('two clean draws', 'two goalless draws').replace(
            'against the Ceramica of Villarreal', 'at the Ceramica stadium in Villarreal')
        for local in ('at home against Celta Vigo (0-0)', 'against Celta Vigo at home (0-0)'):
            proof = self.check(row, target.replace('at home against Celta Vigo (0-0)', local))
            self.assertTrue(proof['remasking_proof']['scoped_home_results'][0]['passed'])
        for local in ('away against Celta Vigo (0-0)', 'against Celta Vigo away (0-0)',
                      'against Celta Vigo (0-0)', 'against Celta Vigo at home (0-1)',
                      'at home against Getafe (0-0)', 'at home against Celta Vigo, then (0-0)',
                      'at home against Celta Vigo and Elche (0-0)',
                      'and one defeat at home against Celta Vigo (0-0)',
                      'and a victory against Celta Vigo at home (0-0)',
                      'against Celta Vigo at home. Another match ended (0-0)'):
            self.check(row, target.replace('at home against Celta Vigo (0-0)', local), False)

    def test_two_genuine_roma_targets_gain_only_the_source_proven_home_draw_adjective(self):
        source = 'Par la suite, ils ont tenu en échec la Roma à domicile (0-0) et gagné sur le terrain de la Fiorentina le week-end dernier (1-3).'
        item = {'sport': {'key': 'football'}, 'teams': {'home': {'name': 'Côme'}, 'away': {'name': 'Sassuolo'}}}
        # Unchanged real Qwen 5489bfef... SHA1dad7519... and 934fb335...
        # SHA168d7b38..., not synthetic replacements of either cached target.
        targets = (
            'Then, they held Roma to a home draw (0-0) and won away against Fiorentina last weekend (1-3).',
            'Then, they held Roma to a home draw (0-0) and won at Fiorentina last weekend (1-3).',
        )
        for target in targets:
            _, proof = validate_english_sentence(source, target, item)
            self.assertTrue(proof['passed'], proof)
            self.assertTrue(proof['remasking_proof']['scoped_home_draw_adjectives'][0]['passed'])
            self.assertEqual(proof['remasking_proof']['source_token_order'], proof['remasking_proof']['accepted_token_order'])
            self.assertFalse(any('_validation_home_draw_scope' in anchor for anchor in proof['anchors']))
        target = targets[0]
        for wrong in (target.replace('a home draw', 'an away draw'),
                      target.replace('a home draw', 'a home win'),
                      target.replace('a home draw', 'a home defeat'),
                      target.replace('a home draw', 'a draw'),
                      target.replace('held Roma', 'held Napoli'),
                      target.replace('held Roma', 'did not hold Roma'),
                      target.replace('they held', 'they denied that they held'),
                      target.replace('they held', 'they claimed they held'),
                      target.replace('held Roma to', 'Roma held them to'),
                      target.replace('home draw (0-0)', 'home draw (1-0)'),
                      target.replace('home draw (0-0)', 'home draw (1-1)'),
                      target.replace('home draw (0-0)', 'home draw, another match ended (0-0)'),
                      target.replace('Fiorentina', 'Roma'),
                      target.replace('(1-3)', '(3-1)')):
            _, proof = validate_english_sentence(source, wrong, item)
            self.assertFalse(proof['passed'], (wrong, proof))

    def test_home_draw_adjective_never_generalizes_to_other_source_results_or_units(self):
        source = 'Par la suite, ils ont tenu en échec la Roma à domicile (0-0) et gagné sur le terrain de la Fiorentina le week-end dernier (1-3).'
        target = 'Then, they held Roma to a home draw (0-0) and won away against Fiorentina last weekend (1-3).'
        item = {'sport': {'key': 'football'}, 'teams': {'home': {'name': 'Côme'}, 'away': {'name': 'Sassuolo'}}}
        masked, anchors = guard._protect(source, _fixture(item))
        identity = json.dumps(anchors, ensure_ascii=False)
        prompt = _prompt(masked, anchors)
        guard._validate(masked, anchors, {'message': {'content': target}, 'done': True}, fixture=_fixture(item))
        self.assertEqual(identity, json.dumps(anchors, ensure_ascii=False))
        self.assertEqual(prompt, _prompt(masked, anchors))
        for wrong_source in (source.replace('tenu en échec', 'battu'),
                             source.replace('tenu en échec', 'perdu contre'),
                             source.replace('(0-0)', '(1-0)'),
                             source.replace('ils ont tenu', "ils n'ont pas tenu"),
                             source.replace('ils ont tenu', "ils ont affirmé qu'ils ont tenu"),
                             source.replace('ils ont tenu', "ils ont nié qu'ils ont tenu"),
                             source.replace('ils ont tenu', "s'ils ont tenu")):
            _, proof = validate_english_sentence(wrong_source, target, item)
            self.assertFalse(proof['passed'], (wrong_source, proof))
        away_masked, away_anchors = guard._protect(source.replace('à domicile', "à l'extérieur"), _fixture(item))
        self.assertEqual(guard._validation_home_draw_scopes(away_masked, away_anchors, _fixture(item)), {})
        _, proof = validate_english_sentence(source, target, {**item, 'sport': {'key': 'basketball'}})
        self.assertFalse(proof['passed'])

    def initial_defeat_case(self):
        source = 'Battus à Hambourg avant la trêve internationale (2-1), les hommes de Rene Wagner avaient ensuite pu réagir face à la lanterne rouge, le Borussia Mönchengladbach( 2-1).'
        item = {'sport': {'key': 'football'}, 'teams': {'home': {'name': 'Cologne'}, 'away': {'name': 'Schalke 04'}}}
        target = ('Beaten away at Hambourg before the international break (2-1), the men of Rene Wagner had then '
                  'been able to respond against the bottom team, Borussia Mönchengladbach (2-1).')
        return source, item, target

    def test_initial_passive_defeat_rejects_reported_native_active_result_inversion(self):
        source, item, good = self.initial_defeat_case()
        # Exact text reported from native 7bef298d... while the zero-POST
        # canonical run was still active. No cache is rewritten by this test.
        bad = ('"Battus" defeated "Hambourg" before the international break (2-1); the team led by "Rene Wagner" '
               'then managed to respond against the bottom team, "Borussia Mönchengladbach" (2-1).')
        _, proof = validate_english_sentence(source, bad, item)
        self.assertFalse(proof['passed'])
        self.assertIn('initial_passive_defeat_left_as_untranslated_actor', proof['errors'])
        for passive in ('Beaten away at Hambourg', 'Beaten at Hambourg', 'Defeated in Hambourg',
                        'Defeated away to Hambourg', 'Beaten by Hambourg',
                        'Having lost away at Hambourg', 'Having lost to Hambourg'):
            target = good.replace('Beaten away at Hambourg', passive)
            _, proof = validate_english_sentence(source, target, item)
            self.assertTrue(proof['passed'], (target, proof))
            self.assertTrue(proof['remasking_proof']['scoped_initial_passive_defeats'][0]['passed'])
            self.assertEqual(proof['remasking_proof']['source_token_order'], proof['remasking_proof']['accepted_token_order'])

    def test_initial_defeat_cannot_change_actor_polarity_venue_boundary_or_outer_facts(self):
        source, item, target = self.initial_defeat_case()
        for wrong in ('Defeated Hambourg', 'They defeated Hambourg', 'Not beaten at Hambourg',
                      'Unbeaten at Hambourg', 'Having not lost at Hambourg', 'If beaten at Hambourg',
                      'They denied being beaten at Hambourg', 'Allegedly beaten at Hambourg',
                      'Beaten at Cologne', 'Beaten by Hambourg at home',
                      'Beaten by Hambourg but won', 'Beaten at Hambourg and one victory',
                      'Beaten at Hambourg, but this was denied', 'Beaten at Hambourg and Hambourg'):
            _, proof = validate_english_sentence(source, target.replace('Beaten away at Hambourg', wrong), item)
            self.assertFalse(proof['passed'], (wrong, proof))
        for wrong in (target.replace('before', 'after'),
                      target.replace('international break', 'next international break'),
                      target.replace('international break', 'international break at home'),
                      target.replace('international break', 'international break but this was denied'),
                      target.replace('international break', 'international break after a victory'),
                      target.replace('(2-1),', '(2-1) at home,', 1),
                      target.replace('(2-1)', '(1-2)', 1),
                      target.replace('Rene Wagner', 'Hambourg'),
                      target.replace('Borussia Mönchengladbach', 'Schalke 04'),
                      target.replace('Hambourg before', 'Hambourg before Rene Wagner'),
                      target.replace('then', 'previously')):
            _, proof = validate_english_sentence(source, wrong, item)
            self.assertFalse(proof['passed'], (wrong, proof))

    def test_initial_defeat_inflections_and_explicit_names_keep_separate_roles(self):
        source, item, target = self.initial_defeat_case()
        for participle in ('Battu', 'Battue', 'Battus', 'Battues'):
            _, proof = validate_english_sentence(source.replace('Battus', participle, 1), target, item)
            self.assertTrue(proof['passed'], (participle, proof))
            initial = proof['anchors'][0]
            self.assertEqual(initial['kind'], 'initial_passive_away_defeat')
            self.assertEqual(initial['typed_scope']['venue'], 'Hambourg')
        for fixture in ({**_fixture(item), 'home': 'Battus'},
                        {**_fixture(item), 'protected_names': ['Battus']}):
            _, anchors = guard._protect(source, fixture)
            self.assertFalse(any(a['kind'] == 'initial_passive_away_defeat' for a in anchors))
            self.assertTrue(any(a['kind'] == 'name' and a['source'] == 'Battus' for a in anchors))
        for prefix in ('Si ', "Ils ont affirmé qu'ils étaient ", "Ils ont nié avoir été "):
            _, anchors = guard._protect(prefix + source, _fixture(item))
            self.assertFalse(any(a['kind'] == 'initial_passive_away_defeat' for a in anchors))
        _, anchors = guard._protect(source, {**_fixture(item), 'sport_key': 'basketball'})
        self.assertFalse(any(a['kind'] == 'initial_passive_away_defeat' for a in anchors))
        home_source = source.replace('à Hambourg', 'à Cologne', 1)
        for place, expected in (('at Cologne', True), ('away at Cologne', False), ('by Cologne', False)):
            home_target = target.replace('away at Hambourg', place, 1)
            _, proof = validate_english_sentence(home_source, home_target, item)
            self.assertEqual(proof['passed'], expected, proof)

    def test_initial_passive_defeat_guidance_keeps_the_verbatim_french_source(self):
        source, item, _ = self.initial_defeat_case()
        masked, anchors = guard._protect(source, _fixture(item))
        prompt = _prompt(masked, anchors)
        self.assertIn('suffered a defeat at "Hambourg"', prompt)
        self.assertIn('never a proper name or a subject defeating that opponent', prompt)
        self.assertEqual(prompt.rpartition('\n\n\n')[2].encode('utf-8'), source.encode('utf-8'))

    def loss_twice_case(self):
        source = "Mais la suite a été plus difficile pour les partenaires d'Edin Dzeko qui ont été accrochés par Elversberg (0-0) avant de perdre à 2 reprises, face à Fribourg (2-1) et à Mayence (0-1) le week-end dernier."
        target = "But the situation proved more difficult for Edin Dzeko's team, who drew with Elversberg (0-0) before losing twice, against Fribourg (2-1) and Mayence (0-1) last weekend."
        item = {'sport': {'key': 'football'}, 'teams': {'home': {'name': 'Cologne'}, 'away': {'name': 'Schalke 04'}}}
        return source, item, target

    def test_exact_native_two_losses_accepts_twice_without_changing_identity(self):
        # cdbfd4a7... native SHA265957a8..., source/result bytes unchanged.
        source, item, target = self.loss_twice_case()
        masked, anchors = guard._protect(source, _fixture(item))
        identity = json.dumps(anchors, ensure_ascii=False)
        prompt = _prompt(masked, anchors)
        _, proof = validate_english_sentence(source, target, item)
        self.assertTrue(proof['passed'], proof)
        self.assertTrue(proof['remasking_proof']['scoped_twice_loss_quantities'][0]['passed'])
        self.assertEqual(proof['remasking_proof']['source_token_order'], proof['remasking_proof']['accepted_token_order'])
        self.assertEqual(identity, json.dumps(anchors, ensure_ascii=False))
        self.assertEqual(prompt, _prompt(masked, anchors))
        self.assertFalse(any('_validation_loss_twice_scope' in a for a in proof['anchors']))

    def test_twice_is_only_two_affirmative_losses_in_the_source_result_group(self):
        source, item, target = self.loss_twice_case()
        for wrong in (target.replace('losing twice', 'losing once'),
                      target.replace('losing twice', 'losing three times'),
                      target.replace('losing twice', 'winning twice'),
                      target.replace('losing twice', 'not losing twice'),
                      target.replace('before losing twice', 'before they denied losing twice'),
                      target.replace('before losing twice', 'before allegedly losing twice'),
                      target.replace('losing twice,', 'losing twice and one victory,'),
                      target.replace('twice', 'twice twice'),
                      target.replace('Fribourg', 'Elversberg'),
                      target.replace('(2-1)', '(1-2)'),
                      target.replace('Mayence', 'Mainz'),
                      target.replace('last weekend', 'next weekend')):
            _, proof = validate_english_sentence(source, wrong, item)
            self.assertFalse(proof['passed'], (wrong, proof))
        for wrong_source in (source.replace('à 2 reprises', 'à 1 reprise'),
                             source.replace('à 2 reprises', 'à 3 reprises'),
                             source.replace('perdre', 'gagner'),
                             source.replace('perdre', 'ne pas perdre'),
                             'Ils ont nié cette affirmation : ' + source,
                             'Si cela était arrivé : ' + source):
            _, proof = validate_english_sentence(wrong_source, target, item)
            self.assertFalse(proof['passed'], (wrong_source, proof))

    def test_multi_match_continuation_never_becomes_the_rest_of_one_match(self):
        source, item, target = self.loss_twice_case()
        for phrase in ('the rest of the match', 'the remainder of the match', 'the rest of this match'):
            _, proof = validate_english_sentence(source, target.replace('the situation', phrase), item)
            self.assertFalse(proof['passed'])
            self.assertIn('multi_match_results_changed_to_remainder_of_one_match', proof['errors'])
        # The recognizer never bans a real source about one match in general.
        source_single = 'La suite du match a été difficile pour Elversberg.'
        masked, anchors = guard._protect(source_single, _fixture(item))
        self.assertEqual(guard._validation_loss_twice_scopes(masked, anchors, _fixture(item)), {})

    def test_exact_native_charrette_means_general_relegation_not_a_playoff_spot(self):
        source = 'Cette année encore, les locaux risquent de ne pas pouvoir jouer les premiers rôles et ils devraient sans doute veiller à rester hors de la charrette.'
        # 3f4766da... native SHA9d8a9e5d... is a real factual error.
        native = 'This year again, the locals risk not being able to play the leading roles and should likely aim to stay out of the relegation play-off spot.'
        item = {'sport': {'key': 'football'}, 'teams': {'home': {'name': 'Cologne'}, 'away': {'name': 'Schalke 04'}}}
        for phrase in ('stay clear of relegation', 'stay out of relegation', 'stay out of the relegation zone',
                       'stay clear of the relegation zone', 'avoid relegation'):
            target = native.replace('stay out of the relegation play-off spot', phrase)
            _, proof = validate_english_sentence(source, target, item)
            self.assertTrue(proof['passed'], (target, proof))
        for phrase in ('stay out of the relegation play-off spot', 'stay clear of relegation play-offs',
                       'avoid relegation and play-offs', 'reach the relegation zone', 'not avoid relegation',
                       'cannot avoid relegation', "can't avoid relegation", 'can’t avoid relegation',
                       "don't avoid relegation"):
            _, proof = validate_english_sentence(source, native.replace('stay out of the relegation play-off spot', phrase), item)
            self.assertFalse(proof['passed'], (phrase, proof))
        _, proof = validate_english_sentence(source, native.replace(
            'should likely aim to stay out of the relegation play-off spot', 'they cannot avoid relegation'), item)
        self.assertFalse(proof['passed'])

    def test_all_original_french_is_reconstructed_byte_for_byte_in_model_prompt(self):
        for row in self.rows:
            masked, anchors = guard._protect(row['source'], _fixture(self.item(row)))
            self.assertEqual(_prompt(masked, anchors).rpartition('\n\n\n')[2].encode('utf-8'), row['source'].encode('utf-8'))


if __name__ == '__main__':
    unittest.main()
