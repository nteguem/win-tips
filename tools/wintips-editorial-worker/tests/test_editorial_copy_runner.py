"""Only optional copy orchestration; no cloud, API HTTP, model or publication."""
from copy import deepcopy
from dataclasses import make_dataclass
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import ModuleType
import unittest
from unittest.mock import patch

from editorial_worker import runner
import test_bilingual_runner as fixtures


COPY = {'version': 'rdj-editorial-copy-v2', 'sourceHash': 'a' * 64, 'sourceIds': ['2026-10-23-R1C4'],
    'choice': {'angle': 'context', 'focusIds': ['2026-10-23-R1C4'], 'entries': [{
        'id': '2026-10-23-R1C4', 'description': {'fr': 'Quels enjeux sur cette piste ?', 'en': 'What is at stake on this track?'},
        'notification': {'fr': 'Le rendez-vous de la piste.', 'en': 'A date with the track.'}}]},
    'body': {'fr': 'Prix test · Test : Quels enjeux sur cette piste ?', 'en': 'Prix test · Test: What is at stake on this track?'},
    'notificationBody': {'fr': 'Prix test · Test : Le rendez-vous de la piste.', 'en': 'Prix test · Test: A date with the track.'},
    'method': 'source_excerpt_fallback', 'model': None, 'cacheKey': None, 'nativeSha256': None}


class CopyApi(fixtures.Api):
    def __init__(self, state=None):
        super().__init__(); self.copy_state = state if state is not None else {'state': 'new', 'legacy': False}
    def request(self, route, payload=None):
        result = super().request(route, payload)
        if route.endswith('/config'):
            for row in result['sources']: row['editorialCopyState'] = deepcopy(self.copy_state)
        return result


