"""Native source regression + explicitly scripted new-span transport fixtures."""
from html import escape
import json
from pathlib import Path
import re
import unittest

from editorial_worker.azure_translation import protect, validate_output
from editorial_worker.translation import TranslationRejected


class CloudQuantityUnitsTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads((Path(__file__).parent / 'fixtures/gemini-turf-quantities-20261024.json').read_bytes())
        self.source, self.item = self.fixture['source'], self.fixture['item']

    def annotated_transport_fixture(self):
        # This annotation is a test double, not a new native translation. The
        # original nativeHtml stays immutable and remains invalid for new anchors.
        html = self.fixture['nativeHtml']
        _, anchors = protect(self.source, self.item)
        for anchor in anchors:
            if anchor['kind'] not in {'written_number', 'rank_number'}: continue
            span = '<span id="' + anchor['id'] + '" class="notranslate" translate="no">' + escape(anchor['value']) + '</span>'
            html, count = re.subn(r'(?<!\w)' + re.escape(anchor['value']) + r'(?!\w)', lambda _: span, html)
            self.assertEqual(count, 1)
        return html

    def test_native_source_now_protects_nine_podiums_twelve_starts_top_five(self):
        protected, anchors = protect(self.source, self.item)
        quantities = {anchor['source']: anchor['value'] for anchor in anchors if anchor['kind'] == 'written_number'}
        self.assertEqual(quantities, {'neuf': 'nine', 'douze': 'twelve'})
        self.assertEqual({anchor['source']: anchor['value'] for anchor in anchors
            if anchor['kind'] == 'rank_number'}, {'cinq premiers': 'top five'})
        self.assertIn('>7</span>', protected)
        with self.assertRaises(TranslationRejected):
            validate_output(self.source, self.item, self.fixture['nativeHtml'])
        target, proof = validate_output(self.source, self.item, self.annotated_transport_fixture())
        self.assertIn('nine podiums in twelve starts', target)
        self.assertIn('top five', target)
        self.assertIs(proof['semanticQualityProven'], False)

    def test_changed_missing_or_added_quantity_and_oriented_score_still_rejected(self):
        good = self.annotated_transport_fixture()
        for bad in (good.replace('>nine<', '>ten<'), good.replace('>twelve<', '>eleven<'),
                good.replace('>top five<', '>top six<'), good.replace('>top five<', '>five<'),
                good.replace('>top five<', '>first five<'), good.replace('>7<', '>8<'),
                good.replace('</div>', ' two wins</div>'),
                good.replace('>nine</span>', '>nine</span> nine')):
            with self.subTest(html=bad), self.assertRaises(TranslationRejected):
                validate_output(self.source, self.item, bad)
        source = self.source + ' (3-1).'
        _, anchors = protect(source, self.item)
        score = next(anchor for anchor in anchors if anchor['value'] == '3-1')
        span = '<span id="' + score['id'] + '" class="notranslate" translate="no">3-1</span>'
        html = good.replace('</div>', ' (' + span + ').</div>')
        self.assertTrue(validate_output(source, self.item, html)[1]['passed'])
        with self.assertRaises(TranslationRejected):
            validate_output(source, self.item, html.replace('>3-1<', '>1-3<'))

    def test_ranks_require_bounded_context_and_adjectival_neuf_stays_unprotected(self):
        for source in ('terminer dans les cinq premiers du Quinté+', 'figurer parmi les cinq premières'):
            self.assertEqual([anchor['value'] for anchor in protect(source, {})[1]], ['top five'])
        for source in ('un effectif neuf', 'un effectif tout neuf', 'un vêtement neuf', 'neuf premiers voisins'):
            self.assertEqual(protect(source, {})[1], [], source)
        source = 'Un effectif neuf.'
        html, anchors = protect(source, {})
        self.assertEqual(anchors, [])
        self.assertTrue(validate_output(source, {}, '<div>A new squad.</div>')[1]['passed'])
        with self.assertRaises(TranslationRejected):
            validate_output(source, {}, '<div>A squad of nine players.</div>')

    def test_explicit_hippic_unit_nouns_protect_quantity_only(self):
        for unit in ('podiums', 'sorties', 'courses', 'départs', 'participations', 'accessits', 'places'):
            self.assertEqual([anchor['value'] for anchor in protect('neuf ' + unit, {})[1]], ['nine'])

    def test_entire_finishing_rank_preserved_for_digits_and_written_counts(self):
        for source, expected in (('terminer dans les cinq premiers du Quinté+', 'top five'),
                ('finir parmi les 5 premiers.', 'top 5'),
                ('figurer dans les trois premières à l’arrivée', 'top three')):
            protected, anchors = protect(source, {})
            self.assertEqual(len(anchors), 1)
            self.assertEqual(anchors[0]['kind'], 'rank_number')
            self.assertEqual(anchors[0]['value'], expected)
            self.assertTrue(validate_output(source, {}, protected)[1]['passed'])
            for bad in (expected.removeprefix('top '), expected.replace('top', 'last'),
                    expected.replace('five', 'six').replace('three', 'two').replace('5', '6')):
                with self.subTest(source=source, bad=bad), self.assertRaises(TranslationRejected):
                    validate_output(source, {}, protected.replace('>' + expected + '<', '>' + bad + '<'))

    def test_chronological_first_matches_are_not_finishing_ranks(self):
        for source in ('dans les cinq premiers matchs', 'dans les cinq premières courses'):
            anchors = protect(source, {})[1]
            self.assertEqual([anchor['value'] for anchor in anchors], ['five'])
            self.assertFalse(any(anchor['kind'] == 'rank_number' for anchor in anchors))

    def test_plural_ordinals_preserve_exact_rank_and_wrong_rank_is_rejected(self):
        for source, expected in (('8èmes', '8th'), ('19èmes', '19th'), ('8emes', '8th'),
                ('1ers', '1st'), ('2es', '2nd'), ('3èmes', '3rd'), ('11èmes', '11th'),
                ('12èmes', '12th'), ('13èmes', '13th'), ('21èmes', '21st')):
            protected, anchors = protect(source, {})
            self.assertEqual([anchor['value'] for anchor in anchors], [expected], source)
            self.assertTrue(validate_output(source, {}, protected)[1]['passed'])
            with self.assertRaises(TranslationRejected):
                validate_output(source, {}, protected.replace('>' + expected + '<', '>7th<'))


if __name__ == '__main__': unittest.main()
