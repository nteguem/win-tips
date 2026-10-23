"""Whole percentage value/unit regression from the native NBA24 V2 preview."""
import unittest

from editorial_worker.translation import validate_english_sentence


SOURCE = ('Avec 52 % de réussite au tir, les Pacers ont fait preuve d’une efficacité redoutable pour finalement '
          's’imposer sur le fil (123-120), laissant New Orleans avec de sérieux regrets.')
NATIVE_CANDIDATES = (
    'With 52% shooting, the Pacers displayed a fearsome efficiency to narrowly win the game (123-120), leaving New Orleans with serious regrets.',
    'With 52% shooting accuracy, the Pacers demonstrated formidable effectiveness, ultimately winning narrowly (123-120), leaving New Orleans with significant regrets.',
    'With 52% shooting accuracy, the Pacers demonstrated formidable effectiveness, ultimately winning narrowly (123-120), leaving New Orleans with serious regrets.',
)


class PercentageFactsTests(unittest.TestCase):
    def item(self):
        return {'sport': {'key': 'basketball'}, 'editionDate': '2026-10-24',
                'teams': {'home': {'name': 'Utah Jazz'}, 'away': {'name': 'New Orleans Pelicans'}}}

    def check(self, source, target, expected=True):
        _, proof = validate_english_sentence(source, target, self.item())
        self.assertEqual(proof['passed'], expected, proof)
        return proof

    def test_all_three_actual_v2_responses_preserve_percentage_and_winner(self):
        for target in NATIVE_CANDIDATES:
            proof = self.check(SOURCE, target)
            percentage = next(s for s in proof['remasking_proof']['spans'] if s['target'] == '52 %')
            self.assertEqual(percentage['rule'], 'same_percentage_value_and_unit')
            self.assertEqual(percentage['raw'], '52%')

    def test_whitespace_and_written_percentage_units_preserve_the_whole_quantity(self):
        for source in ('52%', '52 %', '52\u00a0%', '52\u202f%'):
            for target in ('52%', '52 %', '52\u00a0%', '52\u202f%', '52 percent', '52 per cent'):
                self.check('Ils ont ' + source + ' de réussite.', 'They have ' + target + ' accuracy.')

    def test_decimal_separators_and_redundant_zeroes_keep_exact_value(self):
        for source, target in [('11,1 %', '11.1%'), ('11,10 %', '11.1 percent'), ('52 %', '52.00%'),
                               ('052,000 %', '52 percent'), ('0,05 %', '0.05 percent'),
                               ('12345678901234567890,123456789 %', '12345678901234567890.123456789%')]:
            self.check('Ils ont ' + source + ' de réussite.', 'They have ' + target + ' accuracy.')

    def test_changed_percentage_sign_precision_or_unit_never_satisfies_source_atom(self):
        source = 'Ils ont 52 % de réussite.'
        for bad in ('53%', '152%', '52.1%', '5.2%', '0.52%', '-52%', '+52%', '−52%', '52,000%', '0,052%',
                    '52', '52 points', '52 goals', '52/100', '52:100', '52 per mille', '52 euros',
                    '52% percent', '52 percent%', '52 percent percent', 'percent 52%',
                    '52% points', '52 percent points', '52% percentage points', '52% basis points',
                    '52% / 100', '52 percent divided by 100', 'negative 52%', 'minus 52%',
                    'fifty-two', '52%%', '52% and 52%', '52 percent and 52 percent'):
            self.check(source, 'They have ' + bad + ' accuracy.', False)

    def test_source_sign_and_decimal_precision_are_exact_without_floating_point(self):
        self.check('Ils ont -11,1 % de réussite.', 'They have -11.1 percent accuracy.')
        self.check('Ils ont +11,1 % de réussite.', 'They have +11.1% accuracy.')
        self.check('Ils ont −52 % de réussite.', 'They have -52% accuracy.')
        self.check('Ils ont −52 % de réussite.', 'They have −52 percent accuracy.')
        self.check('Ils ont −52,5 % de réussite.', 'They have -52.5% accuracy.')
        for source, target in [('-11,1 %', '11.1%'), ('+11,1 %', '11.1%'),
                               ('−52 %', '52%'), ('−52 %', '+52%'), ('−52,5 %', '-52,5%'),
                               ('11,1 %', '11.2%'), ('0,05 %', '0.5%'),
                               ('12345678901234567890,123456789 %', '12345678901234567890.123456788%')]:
            self.check('Ils ont ' + source + ' de réussite.', 'They have ' + target + ' accuracy.', False)

    def test_bare_number_cannot_acquire_percentage_unit_and_score_actor_still_matter(self):
        self.check('Ils ont 52 points.', 'They have 52% points.', False)
        self.check(SOURCE, NATIVE_CANDIDATES[0].replace('123-120', '120-123'), False)
        self.check(SOURCE, NATIVE_CANDIDATES[0].replace('Pacers', 'Lakers'), False)
        self.check(SOURCE, NATIVE_CANDIDATES[0].replace('win', 'lose'), False)
        self.check('Ils ont 52 % puis 42 % de réussite.', 'They have 52 percent then 42% accuracy.')
        self.check('Ils ont 52 % puis 42 % de réussite.', 'They have 42 percent then 52% accuracy.', False)

    def test_winning_gerund_is_bound_to_the_source_infinitive_not_completed_results(self):
        for apostrophe in ("'", '’'):
            source = SOURCE.replace('s’imposer', 's' + apostrophe + 'imposer')
            self.check(source, NATIVE_CANDIDATES[1])
            self.check(source, NATIVE_CANDIDATES[1].replace('winning', 'losing'), False)
        self.check('Ils comptent trois victoires.', 'They count three winning.', False)
        self.check('Ils ont gagné.', 'They are winning.', False)


if __name__ == '__main__':
    unittest.main()
