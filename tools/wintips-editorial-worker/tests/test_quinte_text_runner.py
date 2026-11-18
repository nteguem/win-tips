"""Quinté native text orchestration, identity and publication freeze."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from editorial_worker import runner, sources, plain_quinte
from test_bilingual_runner import arguments, Api
from test_published_source_windows import configuration, DAY, NOW, TURF


def text_item():
    return {'source': TURF, 'editionDate': DAY, 'sourceId': DAY + '-R1C3',
        'sourceUrl': 'https://www.ruedesjoueurs.com/turf/pronostic-turf/course/24-10-2026/R1/C3/prix-de-beaune.html',
        'kind': 'article', 'startsAtUtc': None, 'status': 'unknown',
        'sport': {'key': 'horse_racing', 'name': 'Courses hippiques'},
        'title': {'fr': 'Le Quinté', 'en': 'The Quinté'},
        'analysis': {'fr': [{'heading': 'Analyse', 'paragraphs': ['Texte intégral.']}],
                     'en': [{'heading': 'Analysis', 'paragraphs': ['Full narrative.']}]}}


class QuinteTextRunnerTests(unittest.TestCase):
    def test_main_adapter_calls_native_bigwin_transport_not_legacy_race_parser(self):
        fetcher = type('Fetch', (), {'json': None, 'budget_refusals': []})()
        result = {'status': 'ready', 'items': [text_item()], 'issues': []}
        with patch.object(plain_quinte, 'collect_turf_text', return_value=result) as native, \
                patch.object(sources, 'collect_turf', side_effect=AssertionError('legacy parser forbidden')):
            self.assertEqual(sources.collect(TURF, DAY, fetcher, now=NOW), result)
            native.assert_called_once()

    def test_text_has_no_departure_cutoff_but_keeps_publisher_date_and_course_identity(self):
        runner.validate_item(text_item(), TURF, DAY, NOW, 30)
        for change in ({'sourceId': DAY + '-R2C3'},
                       {'sourceUrl': text_item()['sourceUrl'].replace('24-10', '23-10')},
                       {'editionDate': '2026-10-23'}):
            with self.assertRaises(ValueError):
                runner.validate_item({**text_item(), **change}, TURF, DAY, NOW, 30)
        with self.assertRaisesRegex(ValueError, 'outside_edition_day'):
            runner.validate_item(text_item(), TURF, DAY,
                datetime(2026, 10, 25, 10, tzinfo=timezone.utc), 30)

    def test_native_and_legacy_published_quinte_freeze_without_public_page_request(self):
        for kind in ('article', 'horse_racing'):
            config = configuration()
            window = config['publishedSourceWindows']['sources'][1]
            if kind == 'article':
                window['items'][0].update(kind=kind, startsAtUtc=None)
                window['latestStartsAtUtc'] = None
            result = runner.published_quinte_snapshot(config, DAY, NOW)
            self.assertTrue(result['verified'])
            self.assertEqual(result['sourceIds'], [DAY + '-R1C3'])

    def test_corrupt_or_stale_inventory_cannot_authorize_snapshot(self):
        for mutate in (lambda c: c['sources'][1].update(categoryIds=['c' * 24]),
                       lambda c: c['publishedSourceWindows'].update(checkedAtUtc=DAY + 'T00:00:00Z'),
                       lambda c: c['publishedSourceWindows']['sources'][1]['items'][0].update(sourceId='wrong'),
                       lambda c: c['publishedSourceWindows']['sources'][1].update(count=2)):
            config = configuration()
            mutate(config)
            with self.assertRaises(ValueError):
                runner.published_quinte_snapshot(config, DAY, NOW)

    def test_frozen_source_without_verified_inventory_is_not_overwritten(self):
        config = configuration()
        config['sources'][1]['editorialCopyState'] = {'state': 'frozen', 'legacy': False}
        config['publishedSourceWindows']['sources'][1].update(ready=False)
        with self.assertRaises(ValueError):
            runner.published_quinte_snapshot(config, DAY, NOW)

    def test_text_publish_skips_old_translation_and_imports_integral_payload(self):
        class CurrentApi(Api):
            def request(self, route, payload=None):
                if route.endswith('/config'):
                    self.calls.append((route, deepcopy(payload)))
                    return {'date': DAY, 'importEnabled': True, 'notificationsEnabled': False,
                        'sources': [{'key': TURF, 'access': 'free', 'categoryIds': ['b' * 24]}]}
                return super().request(route, payload)
        api = CurrentApi()
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict('os.environ', {'WINTIPS_EDITORIAL_MANAGE_MODEL': 'true', 'WINTIPS_EDITORIAL_TRANSLATOR': 'ollama'}), \
                patch('editorial_worker.model_runtime.require_admission', side_effect=AssertionError('retired model window')), \
                patch.object(runner, 'collect', return_value={'status': 'ready', 'items': [text_item()], 'issues': []}), \
                patch.object(runner, 'make_translator', side_effect=AssertionError('already translated by BigWin')):
            report = runner.run(arguments(directory, edition=DAY, publish=True), api_client=api,
                fetcher=type('Fetch', (), {'requests': 0, 'records': []})(), now=NOW,
                clock=lambda: NOW, api_validator=lambda *_: {'passed': True})
            imported = next(payload for route, payload in api.calls if route.endswith('/import'))
            self.assertEqual(imported['items'], [text_item()])
            self.assertEqual(report['sources'][0]['translationPolicy'], 'shared-bigwin-editorial-text-v1')
            self.assertEqual(report['publishedSources'], [TURF])
            self.assertEqual(report['reportScope'], 'free')
            self.assertEqual(json.loads((Path(directory) / 'last-run-free.json').read_text('utf-8')), report)
            self.assertEqual(json.loads((Path(directory) / 'last-run.json').read_text('utf-8')), report)


if __name__ == '__main__':
    unittest.main()
