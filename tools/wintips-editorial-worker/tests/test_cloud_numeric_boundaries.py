"""Immutable numerical facts exclude surrounding prose whitespace."""
from html import escape
import json
from pathlib import Path
import unittest
from editorial_worker import gemini_translation as g
from editorial_worker.translation import TranslationRejected


class NumericBoundaryTests(unittest.TestCase):
    def test_actual_public_rennes_and_lorient_preserve_prose_and_canonicalize_only_fact_tokens(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/numeric-boundary-public-rennes-lorient-20261025.json').read_bytes())
        self.assertEqual({i['sourceId'] for i in fixture['items']}, {'5802970', '5802964'})
        for item in fixture['items']:
            html, anchors = g.protect(item['source'], item['item'])
            for anchor in anchors:
                self.assertEqual(item['source'][anchor['start']:anchor['end']], anchor['source'])
                if anchor['kind'] == 'number':
                    self.assertEqual(anchor['source'], anchor['source'].strip())
                    self.assertEqual(anchor['value'], anchor['value'].strip())
            # Reinsert the exact original facts to prove all other source bytes,
            # including punctuation and whitespace, remain in their positions.
            restored = html
            for anchor in anchors:
                span = '<span id="' + anchor['id'] + '" class="notranslate" translate="no">' + escape(anchor['value']) + '</span>'
                restored = restored.replace(span, escape(anchor['source']))
            self.assertEqual(restored, '<div>' + escape(item['source']) + '</div>')
            if item['sourceId'] == '5802970':
                seventh = next(a for a in anchors if a['source'] == '7es')
                self.assertEqual(seventh['value'], '7th')
                self.assertEqual(item['source'][seventh['start'] - 1], ' ')
            else:
                self.assertEqual(len([a for a in anchors if a['source'] == '2']), 2)

    def test_mutations_missing_duplicate_and_added_numbers_remain_rejected(self):
        source = 'Classement. 7es après un nul (2, 2 défaites).'
        html, anchors = g.protect(source, {})
        candidate = html.replace('Classement.', 'Standings.').replace(' après ', ' after ').replace(' nul ', ' draw ').replace('défaites', 'defeats')
        target, proof = g._validated(source, {}, candidate)
        self.assertTrue(proof['passed']); self.assertIn('7th', target)
        ordinal = next(a for a in anchors if a['source'] == '7es')
        span = '<span id="' + ordinal['id'] + '" class="notranslate" translate="no">7th</span>'
        for bad in (candidate.replace('>7th<', '>8th<'), candidate.replace('>7th<', '> 7th<'),
                candidate.replace(span, ''), candidate.replace(span, span * 2), candidate.replace('</div>', ' 7</div>')):
            with self.assertRaises(TranslationRejected): g._validated(source, {}, bad)

    def test_signed_internal_spacing_dates_scores_and_units_are_preserved(self):
        source = 'Bilan. - 3 points, + 4 unités, 0-3, 52%, 1,50 et 21h00.'
        _, anchors = g.protect(source, {})
        self.assertEqual([a['value'] for a in anchors], ['- 3', '+ 4', '0-3', '52%', '1.50', '21h00'])


if __name__ == '__main__': unittest.main()