class EditorialCopyRunnerTests(unittest.TestCase):
    def test_optional_copy_is_added_after_translation_without_changing_source_fields_or_preview_permissions(self):
        case = fixtures.BilingualRunnerTests()
        with TemporaryDirectory() as directory, patch.object(runner, 'build_editorial_copy', return_value=deepcopy(COPY)):
            api = CopyApi()
            result = case.run_case(directory, api, fixtures.TestTranslator(), translate=True)
            payload = json.loads(Path(result['sources'][0]['payloadFile']).read_bytes())
            french = json.loads((Path(directory) / 'editions/2026-10-23/rdj_turf_quinte.fr.json').read_bytes())
            self.assertEqual(payload['editorialCopy'], COPY)
            self.assertNotIn('editorialCopy', french)
            for field in ('summary', 'analysis'):
                self.assertEqual(payload['items'][0][field]['fr'], french['items'][0][field]['fr'])
            self.assertEqual([route for route, _ in api.calls], ['/api/internal/editorial/config'])

    def test_copy_arrives_in_preflight_and_import_with_original_summary(self):
        case = fixtures.BilingualRunnerTests()
        with TemporaryDirectory() as directory, patch.object(runner, 'build_editorial_copy', return_value=deepcopy(COPY)):
            api = CopyApi()
            result = case.run_case(directory, api, fixtures.TestTranslator(), publish=True)
            self.assertTrue(result['published'])
            posted = next(payload for route, payload in api.calls if route.endswith('/import'))
            self.assertEqual(posted['editorialCopy'], COPY)
            self.assertEqual(posted['items'][0]['summary']['fr'], 'Deux chevaux.')

    def test_optional_generation_failure_never_blocks_source_import_or_notification_drain(self):
        with TemporaryDirectory() as directory, patch.object(runner, 'build_editorial_copy', side_effect=ValueError('cosmetic_unavailable')):
            api = CopyApi()
            result = fixtures.BilingualRunnerTests().run_case(directory, api, fixtures.TestTranslator(), publish=True)
            self.assertTrue(result['published'])
            self.assertFalse(result.get('blocked', False))
            posted = next(payload for route, payload in api.calls if route.endswith('/import'))
            self.assertNotIn('editorialCopy', posted)
            self.assertEqual(posted['items'][0]['summary']['fr'], 'Deux chevaux.')
            self.assertEqual(posted['items'][0]['selection']['orderedNumbers'], [2, 1])
            self.assertEqual(api.calls[-1][0], '/api/internal/editorial/notifications/drain')

    def test_generation_error_uses_shared_source_excerpt_fallback_or_omits_copy(self):
        hub = ModuleType('rdj_hub'); module = ModuleType('rdj_hub.editorial_copy')
        package = type('Package', (), {'open_hub': staticmethod(lambda *_: object())})()
        module.facts_from_wintips = lambda payload: {'source': payload['source']}
        generation_calls = []
        def unavailable(*args, **kwargs):
            raise ValueError('cosmetic_unavailable')
        def generate(*args, **kwargs):
            generation_calls.append(True)
            raise ValueError('cosmetic_unavailable')
        module.generate = generate
        for fallback, expected in ((lambda *_: deepcopy(COPY), COPY), (unavailable, None)):
            module.fallback = fallback
            config = make_dataclass('CopyConfig', [('max_seconds', float)])(10)
            translator = type('Translator', (), {'config': config, 'remaining': lambda self: 10})()
            with patch('editorial_worker.content_hub.module', return_value=package), \
                 patch.dict(sys.modules, {'rdj_hub': hub, 'rdj_hub.editorial_copy': module}), \
                 patch.dict('os.environ', {'WINTIPS_EDITORIAL_TRANSLATOR': 'gemini',
                     'WINTIPS_EDITORIAL_GEMINI_QUOTA_DIR': str(Path.cwd())}):
                self.assertEqual(runner.build_editorial_copy({'source': 'rdj_turf_quinte', 'editionDate': '2026-10-23'}, translator), expected)
        self.assertEqual(len(generation_calls), 2)

    def test_missing_hub_preserves_existing_contract(self):
        hub = ModuleType('rdj_hub'); module = ModuleType('rdj_hub.editorial_copy')
        hub.open_hub = lambda *_: None
        module.facts_from_wintips = lambda _: self.fail('No facts generation when hub absent')
        module.generate = module.fallback = lambda *_: self.fail('No generation when hub absent')
        with patch('editorial_worker.content_hub.module', return_value=hub), patch.dict(sys.modules, {'rdj_hub': hub, 'rdj_hub.editorial_copy': module}):
            self.assertIsNone(runner.build_editorial_copy({'editionDate': '2026-10-23'}, fixtures.TestTranslator()))

    def test_frozen_legacy_or_unknown_source_never_calls_generation_or_replays_old_copy(self):
        for state in ({'state':'frozen','legacy':False}, {'state':'frozen','legacy':True},
                      {'state':'unknown','legacy':False}, {'state':'new','legacy':True}, {'state':'new'}, {}):
            with self.subTest(state=state), TemporaryDirectory() as directory, \
                 patch.object(runner, 'build_editorial_copy', side_effect=AssertionError('Frozen/unknown must not author copy')):
                result = fixtures.BilingualRunnerTests().run_case(directory, CopyApi(state), fixtures.TestTranslator(), translate=True)
                payload = json.loads(Path(result['sources'][0]['payloadFile']).read_bytes())
                self.assertTrue(result['sources'][0]['bilingual'])
                self.assertNotIn('editorialCopy', payload)

    def test_generation_requires_unique_current_source_and_explicit_new_proof(self):
        row = {'key':'rdj_turf_quinte','editorialCopyState':{'state':'new','legacy':False}}
        for config in (None, {}, {'date':'2026-10-24','sources':[row]},
                       {'date':'2026-10-23','sources':[row,row]}, {'date':'2026-10-23','sources':[]}):
            self.assertFalse(runner.editorial_copy_allowed(config, 'rdj_turf_quinte', '2026-10-23'))
        self.assertTrue(runner.editorial_copy_allowed({'date':'2026-10-23','sources':[row]}, 'rdj_turf_quinte', '2026-10-23'))

    def test_all_essential_batches_finish_before_optional_generation(self):
        events = []
        class TwoSources(CopyApi):
            def request(self, route, payload=None):
                result = super().request(route, payload)
                if route.endswith('/config'):
                    result['sources'].append({'key':'rdj_petit_journal','categoryIds':['other'],
                        'editorialCopyState':{'state':'new','legacy':False}})
                return result
        class Translator(fixtures.TestTranslator):
            def text(self, source, item):
                events.append('essential'); return super().text(source, item)
        def collect(source, *args, **kwargs):
            item = fixtures.payload_item(); item['source'] = source
            return {'status':'ready','items':[item],'issues':[]}
        def generate(*args):
            events.append('copy'); return None
        # Collection/schema are explicit orchestration doubles in this test.
        with TemporaryDirectory() as directory, patch.object(runner, 'collect', side_effect=collect), \
             patch.object(runner, 'validate_item'), patch.object(runner, 'build_editorial_copy', side_effect=generate):
            result = runner.run(fixtures.arguments(directory, translate=True, source=['rdj_petit_journal','rdj_turf_quinte']),
                fetcher=type('Fetch', (), {'requests':0,'records':[]})(), now=fixtures.BilingualRunnerTests.clock(),
                clock=fixtures.BilingualRunnerTests.clock, api_client=TwoSources(), translator=Translator())
        self.assertEqual(len(result['sources']), 2)
        self.assertEqual(events[-2:], ['copy','copy'])
        self.assertNotIn('essential', events[events.index('copy'):])


if __name__ == '__main__': unittest.main()
