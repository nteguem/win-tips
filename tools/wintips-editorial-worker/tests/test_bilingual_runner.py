from argparse import Namespace
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from editorial_worker import runner, model_runtime
from editorial_worker.translation import TranslationRejected


def payload_item():
    return {'source': 'rdj_turf_quinte', 'editionDate': '2026-10-23',
        'sourceId': '2026-10-23-R1C4',
        'sourceUrl': 'https://www.ruedesjoueurs.com/turf/pronostic-turf/course/23-10-2026/R1/C4/prix-orionis.html',
        'kind': 'horse_racing', 'title': {'fr': 'Course de test'}, 'summary': {'fr': 'Deux chevaux.'},
        'startsAtUtc': '2026-10-23T18:15:00Z', 'status': 'upcoming',
        'sport': {'key': 'horse_racing', 'name': 'Courses hippiques'},
        'race': {'name': 'Prix test', 'racecourse': 'Test', 'runners': []},
        'analysis': {'fr': [{'heading': 'Le contexte', 'paragraphs': ['Analyse de test.']}]},
        'selection': {'label': {'fr': 'Sélection de test'}, 'orderedNumbers': [2, 1], 'odds': None}}


class TestTranslator:
    """Explicit test double, never used as a model-quality or live-content proof."""
    records = []
    texts = {'Course de test': 'Test race', 'Deux chevaux.': 'Two horses.',
             'Le contexte': 'Context', 'Analyse de test.': 'Test analysis.'}
    def text(self, source, item):
        return self.texts[source]
    def market(self, source, item):
        return 'Test selection'


def api_validation_fixture(payload, now=None):
    """Orchestration-only stub; these small payloads are not API-schema proofs."""
    return {'passed': True}


class Api:
    def __init__(self, active=True):
        self.calls = []
        self.active = active
    def request(self, route, payload=None):
        self.calls.append((route, deepcopy(payload)))
        if route.endswith('/config'):
            return {'date': '2026-10-23', 'importEnabled': True, 'notificationsEnabled': True,
                    'sources': [{'key': 'rdj_turf_quinte', 'categoryIds': ['test']}] if self.active else []}
        if route.endswith('/import'):
            return {'imported': 1, 'notificationsSent': 1}
        if route.endswith('/notifications/drain'):
            return {'sent': 0, 'pending': 0}
        raise AssertionError(route)


def arguments(directory, **changes):
    result = Namespace(edition='2026-10-23', source=['rdj_turf_quinte'], output=str(directory), api_base='http://localhost:4300',
        publish=False, translate=False, minimum_lead_minutes=30, max_requests=40, max_seconds=240, cache_ttl_seconds=600)
    for key, value in changes.items():
        setattr(result, key, value)
    return result


