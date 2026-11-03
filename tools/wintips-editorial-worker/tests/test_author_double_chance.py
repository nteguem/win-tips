"""Author-selected double chances; reduced source layout, synthetic prose only."""
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import subprocess
import unittest
from unittest.mock import patch

from editorial_worker import sources as s
from editorial_worker.translation import (LocalTranslator, SourceFallbackTranslator,
    TranslationRejected, require_bilingual, translate_batch)
from test_analysis_default_utc import CASES, DAY, NOW, page


PAIRS = (({'1', 'N'}, 'Victoire Atlético Madrid ou match nul'),
         ({'1', '2'}, 'Pas de match nul'),
         ({'N', '2'}, 'Victoire Bayern Munich ou match nul'))


def authored(active, row=CASES[1], headline=None):
    value = page(row)
    raw = re.sub(r'<div class="box1n2(?: active)?">([1N2])</div>',
        lambda match: '<div class="box1n2' + (' active' if match[1] in active else '') + '">' + match[1] + '</div>', value.html)
    if headline is not None:
        raw = re.sub(r'<p class="grey line-height-1">.*?</p>',
                     '<p class="grey line-height-1">' + headline + '</p>', raw, count=1)
    return s.rdj.FetchedPage(value.url, raw, value.status)


class AuthorDoubleChanceTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {'RDJ_CONTENT_HUB_DIR': ''})
        environment.start()
        self.addCleanup(environment.stop)

    def item(self, value, **kwargs):
        return s.match_item(s.rdj._detail(value), value, 'rdj_football_analysis', DAY,
            resolver=lambda *_: self.fail('An author selection needs no schedule lookup'), **kwargs)

    def assert_rejected(self, raw):
        value = s.rdj.FetchedPage(page().url, raw)
        with self.assertRaisesRegex(ValueError, 'explicit_expert_outcome_missing'):
            self.item(value)

    def test_exact_three_double_chance_pairs_map_without_inventing_a_price(self):
        for active, label in PAIRS:
            with self.subTest(active=active):
                result = self.item(authored(active))
                self.assertEqual(result['selection']['label']['fr'], label)
                self.assertIsNone(result['selection']['odds'])
                self.assertNotIn('betType', result['selection'])
                self.assertEqual(result['startsAtUtc'], DAY + 'T21:00:00Z')

    def test_observed_feyenoord_and_galatasaray_author_box_shapes_are_explicit_one_n(self):
        rows = ((('6106306', 'feyenoord-inter', 'Feyenoord', 'Inter', '21:00'), 'Le Feyenoord fait un coup ?'),
                (('6106341', 'galatasaray-vfb-stuttgart', 'Galatasaray', 'VfB Stuttgart', '18:45'), 'Galatasaray ou le nul'))
        for row, headline in rows:
            value = authored({'1', 'N'}, row, headline)
            with self.subTest(source_id=row[0]):
                self.assertEqual(s.rdj._detail(value)['expert_headline']['reason'], 'expert_headline_missing_or_ambiguous')
                result = self.item(value)
                self.assertEqual(result['sourceId'], row[0])
                self.assertEqual(result['selection']['label']['fr'], 'Victoire ' + row[2] + ' ou match nul')
                self.assertIsNone(result['selection']['odds'])

    def test_expert_phrase_never_overrides_the_selected_boxes(self):
        result = self.item(authored({'1', 'N'}, headline='Le visiteur est favori selon cette phrase synthétique.'))
        self.assertEqual(result['selection']['label']['fr'], PAIRS[0][1])

    def test_duplicate_missing_or_extra_outcome_boxes_cannot_form_a_double_chance(self):
        raw = authored({'1', 'N'}).html
        variants = (
            raw.replace('<div class="box1n2">2</div>', '<div class="box1n2">N</div>'),
            raw.replace('<div class="box1n2">2</div>', ''),
            raw.replace('<div class="box1n2">2</div>', '<div class="box1n2">2</div><div class="box1n2">1</div>'),
            raw.replace('<div class="box1n2">2</div>', '<div class="box1n2">X</div>'),
        )
        for value in variants:
            with self.subTest(value=value):
                self.assert_rejected(value)

    def test_zero_three_or_two_author_blocks_are_not_a_single_authored_choice(self):
        self.assert_rejected(authored(set()).html)
        self.assert_rejected(authored({'1', 'N', '2'}).html)
        raw = authored({'1', 'N'}).html
        block = re.search(r'<div class="table bloc">.*?</body>', raw).group(0).removesuffix('</body>')
        self.assert_rejected(raw.replace('</body>', block + '</body>'))

    def test_exact_expert_heading_block_and_one_nonempty_direct_paragraph_are_required(self):
        raw = authored({'1', 'N'}).html
        variants = (
            raw.replace('Pronostic de nos experts', 'Pronostic des bookmakers'),
            raw.replace('class="table bloc"', 'class="table"'),
            raw.replace('class="table bloc"', 'class="bloc"'),
            re.sub(r'<p class="grey line-height-1">.*?</p>', '', raw),
            re.sub(r'<p class="grey line-height-1">.*?</p>', '<p class="grey line-height-1"></p>', raw),
            raw.replace('</h2><p class="grey line-height-1">', '</h2><p class="grey line-height-1">Second</p><p class="grey line-height-1">'),
        )
        for value in variants:
            with self.subTest(value=value):
                self.assert_rejected(value)

    def test_single_one_n_two_selections_and_their_matching_prices_are_unchanged(self):
        for outcome, label in (('1', 'Victoire Atlético Madrid'), ('N', 'Match nul'), ('2', 'Victoire Bayern Munich')):
            value = authored({outcome})
            detail = s.rdj._detail(value)
            detail['detail_priced_markets'] = [{'pick_fr': label, 'odds': '1.73'}]
            result = s.match_item(detail, value, 'rdj_football_analysis', DAY, resolver=lambda *_: None)
            with self.subTest(outcome=outcome):
                self.assertEqual(result['selection']['label']['fr'], label)
                self.assertEqual(result['selection']['odds'], 1.73)

    def test_double_chance_never_borrows_a_table_price_and_explicit_journal_pick_keeps_ownership(self):
        value = authored({'1', 'N'})
        detail = s.rdj._detail(value)
        detail['detail_priced_markets'] = [{'pick_fr': PAIRS[0][1], 'odds': '9.99'}]
        result = s.match_item(detail, value, 'rdj_football_analysis', DAY, resolver=lambda *_: None, odds=7.77)
        self.assertIsNone(result['selection']['odds'])
        owned = self.item(value, pick='Choix explicite du journal', odds=1.81)
        self.assertEqual(owned['selection']['label']['fr'], 'Choix explicite du journal')
        self.assertEqual(owned['selection']['odds'], 1.81)

    def test_double_chance_fallback_does_not_change_other_sport_settlement(self):
        value = authored({'1', 'N'})
        detail = s.rdj._detail(value)
        detail['sport'] = 'basketball'
        with self.assertRaisesRegex(ValueError, 'explicit_expert_outcome_missing'):
            s.match_item(detail, value, 'rdj_multisport_analysis', DAY, resolver=lambda *_: None)

    def test_existing_market_translation_or_source_fallback_never_blocks_the_three_pairs(self):
        values = [self.item(authored(active)) for active, _ in PAIRS]
        class ExistingMarketsOrSource(SourceFallbackTranslator):
            def market(self, source, context):
                return LocalTranslator.market(self, source, context)
        before = deepcopy(values)
        result, audit = translate_batch({'source': 'rdj_football_analysis', 'editionDate': DAY, 'items': values},
            ExistingMarketsOrSource(TranslationRejected('provider_unavailable')), best_effort=True)
        self.assertTrue(require_bilingual(result))
        self.assertFalse(audit['translationBlocksPublication'])
        self.assertEqual(values, before)
        self.assertEqual([row['selection']['label']['en'] for row in result['items']],
            ['Atlético Madrid to win or draw', 'Pas de match nul', 'Bayern Munich to win or draw'])

    def test_three_double_chance_items_pass_the_real_api_preflight_without_a_new_market_enum(self):
        values = []
        for index, (active, _) in enumerate(PAIRS):
            values.append(self.item(authored(active, CASES[index])))
        payload, _ = translate_batch({'source': 'rdj_football_analysis', 'editionDate': DAY, 'items': values},
            SourceFallbackTranslator(TranslationRejected('provider_unavailable')), best_effort=True)
        process = subprocess.run(['node', '-e',
            "let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>console.log(JSON.stringify(require('./tools/wintips-editorial-worker/validate-api-payload.cjs').validate(Buffer.concat(b),new Date(process.argv[1])))))",
            NOW.isoformat()], input=json.dumps(payload), cwd=Path(__file__).resolve().parents[3], text=True,
            capture_output=True, timeout=20, check=True)
        result = json.loads(process.stdout)
        self.assertTrue(result['passed'], result)
        self.assertEqual(result['itemCount'], 3)


if __name__ == '__main__':
    unittest.main()
