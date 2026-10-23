from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from editorial_worker import model_runtime, runner
from editorial_worker.calendar import paris_timezone
from test_bilingual_runner import Api, TestTranslator, arguments, payload_item


def utc(hour, minute, *, day=23, second=0):
    return datetime(2026, 10, day, hour, minute, second, tzinfo=timezone.utc)


class AdmissionTests(unittest.TestCase):
    def test_start_middle_end_and_midnight_rollover(self):
        for instant, expected, next_at in [
            (utc(8, 0), False, utc(8, 7)),
            (utc(8, 8), True, utc(9, 7)),
            (utc(8, 30), True, utc(9, 7)),
            (utc(8, 50), False, utc(9, 7)),
            (utc(23, 55), False, utc(0, 7, day=24)),
            (utc(23, 30), True, utc(0, 7, day=24)),
        ]:
            with self.subTest(instant=instant):
                window = model_runtime.admission_window(instant)
                self.assertEqual(window['admitted'], expected)
                self.assertEqual(window['nextBigWinAtUtc'], next_at.isoformat())
                self.assertEqual(window['requiredSeconds'], 1500)

    def test_deadline_boundary_and_timer_jitter(self):
        self.assertTrue(model_runtime.admission_window(utc(8, 42))['admitted'])
        self.assertFalse(model_runtime.admission_window(utc(8, 42, second=1))['admitted'])
        for second in (0, 1, 15, 59):
            with self.subTest(second=second):
                window = model_runtime.admission_window(utc(8, 7, second=second))
                self.assertFalse(window['admitted'])
                self.assertEqual(window['retryNotBeforeUtc'], utc(8, 8).isoformat())
        self.assertTrue(model_runtime.admission_window(utc(8, 8))['admitted'])

    def test_budget_is_respected_not_a_fixed_minute_allowlist(self):
        self.assertTrue(model_runtime.admission_window(utc(8, 0), 30)['admitted'])
        self.assertFalse(model_runtime.admission_window(utc(8, 0), 1200)['admitted'])
        self.assertTrue(model_runtime.admission_window(utc(8, 30), 1800)['admitted'])
        self.assertFalse(model_runtime.admission_window(utc(8, 33), 1800)['admitted'])

    def test_dst_local_repeated_hour_does_not_move_utc_timer(self):
        for hour in (0, 1, 8, 23):
            instant = utc(hour, 30, day=25)
            local = instant.astimezone(paris_timezone())
            self.assertEqual(model_runtime.admission_window(instant), model_runtime.admission_window(local))
        summer = datetime(2026, 3, 29, 8, 30, tzinfo=timezone.utc)
        self.assertEqual(model_runtime.admission_window(summer), model_runtime.admission_window(summer.astimezone(paris_timezone())))

    def test_invalid_clock_and_budget_fail_closed(self):
        for instant in (None, '2026-10-23', datetime(2026, 10, 23)):
            with self.subTest(instant=instant), self.assertRaises(model_runtime.RuntimeUnavailable):
                model_runtime.admission_window(instant)
        for budget in (True, 0, 29, 1801, float('nan'), float('inf'), '1200'):
            with self.subTest(budget=budget), self.assertRaises(model_runtime.RuntimeUnavailable):
                model_runtime.admission_window(utc(8, 30), budget)

    def test_insufficient_window_never_acquires_locks_controls_model_or_sleeps(self):
        def forbidden(*args):
            raise AssertionError('Deferral must not lock, control a service or sleep')
        with self.assertRaises(model_runtime.RuntimeDeferred):
            with model_runtime.managed_model(clock=lambda: utc(8, 55), acquire=forbidden, control=forbidden, pause=forbidden):
                self.fail('No model lease allowed')

    def test_boundary_rechecked_after_lock_acquisition_and_locks_released(self):
        events = []
        clocks = iter([utc(8, 30), utc(8, 55)])
        @contextmanager
        def locks(paths):
            events.append('entered')
            try:
                yield
            finally:
                events.append('released')
        def forbidden(*args):
            raise AssertionError('No service call after the deadline moves')
        with self.assertRaises(model_runtime.RuntimeDeferred):
            with model_runtime.managed_model(clock=lambda: next(clocks), acquire=locks, control=forbidden):
                self.fail('No model lease allowed')
        self.assertEqual(events, ['entered', 'released'])