class BilingualRunnerTests(unittest.TestCase):
    clock = staticmethod(lambda: datetime(2026, 10, 23, 8, tzinfo=timezone.utc))
    def run_case(self, directory, api, translator, **changes):
        with patch.object(runner, 'collect', return_value={'status': 'ready', 'items': [payload_item()], 'issues': []}):
            return runner.run(arguments(directory, **changes), fetcher=type('Fetch', (), {'requests': 0, 'records': []})(),
                now=self.clock(), clock=self.clock, api_client=api, translator=translator, api_validator=api_validation_fixture)

    def test_translated_preview_adds_real_fields_without_any_post(self):
        with tempfile.TemporaryDirectory() as directory:
            api = Api()
            report = self.run_case(directory, api, TestTranslator(), translate=True)
            result = json.loads(Path(report['sources'][0]['payloadFile']).read_text('utf-8'))
            self.assertEqual(result['items'][0]['analysis']['en'][0]['paragraphs'], ['Test analysis.'])
            self.assertEqual(result['items'][0]['analysis']['fr'], payload_item()['analysis']['fr'])
            self.assertEqual(result['items'][0]['selection']['orderedNumbers'], [2, 1])
            self.assertEqual([route for route, _ in api.calls], ['/api/internal/editorial/config'])
            self.assertFalse(report['notificationsSent'])

    def test_publish_requires_bilingual_and_reports_only_provider_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            api = Api()
            report = self.run_case(directory, api, TestTranslator(), publish=True)
            self.assertEqual([route for route, _ in api.calls], ['/api/internal/editorial/config', '/api/internal/editorial/import', '/api/internal/editorial/notifications/drain'])
            self.assertEqual(api.calls[1][1]['items'][0]['title']['en'], 'Test race')
            self.assertEqual(api.calls[2][1], {'dryRun': False})
            self.assertEqual(report['notificationsAccepted'], 1)
            self.assertTrue(report['notificationsSent'])

    def test_translation_failure_never_posts_french_only_content(self):
        class Broken(TestTranslator):
            def text(self, *args):
                raise TranslationRejected('fixture_translation_rejected')
        with tempfile.TemporaryDirectory() as directory:
            api = Api()
            report = self.run_case(directory, api, Broken(), publish=True)
            self.assertTrue(report['blocked'])
            self.assertFalse(any(route.endswith('/import') for route, _ in api.calls))
            self.assertEqual(report['sources'][0]['status'], 'translation_blocked')
            self.assertFalse((Path(directory) / 'editions/2026-10-23/rdj_turf_quinte.json').exists())

    def test_empty_collection_still_drains_existing_pending_notifications(self):
        with tempfile.TemporaryDirectory() as directory:
            api = Api(active=False)
            report = self.run_case(directory, api, TestTranslator(), publish=True)
            self.assertEqual(api.calls[-1], ('/api/internal/editorial/notifications/drain', {'dryRun': False}))
            self.assertFalse(report['published'])

    def test_model_factory_not_called_when_source_absent(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(runner, 'make_translator', side_effect=AssertionError('No model for absent source')):
            self.run_case(directory, Api(active=False), None, publish=True)

    def test_parser_failure_is_unhealthy_but_pending_notifications_still_drain(self):
        with tempfile.TemporaryDirectory() as directory:
            api = Api()
            with patch.object(runner, 'collect', return_value={'status': 'source_incomplete', 'items': [], 'issues': [{'code': 'fixture_changed_layout'}]}):
                result = runner.run(arguments(directory, publish=True), fetcher=type('Fetch', (), {'requests': 0, 'records': []})(),
                    now=self.clock(), clock=self.clock, api_client=api, translator=TestTranslator())
            self.assertTrue(result['blocked'])
            self.assertFalse(result['published'])
            self.assertEqual(api.calls[-1][0], '/api/internal/editorial/notifications/drain')

    def test_one_broken_source_does_not_prevent_the_next_import_or_notification_retry(self):
        class TwoSources(Api):
            def request(self, route, payload=None):
                result = super().request(route, payload)
                if route.endswith('/config'):
                    result['sources'].append({'key': 'rdj_petit_journal', 'categoryIds': ['other']})
                return result
        for malformed in (False, True):
            with self.subTest(malformed=malformed), tempfile.TemporaryDirectory() as directory:
                api = TwoSources()
                def collect(source, *args, **kwargs):
                    if source == 'rdj_petit_journal':
                        if not malformed:
                            raise ValueError('fixture_broken_source')
                        return {'status': 'ready', 'items': [payload_item()], 'issues': []}
                    return {'status': 'ready', 'items': [payload_item()], 'issues': []}
                with patch.object(runner, 'collect', side_effect=collect):
                    result = runner.run(arguments(directory, publish=True, source=['rdj_petit_journal', 'rdj_turf_quinte']),
                        fetcher=type('Fetch', (), {'requests': 0, 'records': []})(), now=self.clock(), clock=self.clock,
                        api_client=api, translator=TestTranslator(), api_validator=api_validation_fixture)
                self.assertEqual(result['sources'][0]['status'], 'source_blocked')
                self.assertTrue(result['sources'][1]['imported'])
                self.assertEqual(api.calls[-1][0], '/api/internal/editorial/notifications/drain')

    def test_model_resources_are_released_before_import_or_provider_wait(self):
        events = []
        class OrderedApi(Api):
            def request(self, route, payload=None):
                if payload is not None:
                    self.assert_closed = 'closed' in events
                    if not self.assert_closed:
                        raise AssertionError('Model resources still held during API call')
                return super().request(route, payload)
        def factory(args, output, resources):
            resources.callback(lambda: events.append('closed'))
            return TestTranslator()
        with tempfile.TemporaryDirectory() as directory, patch.object(runner, 'make_translator', side_effect=factory):
            api = OrderedApi()
            result = self.run_case(directory, api, None, publish=True)
            self.assertTrue(result['sources'][0]['imported'])
            self.assertEqual(events, ['closed'])


@contextmanager
def fake_locks(paths):
    yield


class RuntimeLeaseTests(unittest.TestCase):
    clock = staticmethod(lambda: datetime(2026, 10, 23, 8, 30, tzinfo=timezone.utc))
    def control(self, initial=False, shared=False):
        self.actions = []
        def run(action, unit):
            self.actions.append((action, unit))
            if action == 'is-active':
                return shared if unit == model_runtime.SHARED_JOB else initial
            return True
        return run

    def test_owned_runtime_stops_on_failure_and_releases_ram(self):
        control = self.control()
        with self.assertRaisesRegex(ValueError, 'fixture'):
            with model_runtime.managed_model(control=control, healthy=lambda: True, acquire=fake_locks, clock=self.clock):
                raise ValueError('fixture')
        self.assertIn(('start', model_runtime.MODEL), self.actions)
        self.assertIn(('stop', model_runtime.MODEL), self.actions)

    def test_existing_runtime_is_never_stopped(self):
        with model_runtime.managed_model(control=self.control(initial=True), healthy=lambda: True, acquire=fake_locks, clock=self.clock):
            pass
        self.assertNotIn(('stop', model_runtime.MODEL), self.actions)

    def test_active_shared_journal_blocks_model_start(self):
        with self.assertRaises(model_runtime.RuntimeUnavailable):
            with model_runtime.managed_model(control=self.control(shared=True), healthy=lambda: True, acquire=fake_locks, clock=self.clock):
                self.fail('A shared journal is already running')
        self.assertNotIn(('start', model_runtime.MODEL), self.actions)


if __name__ == '__main__':
    unittest.main()
