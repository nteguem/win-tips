"""Regressions from the real 24 October NBA cold preview; no model or cache replay."""
import unittest

from editorial_worker.translation import _fixture, _prompt, validate_english_sentence
from editorial_worker.vendor import rdj_translation as guard


SOURCE = ('Offensivement bien en place, comme à leur habitude, les hommes de Louisiane semblaient avoir fait '
          'le plus dur en abordant le quatrième quart-temps avec neuf points d’avance.')
QWEN_BASE = ('Offensively well positioned, as they usually are, the men of Louisiane seemed to have done '
             'the hardest part by entering the fourth quarter with nine points ahead.')
QWEN_RETRY = ('Offensively well positioned, as they usually are, the men from Louisiane seemed to have done '
              'the hard part by entering the fourth quarter with a nine-point lead.')
GEMMA_WRONG = ('Despite being in a strong position, the team from Louisiane appeared to have secured the win '
               'as they entered the fourth quarter with a nine-point lead, as they had done in the past.')
EXPECTATION_SOURCE = ('Attendu au tournant lors de son déplacement dans le Tennessee pour y défier les Memphis '
                      'Grizzlies, Salt Lake City a toutefois éprouvé de grandes difficultés à trouver de la cohérence dans son jeu.')
EXPECTATION_WRONG = ('Facing a turnaround in its game plan during its visit to Tennessee to challenge the Memphis '
                     'Grizzlies, Salt Lake City, however, experienced significant difficulties in finding consistency in its play.')


