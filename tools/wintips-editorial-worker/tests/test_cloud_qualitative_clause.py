"""Grounded Turf purpose clause; authored English, no native model proof."""
import unittest
from editorial_worker import gemini_translation as g
from editorial_worker.translation import TranslationRejected


class QualitativeClauseTests(unittest.TestCase):
    def test_actual_public_cristabel_paragraph_has_canonical_purpose_without_first_place_claim(self):
        source = ('8 - CRISTABEL – Déjà troisième d’un Quinté+ en juillet après une belle fin de course, '
            'elle a confirmé sa compétitivité lors de ses sorties suivantes, notamment dans une Classe 2 à Craon. '
            'Sa valeur handicap de 37 semble lui laisser une belle carte à jouer à Saint-Cloud pour viser les premières places.')
        _, anchors = g.protect(source, {})
        clause = next(a for a in anchors if a['kind'] == 'qualitative')
        self.assertEqual(clause['source'], 'pour viser les premières places')
        self.assertEqual(clause['value'], 'in pursuit of the leading places')
        self.assertEqual([a['value'] for a in anchors if a['kind'] in {'number', 'written_number'}], ['8', '3rd', '2', '37'])
        def span(value):
            a = next(a for a in anchors if a['value'] == value)
            return '<span id="' + a['id'] + '" class="notranslate" translate="no">' + value + '</span>'
        candidate = ('<div>' + span('8') + ' - CRISTABEL – Already ' + span('3rd') +
            ' in a Quinté+ in July after a strong finish, she confirmed her competitiveness in her following starts, '
            'notably in a Classe ' + span('2') + ' at Craon. Her handicap mark of ' + span('37') +
            ' seems to leave her with a good chance at Saint-Cloud ' + span(clause['value']) + '.</div>')
        target, proof = g._validated(source, {}, candidate)
        self.assertTrue(proof['passed']); self.assertIn(clause['value'], target)
        purpose = span(clause['value'])
        for bad in (candidate.replace(purpose, ''), candidate.replace(purpose, purpose * 2),
                candidate.replace(clause['value'], 'in pursuit of first place'),
                candidate.replace('>37<', '>38<'), candidate.replace(purpose, purpose + ' 1')):
            with self.assertRaises(TranslationRejected): g._validated(source, {}, bad)

    def test_case_and_spacing_are_closed_but_unrelated_clauses_are_not_rewritten(self):
        for source in ('pour viser les premières places', 'Pour viser les premières places', 'POUR VISER LES PREMIÈRES PLACES',
                'pour  viser les premières places'):
            self.assertEqual([a['value'] for a in g.protect(source, {})[1]], ['in pursuit of the leading places'])
        for source in ('pour viser la première place', 'pour viser les premières placesx', 'sans viser les premières places'):
            self.assertFalse(any(a['kind'] == 'qualitative' for a in g.protect(source, {})[1]))


if __name__ == '__main__': unittest.main()
