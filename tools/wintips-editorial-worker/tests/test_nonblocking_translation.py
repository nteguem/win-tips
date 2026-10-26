"""Publication regressions: imperfect English never drops source selections."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from editorial_worker import gemini_translation as gemini, runner
from editorial_worker.translation import (TranslationRejected, SourceFallbackTranslator,
    require_bilingual, translate_batch)
from test_azure_translation import item, english_html
from test_bilingual_runner import Api, TestTranslator, arguments, payload_item, api_validation_fixture


KEY = 'testOnlyNotAGeminiCredential12345'
NOW = datetime(2026, 10, 24, 8, tzinfo=timezone.utc)


def response(texts, transform=english_html):
    return {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': json.dumps({
        'translations': [{'id': str(index), 'text': transform(text)} for index, text in enumerate(texts)]})}]}}]}


class NonblockingTranslationTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def translator(self, request, **kwargs):
        return gemini.GeminiTranslator(gemini.GeminiConfig(KEY), cache_dir=self.directory,
            quota_dir=self.directory / 'quota', request=request, now=lambda: NOW,
            quality_policy='advisory', **kwargs)

    def test_name_occurrence_false_positive_is_retained_without_repair(self):
        source = 'Les Lyonnais restent en forme.'
        context = item()
        context['teams'] = {'home': {'name': 'PSG'}, 'away': {'name': 'Lyon'}}
        calls = []
        def request(texts, timeout):
            calls.append(texts)
            return response(texts, lambda _: '<div>The Lyon side remain in good form.</div>')
        translator = self.translator(request)
        target = translator.text(source, context)
        self.assertEqual(target, 'The Lyon side remain in good form.')
        self.assertEqual(len(calls), 1)
        self.assertIn('gemini_name_occurrences_changed', translator.records[-1]['proof']['warnings'])
        self.assertFalse(translator.records[-1]['proof']['passed'])

    def test_changed_quantity_and_result_still_publish_provider_text(self):
        translator = self.translator(lambda texts, timeout: response(texts,
            lambda _: '<div>Nice won 99 matches.</div>'))
        payload = {'source': 'rdj_football_analysis', 'editionDate': '2026-10-24', 'items': [item()]}
        original = deepcopy(payload)
        result, audit = translate_batch(payload, translator, best_effort=True)
        self.assertEqual(result['items'][0]['analysis']['en'][0]['paragraphs'], ['Nice won 99 matches.'])
        self.assertEqual(result['items'][0]['analysis']['fr'], original['items'][0]['analysis']['fr'])
        self.assertEqual(result['items'][0]['selection']['odds'], 2.15)
        self.assertEqual(payload, original)
        self.assertEqual(audit['sourceFallbacks'], 0)
        self.assertFalse(audit['translationBlocksPublication'])

    def test_arbitrary_player_market_is_translated_in_original_batch(self):
        value = item()
        value['selection']['label']['fr'] = 'Doué décisif'
        value['selection']['betType'] = 'other'
        calls = []
        def request(texts, timeout):
            calls.append(texts)
            return response(texts, lambda text: english_html(text).replace('décisif', 'to score or assist'))
        translator = self.translator(request)
        result, audit = translate_batch({'items': [value]}, translator, best_effort=True)
        self.assertEqual(result['items'][0]['selection']['label']['en'], 'Doué to score or assist')
        self.assertEqual(result['items'][0]['selection']['betType'], 'other')
        self.assertEqual(len(calls), 1)
        self.assertTrue(any('décisif' in text for text in calls[0]))
        self.assertEqual(audit['sourceFallbacks'], 0)

    def test_advisory_cache_is_separate_and_reuses_imperfect_native_response(self):
        source = item()['summary']['fr']
        translator = self.translator(lambda texts, timeout: response(texts, lambda _: '<div>Nice won 99 matches.</div>'))
        target = translator.text(source, item())
        strict = gemini.GeminiTranslator(gemini.GeminiConfig(KEY), cache_dir=self.directory,
            quota_dir=self.directory / 'quota', request=lambda *a: self.fail('No strict request'), now=lambda: NOW)
        self.assertNotEqual(translator.job(source, item())['key'], strict.job(source, item())['key'])
        cached = self.translator(lambda *a: self.fail('Must reuse imperfect cached response'))
        self.assertEqual(cached.text(source, item()), target)
        self.assertTrue(cached.records[-1]['cached'])

    def test_provider_unavailable_falls_back_once_for_complete_source(self):
        calls = []
        def request(texts, timeout):
            calls.append(texts)
            raise TranslationRejected('gemini_transport_failed')
        result, audit = translate_batch({'items': [item()]}, self.translator(request), best_effort=True)
        target = result['items'][0]
        self.assertEqual(len(calls), 1)
        self.assertEqual(target['summary']['en'], target['summary']['fr'])
        self.assertEqual(target['analysis']['en'][0]['paragraphs'], target['analysis']['fr'][0]['paragraphs'])
        self.assertEqual(target['selection']['label']['en'], 'Brest to win')
        self.assertGreater(audit['sourceFallbacks'], 0)
        self.assertTrue(require_bilingual(result))

    def test_invalid_or_empty_provider_response_falls_back_instead_of_blocking(self):
        for raw in ({'invalid': True}, response(['ignored'], lambda _: '<div></div>')):
            with self.subTest(raw=raw):
                result, audit = translate_batch({'items': [item()]}, self.translator(lambda *a: raw), best_effort=True)
                self.assertTrue(require_bilingual(result))
                self.assertGreater(audit['sourceFallbacks'], 0)

    def test_safe_plain_text_drops_markup_and_hidden_script_content(self):
        target, proof = gemini._advisory_validated('Le constat.', {},
            '<div><script>alert("unsafe")</script><b>The finding.</b></div>')
        self.assertEqual(target, 'The finding.')
        self.assertTrue(proof['warnings'])

    def test_control_characters_fall_back_even_if_quality_validator_accepts(self):
        for accepted in (True, False):
            with self.subTest(accepted=accepted), patch.object(gemini, '_validated',
                    **({'return_value': ('The finding.\x00', {'passed': True})} if accepted else
                       {'side_effect': TranslationRejected('gemini_name_occurrences_changed')})):
                target, proof = gemini._advisory_validated('Le constat.', {}, '<div>The finding.\x00</div>')
                self.assertEqual(target, 'Le constat.')
                self.assertTrue(proof['sourceFallback'])
                self.assertIn('gemini_output_control_character', proof['warnings'])

    def test_all_advisory_targets_have_canonical_line_feeds(self):
        for accepted in (True, False):
            with self.subTest(accepted=accepted), patch.object(gemini, '_validated',
                    **({'return_value': ('First.\r\nSecond.\rThird.', {'passed': True})} if accepted else
                       {'side_effect': TranslationRejected('gemini_name_occurrences_changed')})):
                target, proof = gemini._advisory_validated('Le constat.', {}, '<div>First.\r\nSecond.\rThird.</div>')
                self.assertEqual(target, 'First.\nSecond.\nThird.')
                self.assertNotIn('\r', target)
                self.assertEqual(proof['passed'], accepted)

    def test_unresolved_template_markers_fall_back_before_rendering(self):
        for accepted in (True, False):
            with self.subTest(accepted=accepted), patch.object(gemini, '_validated',
                    **({'return_value': ('__TEAM_0__ to win.', {'passed': True})} if accepted else
                       {'side_effect': TranslationRejected('gemini_name_occurrences_changed')})):
                target, proof = gemini._advisory_validated('Le constat.', {}, '<div>__TEAM_0__ to win.</div>')
                self.assertEqual(target, 'Le constat.')
                self.assertTrue(proof['sourceFallback'])
                self.assertIn('gemini_output_unresolved_marker', proof['warnings'])

    def test_missing_provider_configuration_has_complete_source_fallback(self):
        result, audit = translate_batch({'items': [item()]},
            SourceFallbackTranslator(TranslationRejected('gemini_key_required')), best_effort=True)
        self.assertTrue(require_bilingual(result))
        self.assertEqual(result['items'][0]['selection']['label']['en'], 'Victoire Brest')
        self.assertTrue(all(row['code'] == 'gemini_key_required' for row in audit['warnings']))

    def test_partial_field_failure_retains_other_translations(self):
        class Partial(TestTranslator):
            def text(self, source, context):
                if source == 'Deux chevaux.': return ''
                return super().text(source, context)
        result, audit = translate_batch({'items': [payload_item()]}, Partial(), best_effort=True)
        target = result['items'][0]
        self.assertEqual(target['summary']['en'], 'Deux chevaux.')
        self.assertEqual(target['analysis']['en'][0]['paragraphs'], ['Test analysis.'])
        self.assertEqual(audit['sourceFallbacks'], 1)

    def test_factory_opts_into_advisory_policy(self):
        with patch.dict('os.environ', {'GEMINI_API_KEY': KEY,
                'WINTIPS_EDITORIAL_GEMINI_QUOTA_DIR': str(self.directory / 'quota')}, clear=True):
            self.assertEqual(gemini.create_translator_from_env(self.directory).quality_policy, 'advisory')

    def test_factory_failure_still_imports_and_notifies_without_blocked_status(self):
        api = Api()
        clock = lambda: datetime(2026, 10, 23, 8, tzinfo=timezone.utc)
        with patch.object(runner, 'collect', return_value={'status': 'ready', 'items': [payload_item()], 'issues': []}), \
                patch.object(runner, 'make_translator', side_effect=TranslationRejected('gemini_key_required')):
            report = runner.run(arguments(self.directory, publish=True),
                fetcher=type('Fetch', (), {'requests': 0, 'records': []})(), now=clock(), clock=clock,
                api_client=api, api_validator=api_validation_fixture)
        self.assertFalse(report.get('blocked', False))
        self.assertTrue(report['published'])
        self.assertTrue(report['notificationsSent'])
        self.assertGreater(report['sources'][0]['translationSourceFallbacks'], 0)
        sent = next(payload for route, payload in api.calls if route.endswith('/import'))
        self.assertTrue(require_bilingual(sent))


if __name__ == '__main__':
    unittest.main()
