"""Closed source frames; authored synthetic English is not native evidence."""
from html import escape
import json
from pathlib import Path
import unittest
from editorial_worker import gemini_translation as g
from editorial_worker.translation import TranslationRejected


class SportingFramesTests(unittest.TestCase):
    def test_three_actual_public_paragraphs_have_exact_source_bound_frames(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/sporting-frames-public-20261025.json').read_bytes())
        expected = {'5802970': ('premières journées', 'first matchdays'),
            '5802971': ('premier non relégable', 'first team outside the relegation zone'),
            '5802964': ('de retour au premier plan', 'back at the forefront')}
        for item in fixture['items']:
            html, anchors = g.protect(item['source'], item['item'])
            source, target = expected[item['sourceId']]
            self.assertEqual([(a['source'], a['value']) for a in anchors if a['kind'] == 'qualitative'], [(source, target)])
            restored = html
            for anchor in anchors:
                span = '<span id="' + anchor['id'] + '" class="notranslate" translate="no">' + escape(anchor['value']) + '</span>'
                restored = restored.replace(span, escape(anchor['source']))
            self.assertEqual(restored, '<div>' + escape(item['source']) + '</div>')

    def test_canonical_frames_keep_counts_and_reject_every_protected_mutation(self):
        cases = [
            ('Lors des premières journées, Strasbourg reste 14e.', 'During the ', ', Strasbourg remains ', '.'),
            ('Troyes compte trois points de retard sur le premier non-relégable.', 'Troyes are ', ' points behind the ', '.'),
            ('Lorient est de retour au premier plan avec trois points.', 'Lorient is ', ' with ', ' points.'),
        ]
        for source, before, between, after in cases:
            _, anchors = g.protect(source, {})
            spans = ['<span id="' + a['id'] + '" class="notranslate" translate="no">' + escape(a['value']) + '</span>' for a in anchors]
            self.assertEqual(len(spans), 2)
            candidate = '<div>' + before + spans[0] + between + spans[1] + after + '</div>'
            self.assertTrue(g._validated(source, {}, candidate)[1]['passed'])
            qualitative = next(i for i, a in enumerate(anchors) if a['kind'] == 'qualitative')
            for bad in (candidate.replace(spans[qualitative], ''), candidate.replace(spans[qualitative], spans[qualitative] * 2),
                    candidate.replace(escape(anchors[qualitative]['value']), 'changed sporting claim'),
                    candidate.replace('</div>', ' 1</div>')):
                with self.assertRaises(TranslationRejected): g._validated(source, {}, bad)

    def test_unrelated_ordinals_and_verified_names_are_not_rewritten(self):
        for source in ('premier plan', 'première journée', 'de retour au deuxième plan', 'second non-relégable'):
            self.assertFalse(any(a['kind'] == 'qualitative' for a in g.protect(source, {})[1]))
        for source in ('premières journées', 'premier non-relégable', 'de retour au premier plan'):
            item = {'teams': {'home': {'name': source}, 'away': {'name': 'Opponent'}}}
            self.assertEqual([a['kind'] for a in g.protect(source, item)[1]], ['verified_name'])

    def test_public_troyes_relative_defence_rank_is_preserved_without_inventing_two(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/sporting-frames-public-20261025.json').read_bytes())
        public = next(i for i in fixture['items'] if i['sourceId'] == '5802971')
        _, actual_anchors = g.protect(public['source'], public['item'])
        relative = next(a for a in actual_anchors if a['kind'] == 'relative_rank')
        self.assertEqual(relative['source'], 'Avant-dernière défense')
        self.assertEqual(relative['value'], 'next-to-last defence')
        self.assertTrue(all(a['value'] != '2' for a in actual_anchors))
        source = "Avant-dernière défense de l'élite (16 buts encaissés en 7 matchs)."
        _, anchors = g.protect(source, {})
        def span(value):
            a = next(a for a in anchors if a['value'] == value)
            return '<span id="' + a['id'] + '" class="notranslate" translate="no">' + value + '</span>'
        rank = span('next-to-last defence')
        candidate = '<div>The ' + rank + ' in the top flight (' + span('16') + ' goals conceded in ' + span('7') + ' matches).</div>'
        self.assertTrue(g._validated(source, {}, candidate)[1]['passed'])
        for bad in (candidate.replace('next-to-last defence', 'worst defence'),
                candidate.replace('next-to-last defence', 'second-worst defence'),
                candidate.replace('>16<', '>15<'), candidate.replace('>7<', '>8<'),
                candidate.replace(rank, ''), candidate.replace(rank, rank * 2),
                candidate.replace('</div>', ' 2</div>')):
            with self.assertRaises(TranslationRejected): g._validated(source, {}, bad)


if __name__ == '__main__': unittest.main()
