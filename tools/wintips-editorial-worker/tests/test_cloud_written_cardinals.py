"""Source protection regressions; annotated positive HTML is a test double."""
from html import escape
import json
from pathlib import Path
import re
import unittest

from editorial_worker.azure_translation import CARDINALS, protect, validate_output
from editorial_worker.translation import TranslationRejected


class CloudWrittenCardinalsTests(unittest.TestCase):
    def test_unambiguous_cardinals_do_not_depend_on_a_unit_dictionary(self):
        for french, english in CARDINALS.items():
            if english in {'zero', 'nine'}:
                continue
            for suffix in (' revers', ' succès', ' obstacles', ' tentatives', ''):
                with self.subTest(french=french, suffix=suffix):
                    html, anchors = protect(french + suffix, {})
                    self.assertEqual([a['value'] for a in anchors], [english])
                    translated = '<div>They recorded ' + re.search(r'<span[^>]*>.*?</span>', html)[0] + ' results.</div>'
                    self.assertTrue(validate_output(french + suffix, {}, translated)[1]['passed'])

    def test_nominal_standings_rank_is_one_complete_top_rank(self):
        for count, expected in (('six', 'top six'), ('6', 'top 6'), ('trois', 'top three')):
            source = 'Distancée par les ' + count + ' premiers du classement.'
            html, anchors = protect(source, {})
            self.assertEqual([(a['kind'], a['value']) for a in anchors], [('rank_number', expected)])
            for wrong in (expected.removeprefix('top '), expected.replace('top', 'last'), 'top five', '1st'):
                with self.subTest(wrong=wrong), self.assertRaises(TranslationRejected):
                    validate_output(source, {}, html.replace('>' + expected + '<', '>' + wrong + '<'))
        for source in ('les six premiers chapitres', 'par les six premiers du roman',
                'les six premières journées', 'six premiers voisins'):
            self.assertFalse(any(a['kind'] == 'rank_number' for a in protect(source, {})[1]))

    def test_articles_new_adjective_names_and_word_boundaries_are_preserved(self):
        for source in ('un effectif neuf', 'une équipe neuve', 'neuf voisins', 'un revers',
                'troisième', 'deuxième', 'trois-quarts'):
            self.assertEqual(protect(source, {})[1], [], source)
        self.assertEqual([a['value'] for a in protect('neuf matchs', {})[1]], ['nine'])
        self.assertEqual([a['value'] for a in protect('un seul point', {})[1]], ['one'])
        for home, away in (('Les Trois Rois', 'Les Deux Rives'), ('Neuf', 'Les Quatre Vents')):
            item = {'teams': {'home': {'name': home}, 'away': {'name': away}}}
            _, anchors = protect(home + ' face à ' + away + '.', item)
            self.assertEqual([a['kind'] for a in anchors], ['verified_name'] * 2)
            self.assertEqual([a['source'] for a in anchors], [home, away])
        self.assertEqual([a['value'] for a in protect('dix-sept succès', {})[1]], ['seventeen'])

    def test_wrong_added_missing_repeated_quantity_and_score_are_rejected(self):
        source = 'Trois revers après deux succès (3-1).'
        html, _ = protect(source, {})
        for wrong in (html.replace('>three<', '>two<'), html.replace('>two<', '>three<'),
                html.replace('>3-1<', '>1-3<'), html.replace('</div>', ' three</div>'),
                html.replace('</div>', ' four successes</div>'),
                re.sub(r'<span[^>]*>three</span>', '', html)):
            with self.subTest(wrong=wrong), self.assertRaises(TranslationRejected):
                validate_output(source, {}, wrong)

    def test_exact_native_false_rejection_is_reproduced_without_rewriting_native(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/gemini-written-cardinals-20261025.json').read_bytes())
        source, item = fixture['source'], fixture['item']
        html, anchors = protect(source, item)
        self.assertEqual(anchors[0]['source'], 'six premiers')
        self.assertEqual(anchors[0]['value'], 'top six')
        self.assertIn(('trois', 'three'), [(a['source'], a['value']) for a in anchors])
        self.assertIn('trois revers', source)
        with self.assertRaises(TranslationRejected):
            validate_output(source, item, fixture['nativeHtml'])
        # New anchors require a genuinely new model response in production. This
        # explicitly annotated fake proves only the validator's new contract.
        by_value = {a['value']: a for a in anchors}
        def span(value):
            a = by_value[value]
            return '<span id="' + a['id'] + '" class="notranslate" translate="no">' + escape(value) + '</span>'
        annotated = re.sub(r'<span[^>]*>([^<]+)</span>', lambda m: span(m[1]), fixture['nativeHtml'])
        annotated = annotated.replace('top six', span('top six')).replace('three successive', span('three') + ' successive')
        target, proof = validate_output(source, item, annotated)
        self.assertTrue(proof['passed'])
        self.assertFalse(proof['semanticQualityProven'])
        self.assertIn('top six', target)
        self.assertIn('three successive defeats', target)


if __name__ == '__main__': unittest.main()