class SportingAdverbQuarterTests(unittest.TestCase):
    def item(self, sport='basketball'):
        return {'sport': {'key': sport}, 'editionDate': '2026-10-24',
                'teams': {'home': {'name': 'Utah Jazz'}, 'away': {'name': 'New Orleans Pelicans'}}}

    def check(self, source, target, expected=True, item=None):
        _, proof = validate_english_sentence(source, target, item or self.item())
        self.assertEqual(proof['passed'], expected, proof)
        return proof

    def test_real_cold_qwen_answers_keep_offensive_meaning_and_fourth_quarter(self):
        for candidate in (QWEN_BASE, QWEN_RETRY):
            proof = self.check(SOURCE, candidate)
            self.assertEqual(next(a for a in proof['anchors'] if a['source'] == 'Offensivement')['kind'], 'semantic')
            quarter = next(a for a in proof['anchors'] if a['kind'] == 'quarter_ordinal')
            self.assertEqual(quarter['source'], 'quatrième quart-temps')
            self.assertEqual(quarter['target'], 'fourth quarter')
        self.check(SOURCE, GEMMA_WRONG, False)

    def test_real_cold_mutations_still_fail_without_relaxing_names_counts_or_periods(self):
        for bad in (QWEN_RETRY.replace('Offensively', 'Defensively'),
                    QWEN_RETRY.replace('Louisiane', 'Indiana'),
                    QWEN_RETRY.replace('nine-point', 'eight-point'),
                    QWEN_RETRY.replace('fourth quarter', 'third quarter'),
                    QWEN_RETRY.replace('fourth quarter', 'fifth quarter'),
                    QWEN_RETRY.replace('fourth quarter', 'fourth half'),
                    QWEN_RETRY.replace('fourth quarter', 'fourth'),
                    QWEN_RETRY.replace('fourth quarter', 'one quarter'),
                    QWEN_RETRY.replace('fourth quarter', 'fourth quarter and a half')):
            self.check(SOURCE, bad, False)

    def test_finite_initial_adverbs_are_translated_only_in_descriptive_sport_context(self):
        for source, target in guard.SPORTING_ADVERBIAL_OPENERS.items():
            source = source.capitalize() + ' solides, ils ont gagné.'
            proof = self.check(source, target.capitalize() + ' solid, they won.')
            self.assertEqual(proof['anchors'][0]['kind'], 'semantic')
        masked, anchors = guard._protect('Offensivement bien en place.', {'sport': 'unknown'})
        self.assertEqual(anchors[0]['kind'], 'name')
        masked, anchors = guard._protect('Offensivement Paris gagne.', _fixture(self.item()))
        self.assertFalse(any(a['kind'] == 'semantic' and a['target'] == 'offensively' for a in anchors))

    def test_explicit_proper_names_and_unrelated_capitalised_names_remain_names(self):
        for field in ('home', 'away'):
            item = self.item()
            item['teams'][field]['name'] = 'Offensivement'
            proof = self.check('Offensivement gagne.', 'Offensivement wins.', item=item)
            self.assertTrue(any(a['source'] == 'Offensivement' and a['kind'] == 'name' for a in proof['anchors']))
            self.check('Offensivement gagne.', 'Offensively wins.', False, item)
        fixture = _fixture(self.item())
        fixture['protected_names'].append('Offensivement')
        _, anchors = guard._protect('Offensivement gagne.', fixture)
        self.assertEqual(anchors[0]['kind'], 'name')
        named = self.item()
        named['teams']['home']['name'] = 'Offensivement bien'
        proof = self.check('Offensivement bien gagne.', 'Offensivement bien wins.', item=named)
        self.assertTrue(any(a['source'] == 'Offensivement bien' and a['kind'] == 'name' for a in proof['anchors']))
        self.check('Offensivement bien gagne.', 'Offensively well wins.', False, named)
        fixture = _fixture(self.item())
        fixture['protected_names'].append('Offensivement bien')
        _, anchors = guard._protect('Offensivement bien gagne.', fixture)
        self.assertEqual(anchors[0]['source'], 'Offensivement bien')
        self.assertEqual(anchors[0]['kind'], 'name')
        proof = self.check('Clément gagne.', 'Clément wins.')
        self.assertEqual(proof['anchors'][0]['kind'], 'name')
        self.check('Clément gagne.', 'Clement wins.', False)

    def test_written_and_digit_ordinals_share_only_the_same_quarter_value(self):
        for source_ordinal, target_ordinal in [('premier', 'first'), ('deuxième', 'second'),
                                               ('troisième', 'third'), ('quatrième', 'fourth'), ('4e', '4th'), ('4ème', '4th')]:
            source = 'Ils entrent dans le ' + source_ordinal + ' quart-temps.'
            self.check(source, 'They enter the ' + target_ordinal + ' quarter.')
            self.check(source, 'They enter the fifth quarter.', False)
        self.check('Ils entrent dans le quatrième quart-temps.', 'They enter the 4th quarter.')
        self.check('Ils jouent trois quarts-temps.', 'They play three quarters.')
        self.check('Ils jouent trois quarts-temps.', 'They play the third quarter.', False)

    def test_quarter_rule_is_not_a_fraction_or_a_volleyball_set_rule(self):
        source = 'Ils entrent dans le quatrième quart-temps.'
        for bad in ['They enter a quarter.', 'They enter 1/4.', 'They enter the fourth quarter of one.',
                    'They enter the fourth quarter and one half.']:
            self.check(source, bad, False)
        for sport in ('football', 'volleyball', 'tennis'):
            _, anchors = guard._protect(source, _fixture(self.item(sport)))
            self.assertFalse(any(a['kind'] == 'quarter_ordinal' for a in anchors))
        self.check('Ils gagnent le quatrième set.', 'They win the fourth set.', item=self.item('volleyball'))
        self.check('Ils gagnent le quatrième set.', 'They win the third set.', False, self.item('volleyball'))

    def test_sentence_initial_quarter_does_not_change_lookup_value_when_capitalised(self):
        for ordinal in ('Quatrième', '4e'):
            source = ordinal + ' quart-temps, ils ont neuf points d’avance.'
            self.check(source, 'Fourth quarter, they have a nine-point lead.')
            self.check(source, 'Third quarter, they have a nine-point lead.', False)

    def test_expectation_idiom_rejects_the_real_tactical_invention(self):
        self.check(EXPECTATION_SOURCE, EXPECTATION_WRONG, False)
        for idiom in ('Under scrutiny', 'Facing high expectations', 'Expected to deliver'):
            target = EXPECTATION_WRONG.replace('Facing a turnaround in its game plan', idiom)
            self.check(EXPECTATION_SOURCE, target)
            self.check(EXPECTATION_SOURCE, target.replace('Salt Lake City', 'Los Angeles'), False)
            self.check(EXPECTATION_SOURCE, target.replace('Tennessee', 'Texas'), False)
        for source_idiom in ('Attendu', 'Attendue', 'Attendus', 'Attendues'):
            source = source_idiom + ' au tournant, ils ont gagné.'
            self.check(source, 'Under scrutiny, they won.')
            self.check(source, 'Facing a tactical turnaround, they won.', False)

    def test_prompt_keeps_french_bytes_and_does_not_instruct_the_model_to_preserve_an_adverb_as_a_name(self):
        for source in (SOURCE, EXPECTATION_SOURCE):
            masked, anchors = guard._protect(source, _fixture(self.item()))
            prompt = _prompt(masked, anchors)
            self.assertEqual(prompt.rpartition('\n\n\n')[2], source)
            self.assertFalse(any(a['kind'] == 'name' and a['source'] in ('Offensivement', 'Attendu') for a in anchors))
        self.assertIn('under scrutiny', prompt)


if __name__ == '__main__':
    unittest.main()
