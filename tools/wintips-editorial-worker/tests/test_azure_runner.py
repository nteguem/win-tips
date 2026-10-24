"""Cloud routing mocks: no real Azure, local model, API or notification call."""
from contextlib import ExitStack
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from editorial_worker import runner, azure_translation, model_runtime, mt_translation
from editorial_worker.translation import LocalTranslator, TranslationRejected
from test_bilingual_runner import Api, TestTranslator, arguments, payload_item, api_validation_fixture


class AzureRunnerTests(unittest.TestCase):
    def trap(self, *args, **kwargs): self.fail('Azure must not start or import a local engine/lock')

    def env(self):
        return patch.dict('os.environ', {'WINTIPS_EDITORIAL_TRANSLATOR': 'azure',
            'WINTIPS_EDITORIAL_MANAGE_MODEL': 'true'}, clear=True)

    def test_factory_takes_azure_branch_before_any_local_constructor(self):
        expected = TestTranslator()
        with TemporaryDirectory() as directory, self.env(), ExitStack() as resources, \
                patch.object(azure_translation, 'create_translator_from_env', return_value=expected) as factory, \
                patch.object(mt_translation, 'MarianTransport', side_effect=self.trap), \
                patch.object(LocalTranslator, '__init__', side_effect=self.trap), \
                patch.object(model_runtime, 'managed_model', side_effect=self.trap):
            args = arguments(directory, translation_max_seconds=1200)
            self.assertIs(runner.make_translator(args, Path(directory), resources), expected)
            factory.assert_called_once_with(cache_dir=Path(directory) / 'translation-cache', max_seconds=180)

    def test_missing_key_fails_without_azure_or_local_transport(self):
        with TemporaryDirectory() as directory, self.env(), ExitStack() as resources, \
                patch.object(azure_translation.AzureTransport, '__call__', side_effect=self.trap), \
                patch.object(model_runtime, 'managed_model', side_effect=self.trap), \
                self.assertRaises(TranslationRejected) as caught:
            runner.make_translator(arguments(directory), Path(directory), resources)
        self.assertEqual(caught.exception.code, 'azure_key_required')

    def run_case(self, directory, api, translator, **changes):
        instant = datetime(2026, 10, 23, 8, tzinfo=timezone.utc)
        with self.env(), \
                patch.object(runner, 'collect', return_value={'status': 'ready', 'items': [payload_item()], 'issues': []}), \
                patch.object(model_runtime, 'require_admission', side_effect=self.trap), \
                patch.object(model_runtime, 'managed_model', side_effect=self.trap):
            return runner.run(arguments(directory, **changes),
                fetcher=type('Fetch', (), {'requests': 0, 'records': []})(),
                api_client=api, translator=translator, now=instant, clock=lambda: instant, api_validator=api_validation_fixture)

    def test_cloud_preview_has_no_shared_admission_or_post_even_with_old_manage_flag(self):
        with TemporaryDirectory() as directory:
            api = Api()
            report = self.run_case(directory, api, TestTranslator(), translate=True)
            self.assertTrue(report['sources'][0]['bilingual'])
            self.assertNotIn('deferred', report)
            self.assertEqual([route for route, _ in api.calls], ['/api/internal/editorial/config'])

    def test_cloud_ready_source_uses_existing_import_and_delivery_contract(self):
        with TemporaryDirectory() as directory:
            api = Api()
            report = self.run_case(directory, api, TestTranslator(), publish=True)
            self.assertTrue(report['sources'][0]['imported'])
            self.assertEqual([route for route, _ in api.calls], ['/api/internal/editorial/config',
                '/api/internal/editorial/import', '/api/internal/editorial/notifications/drain'])
            self.assertEqual(api.calls[1][1]['items'][0]['analysis']['fr'], payload_item()['analysis']['fr'])

    def test_missing_key_blocks_source_without_french_only_import(self):
        with TemporaryDirectory() as directory:
            api = Api()
            report = self.run_case(directory, api, None, publish=True)
            self.assertEqual(report['sources'][0]['status'], 'translation_blocked')
            self.assertIn('azure_key_required', report['sources'][0]['issues'])
            self.assertFalse(any(route.endswith('/import') for route, _ in api.calls))

    def test_batch_preloader_gets_original_fields_before_translation_without_mutation(self):
        calls = []
        class Prepared(TestTranslator):
            def prepare_batch(self, payload): calls.append(deepcopy(payload))
        with TemporaryDirectory() as directory:
            self.run_case(directory, Api(), Prepared(), translate=True)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['items'], [payload_item()])
        self.assertNotIn('en', calls[0]['items'][0]['analysis'])


if __name__ == '__main__': unittest.main()