class RunnerAdmissionTests(unittest.TestCase):
    def test_light_collection_runs_but_late_window_defers_all_models_and_posts(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'WINTIPS_EDITORIAL_MANAGE_MODEL': 'true'}), \
                patch.object(runner, 'collect', return_value={'status': 'ready', 'items': [payload_item()], 'issues': []}) as collect, \
                patch.object(runner, 'make_translator', side_effect=AssertionError('No model on deferral')), \
                patch.object(model_runtime, 'shared_locks', side_effect=AssertionError('No shared lock on deferral')):
            api = Api()
            report = runner.run(arguments(directory, publish=True), fetcher=object(), now=utc(8, 30),
                                clock=lambda: utc(8, 55), api_client=api)
            self.assertEqual(collect.call_count, 1)
            self.assertEqual([r for r, _ in api.calls], ['/api/internal/editorial/config'])
            self.assertTrue(report['blocked'])
            self.assertEqual(report['deferred']['reason'], 'shared_worker_window_reserved')
            self.assertEqual(report['sources'][0]['status'], 'deferred_shared_window')
            self.assertFalse(report['published'])
            self.assertFalse(report['notificationsSent'])
            stored = json.loads((Path(directory) / 'last-run.json').read_text('utf-8'))
            self.assertEqual(stored['deferred'], report['deferred'])
            self.assertFalse((Path(directory) / 'editions/2026-10-23/rdj_turf_quinte.json').exists())

    def test_late_empty_source_does_not_drain_pending_pushes(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'WINTIPS_EDITORIAL_MANAGE_MODEL': 'true'}):
            api = Api(active=False)
            report = runner.run(arguments(directory, publish=True), fetcher=object(), now=utc(8, 30),
                                clock=lambda: utc(8, 55), api_client=api)
            self.assertEqual([r for r, _ in api.calls], ['/api/internal/editorial/config'])
            self.assertIn('deferred', report)

    def test_safe_window_keeps_normal_publish_and_source_clock_rules(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'WINTIPS_EDITORIAL_MANAGE_MODEL': 'true'}), \
                patch.object(runner, 'collect', return_value={'status': 'ready', 'items': [payload_item()], 'issues': []}):
            api = Api()
            report = runner.run(arguments(directory, publish=True), fetcher=object(), now=utc(8, 30),
                                clock=lambda: utc(8, 30), api_client=api, translator=TestTranslator())
            self.assertTrue(report['published'])
            self.assertEqual([r for r, _ in api.calls], ['/api/internal/editorial/config', '/api/internal/editorial/import', '/api/internal/editorial/notifications/drain'])

    def test_runtime_recheck_deferral_cancels_even_previously_cached_prepared_items(self):
        from editorial_worker import translation
        original = translation.translate_batch
        calls = []
        class Two(Api):
            def request(self, route, payload=None):
                result = super().request(route, payload)
                if route.endswith('/config'):
                    result['sources'].append({'key': 'rdj_petit_journal', 'categoryIds': ['other']})
                return result
        def collect(source, *args, **kwargs):
            item = deepcopy(payload_item())
            if source == 'rdj_petit_journal':
                item.update(source=source, sourceId='123456', sourceUrl='https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/123456-journal-23-octobre-2026.html')
            return {'status': 'ready', 'items': [item], 'issues': []}
        def translate(payload, translator):
            calls.append(payload['source'])
            if len(calls) == 2:
                model_runtime.require_admission(utc(8, 55))
            return original(payload, translator)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'WINTIPS_EDITORIAL_MANAGE_MODEL': 'true'}), \
                patch.object(runner, 'collect', side_effect=collect), patch.object(translation, 'translate_batch', side_effect=translate):
            api = Two()
            report = runner.run(arguments(directory, publish=True, source=['rdj_petit_journal', 'rdj_turf_quinte']),
                fetcher=object(), now=utc(8, 30), clock=lambda: utc(8, 30), api_client=api, translator=TestTranslator())
            self.assertEqual(len(calls), 2)
            self.assertEqual([r for r, _ in api.calls], ['/api/internal/editorial/config'])
            self.assertIn('deferred', report)
            self.assertFalse(report['published'])

    def test_runtime_cleanup_failure_never_imports_or_drains(self):
        def fail():
            raise RuntimeError('test cleanup failure')
        def factory(args, output, resources):
            resources.callback(fail)
            return TestTranslator()
        with tempfile.TemporaryDirectory() as directory, patch.object(runner, 'make_translator', side_effect=factory), \
                patch.object(runner, 'collect', return_value={'status': 'ready', 'items': [payload_item()], 'issues': []}):
            api = Api()
            report = runner.run(arguments(directory, publish=True), fetcher=object(), now=utc(8, 30), clock=lambda: utc(8, 30), api_client=api)
            self.assertIn('runtimeCleanupError', report)
            self.assertEqual([r for r, _ in api.calls], ['/api/internal/editorial/config'])


if __name__ == '__main__':
    unittest.main()
