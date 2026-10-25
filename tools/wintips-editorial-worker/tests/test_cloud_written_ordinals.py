"""Public French input and authored English fixtures; no native quality claim."""
import json
from pathlib import Path
import unittest
from editorial_worker import gemini_translation as g
from editorial_worker.translation import TranslationRejected


class WrittenOrdinalTests(unittest.TestCase):
    def test_closed_nonambiguous_ordinals_plural_and_compounds_are_protected(self):
        for word, value in g.protect.__globals__['WRITTEN_ORDINALS'].items():
            for spelling in (word, word.upper(), word + 's'):
                _, anchors = g.protect('Le ' + spelling + ' match.', {})
                self.assertEqual([(a['source'], a['value']) for a in anchors], [(spelling, value)])
        for prose in ('La seconde partie de tableau.', 'Le premier plan.', 'Une seconde de jeu.'):
            self.assertEqual(g.protect(prose, {})[1], [])

    def test_actual_public_toulouse_fourth_match_is_anchored_and_added_or_mutated_counts_rejected(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/gemini-written-ordinal-public-20261025.json').read_bytes())
        source, item = fixture['source'], fixture['item']
        html, anchors = g.protect(source, item)
        ordinal = next(a for a in anchors if a['source'] == 'quatrième')
        self.assertEqual(ordinal['value'], '4th')
        def span(source_value):
            a = next(a for a in anchors if a['source'] == source_value)
            return '<span id="' + a['id'] + '" class="notranslate" translate="no">' + a['value'] + '</span>'
        scores = [a for a in anchors if a['source'] == '2-2']
        def tag(a): return '<span id="' + a['id'] + '" class="notranslate" translate="no">' + a['value'] + '</span>'
        candidate = ('<div>' + span('Toulouse') + ' did not have to work hard to bring back ' + span('une') +
            ' win at Le Mans (' + span('0-3') + ') last week. By thrashing the promoted side, TFC recorded its first clean sheet of the season and a ' +
            span('quatrième') + ' consecutive unbeaten match. Previously, Jens Berthel Askou\'s players beat Le Havre (' + span('3-2') +
            ') and came back from ' + span('deux') + ' goals down at Lorient (' + tag(scores[0]) + ') and at leaders Monaco (' +
            tag(scores[1]) + '). Despite this good run, the club remains in the lower half of the table (' + span('12e') + ').</div>')
        target, proof = g._validated(source, item, candidate)
        self.assertTrue(proof['passed']); self.assertIn('4th consecutive unbeaten match', target)
        ordinal_span = span('quatrième')
        for bad in (candidate.replace(ordinal_span, ordinal_span + ' four'), candidate.replace(ordinal_span, ordinal_span + ' 4'),
                candidate.replace('>4th<', '>5th<'), candidate.replace(ordinal_span, ''), candidate.replace(ordinal_span, ordinal_span * 2)):
            with self.assertRaises(TranslationRejected): g._validated(source, item, bad)
        self.assertIn('un quatrième match', source)


if __name__ == '__main__': unittest.main()
