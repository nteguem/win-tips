"""V5 deterministic copy detection outside factual spans, no language classifier."""
from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch

import test_gemini_subset_repair as subset
from editorial_worker import gemini_translation as gemini
from editorial_worker.translation import TranslationRejected


Native, ITEM, SOURCES = subset.Native, subset.ITEM, subset.SOURCES


class ProseGuardTests(unittest.TestCase):
    setUp = subset.SubsetRepairTests.setUp
    translator = subset.SubsetRepairTests.translator
    jobs = subset.SubsetRepairTests.jobs

    def test_25_flash_zero_thinking_is_in_wire_and_cache_only_for_that_exact_model(self):
        settings = replace(self.config, model='gemini-2.5-flash')
        translator = self.translator(Native(), config=settings)
        job = translator.job(SOURCES[0], ITEM)
        wire = gemini.request_payload(settings, [job['html']])['generationConfig']
        self.assertEqual(wire['thinkingConfig'], {'thinkingBudget': 0})
        self.assertEqual(job['identity']['generation']['thinkingConfig'], wire['thinkingConfig'])
        with patch.object(gemini, 'generation_options', return_value={
                'temperature': 0, 'candidateCount': 1, 'maxOutputTokens': 8192}):
            self.assertNotEqual(job['key'], translator.job(SOURCES[0], ITEM)['key'])
        self.assertNotIn('thinkingConfig', gemini.generation_options(self.config))
        self.assertNotIn('thinkingConfig', gemini.generation_options(replace(settings, model='gemini-2.5-flash-lite')))
        self.assertEqual(gemini.generation_options(replace(settings, model='gemini-3.8-flash'))['thinkingConfig'], {'thinkingLevel': 'LOW'})
    def test_observed_tottenham_protected_source_is_not_english_after_ordinal_normalization(self):
        case = json.loads((Path(__file__).parent/'fixtures/gemini-source-prose-20261024.json').read_bytes())
        html, _ = gemini._protected(case['source'], case['item'])
        baseline, _ = gemini.validate_output(case['source'], case['item'], html)
        self.assertEqual(baseline, case['observedCopiedEnglish'])
        self.assertNotEqual(baseline, case['source'])
        with self.assertRaises(TranslationRejected) as caught: gemini._validated(case['source'], case['item'], html)
        self.assertEqual(caught.exception.code, 'gemini_source_prose_not_translated')

    def test_case_punctuation_spacing_and_normalized_numbers_do_not_hide_a_copy(self):
        source = 'Nice occupe la 16ème place après 3 matchs.'
        html, _ = gemini._protected(source, ITEM)
        parts = re.split(r'(<span\b[^>]*>.*?</span>|<[^>]*>)', html, flags=re.S)
        for mode in ('original', 'case', 'punctuation'):
            candidate = ''.join(part if part.startswith('<') or mode == 'original' else
                (part.upper() if mode == 'case' else part.replace('.', '!').replace(' ', '  ')) for part in parts)
            with self.subTest(mode=mode), self.assertRaises(TranslationRejected) as caught:
                gemini._validated(source, ITEM, candidate)
            self.assertEqual(caught.exception.code, 'gemini_source_prose_not_translated')

    def test_fact_and_structure_checks_precede_prose_copy_diagnostic(self):
        source = 'Nice occupe la 16ème place après 3 matchs.'
        html, _ = gemini._protected(source, ITEM)
        for candidate, code in ((html.replace('>16th<', '>17th<'), 'gemini_output_structure_or_facts_changed'),
                (html.replace('>Nice<', '>Brest<'), 'gemini_output_structure_or_facts_changed'),
                (html.replace('</div>', ' 9 wins</div>'), 'gemini_unprotected_number_added'),
                (html.replace('</div>', '<script>x</script></div>'), 'gemini_output_structure_or_facts_changed')):
            with self.subTest(code=code), self.assertRaises(TranslationRejected) as caught:
                gemini._validated(source, ITEM, candidate)
            self.assertEqual(caught.exception.code, code)

    def test_real_english_changes_free_prose_without_changing_any_anchor(self):
        source = 'Nice occupe la 16ème place après 3 matchs.'
        html, _ = gemini._protected(source, ITEM)
        english = html.replace('occupe la', 'holds').replace('après', 'after').replace('matchs', 'matches')
        target, proof = gemini._validated(source, ITEM, english)
        self.assertTrue(proof['passed']); self.assertIn('16th', target)

    def test_copy_repair_is_queued_with_explicit_flag_and_keeps_good_original_native(self):
        def mutate(native, rows):
            if len(native.calls) == 1: rows[1]['text'] = native.calls[-1]['texts'][1]
        native = Native(mutate, initial_bad=()); translator = self.translator(native); jobs = self.jobs(translator)
        translator.send(jobs)
        self.assertEqual(len(native.calls), 2)
        feedback = native.calls[1]['feedback']
        self.assertEqual(feedback['fragmentIds'], ['1'])
        self.assertEqual(feedback['rejections'][0]['code'], 'gemini_source_prose_not_translated')
        self.assertTrue(feedback['rejections'][0]['diagnostics']['sourceProseUnchanged'])
        self.assertTrue(translator.attempts[0]['contentRepairScheduled'])
        wire = gemini.request_payload(translator.config, native.calls[1]['texts'], feedback)
        self.assertIn('Translate ALL the supplied unprotected French prose into English', wire['systemInstruction']['parts'][0]['text'])
        for index in (0, 2):
            saved = json.loads((self.root/'gemini/responses'/(jobs[index]['key']+'.json')).read_bytes())
            self.assertEqual(saved['html'], native.calls[0]['rows'][index]['text'])

    def test_persistent_copied_prose_stops_after_one_repair_without_partial_cache(self):
        def mutate(native, rows):
            index = 1 if len(native.calls) == 1 else 0
            rows[index]['text'] = native.calls[-1]['texts'][index]
        native = Native(mutate, initial_bad=()); translator = self.translator(native)
        with self.assertRaises(TranslationRejected) as caught: translator.send(self.jobs(translator))
        self.assertEqual(caught.exception.code, 'gemini_source_prose_not_translated')
        self.assertEqual(translator.requests, 2); self.assertEqual(translator.prepared, {})
        self.assertFalse((self.root/'gemini/responses').exists())

    def test_v4_saved_passed_cannot_override_v5_prose_revalidation(self):
        translator = self.translator(Native()); job = translator.job(SOURCES[1], ITEM)
        with patch.object(gemini, 'VERSION', 'gemini-html-facts-v4-rejected-subset-repair'):
            self.assertNotEqual(job['key'], translator.job(SOURCES[1], ITEM)['key'])
        path = self.root/'gemini/responses'/(job['key']+'.json'); path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'identity': job['identity'], 'html': job['html'], 'proof': {'passed': True}}), encoding='utf-8')
        with self.assertRaises(TranslationRejected) as caught: translator.cached(job)
        self.assertEqual(caught.exception.code, 'gemini_source_prose_not_translated')


if __name__ == '__main__': unittest.main()
