"""Offline process/runner contracts; no database, provider or HTTP call."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from editorial_worker import api_preflight as preflight, runner
from editorial_worker.calendar import edition_day
from test_bilingual_runner import Api, TestTranslator, arguments, payload_item


class PreflightProcessTests(unittest.TestCase):
    def setUp(self):
        self.payload = {'source': 'rdj_turf_quinte', 'editionDate': '2026-10-23', 'items': [payload_item()]}
        self.raw = preflight.payload_bytes(self.payload)

    def receipt(self, **updates):
        value = {'version': 'editorial-api-preflight-v1', 'passed': True,
            'payloadSha256': hashlib.sha256(self.raw).hexdigest(),
            'source': self.payload['source'], 'editionDate': self.payload['editionDate'], 'itemCount': 1,
            'checkout': {'head': '1' * 40, 'sourceSha256': {name: '2' * 64 for name in preflight.SOURCES}}}
        value.update(updates)
        return value

    def call(self, receipt=None, status=0, effect=None):
        done = SimpleNamespace(returncode=status, stdout=json.dumps(receipt if receipt is not None else self.receipt()).encode(), stderr=b'private-token-do-not-print')
        with patch.object(preflight.shutil, 'which', return_value='node-test'), \
                patch.object(preflight.subprocess, 'run', return_value=done, side_effect=effect) as process:
            result = preflight.validate_api_payload(self.payload)
        return result, process

    def test_exact_payload_bound_receipt_and_no_shell_or_cli_secrets(self):
        before = deepcopy(self.payload)
        result, process = self.call()
        self.assertTrue(result['passed'])
        args, kwargs = process.call_args
        self.assertEqual(args[0][0], 'node-test')
        self.assertEqual(Path(args[0][1]).name, 'validate-api-payload.cjs')
        self.assertEqual(kwargs['input'], self.raw)
        self.assertFalse(kwargs['shell'])
        self.assertEqual(kwargs['timeout'], 20)
        self.assertEqual(Path(kwargs['cwd']), Path(args[0][1]).parent)
        self.assertEqual(self.payload, before)
        self.assertNotIn('private-token', json.dumps(result))

    def test_missing_node_and_timeout_block_without_leaking_child_details(self):
        with patch.object(preflight.shutil, 'which', return_value=None), \
                patch.object(preflight.subprocess, 'run', side_effect=AssertionError('must not start')):
            with self.assertRaises(preflight.ApiPreflightRejected) as caught:
                preflight.validate_api_payload(self.payload)
        self.assertEqual(caught.exception.code, 'api_validator_unavailable')
        with self.assertRaises(preflight.ApiPreflightRejected) as caught:
            self.call(effect=subprocess.TimeoutExpired(['node'], 20, stderr=b'private-token'))
        self.assertEqual(str(caught.exception), 'api_validator_timeout')

    def test_unknown_stdout_malformed_and_failed_process_never_pass(self):
        for raw in (b'not json private-token', b'[]', b'{"passed":true}', b'x' * 1_000_001):
            with self.subTest(raw=raw[:30]), patch.object(preflight.shutil, 'which', return_value='node-test'), \
                    patch.object(preflight.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=raw, stderr=b'private-token')):
                with self.assertRaises(preflight.ApiPreflightRejected) as caught:
                    preflight.validate_api_payload(self.payload)
                self.assertEqual(caught.exception.code, 'api_validator_receipt_invalid')
                self.assertNotIn('private-token', str(caught.exception))
        with self.assertRaises(preflight.ApiPreflightRejected) as caught:
            self.call(status=1)
        self.assertEqual(caught.exception.code, 'api_validator_rejected')

    def test_success_requires_payload_and_same_checkout_bindings(self):
        changes = [{'payloadSha256': '3' * 64}, {'source': 'other'}, {'editionDate': '2026-10-24'},
            {'itemCount': 2}, {'checkout': {}}, {'checkout': {'head': 'not-git', 'sourceSha256': {}}},
            {'checkout': {'head': '1' * 40, 'sourceSha256': {'wrong' + str(i): '2' * 64 for i in range(5)}}}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(preflight.ApiPreflightRejected) as caught:
                self.call(self.receipt(**change))
            self.assertEqual(caught.exception.code, 'api_validator_receipt_binding_invalid')

    def test_copy_coupon_teaser_and_journal_clock_validators_are_part_of_the_exact_checkout_pins(self):
        for name in ['src/api/services/common/editorialCopy.js',
                     'src/api/services/common/couponTeaser.js',
                     'src/api/services/common/petitJournalClockProof.js']:
            with self.subTest(name=name):
                self.assertIn(name, preflight.SOURCES)
                receipt = self.receipt()
                del receipt['checkout']['sourceSha256'][name]
                with self.assertRaises(preflight.ApiPreflightRejected) as caught:
                    self.call(receipt)
                self.assertEqual(caught.exception.code, 'api_validator_receipt_binding_invalid')

    def test_rejected_fields_preserved_without_backend_prose(self):
        receipt = self.receipt(passed=False, code='api_complete_english_invalid', diagnostics=[{
            'sourceId': '2026-10-23-R1C4', 'field': 'analysis[0].paragraphs[1]',
            'code': 'english_field_missing_or_numeric_mismatch'}])
        with self.assertRaises(preflight.ApiPreflightRejected) as caught:
            self.call(receipt, status=1)
        self.assertEqual(caught.exception.code, 'api_complete_english_invalid')
        self.assertEqual(caught.exception.audit, receipt)


class RunnerPreflightTests(unittest.TestCase):
    clock = staticmethod(lambda: datetime(2026, 10, 23, 8, tzinfo=timezone.utc))

    def run_case(self, directory, api, validator, sources=None, translator=None):
        def collect(source, *args, **kwargs):
            item = deepcopy(payload_item())
            if source == 'rdj_petit_journal':
                item.update(source=source, sourceId='123456', sourceUrl='https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/123456-journal-23-octobre-2026.html')
            return {'status': 'ready', 'items': [item], 'issues': []}
        with patch.object(runner, 'collect', side_effect=collect):
            return runner.run(arguments(directory, publish=True, source=sources), fetcher=object(),
                api_client=api, translator=translator, api_validator=validator, now=self.clock(), clock=self.clock)

    def test_actual_default_validator_is_mandatory_and_failure_never_imports(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(preflight, 'validate_api_payload', side_effect=preflight.ApiPreflightRejected('api_validator_unavailable')) as checked:
            api = Api()
            result = self.run_case(directory, api, None, translator=TestTranslator())
        self.assertEqual(checked.call_count, 1)
        self.assertFalse(any(route.endswith('/import') for route, _ in api.calls))
        self.assertTrue(result['blocked'])
        self.assertIn('api_validator_unavailable', result['sources'][0]['issues'])

    def test_every_source_checked_immediately_before_its_import_after_resources_close(self):
        events = []
        class OrderedApi(Api):
            def request(self, route, payload=None):
                if route.endswith('/config'):
                    out = super().request(route, payload)
                    out['sources'].append({'key': 'rdj_petit_journal', 'categoryIds': ['other']})
                    return out
                if route.endswith('/import'):
                    self.assert_ready = (events[-1] == 'validate:' + payload['source'])
                    if not self.assert_ready: raise AssertionError('must validate each exact batch before POST')
                    events.append('post:' + payload['source'])
                return super().request(route, payload)
        def factory(args, output, resources):
            resources.callback(lambda: events.append('closed'))
            return TestTranslator()
        def validator(payload, now):
            self.assertIn('closed', events)
            self.assertEqual(now, self.clock())
            self.assertIn('en', payload['items'][0]['analysis'])
            events.append('validate:' + payload['source'])
            return {'passed': True}
        with tempfile.TemporaryDirectory() as directory, patch.object(runner, 'make_translator', side_effect=factory):
            result = self.run_case(directory, OrderedApi(), validator,
                sources=['rdj_turf_quinte', 'rdj_petit_journal'])
        self.assertEqual(events, ['closed', 'validate:rdj_petit_journal', 'post:rdj_petit_journal',
            'validate:rdj_turf_quinte', 'post:rdj_turf_quinte'])
        self.assertTrue(result['published'])

    def test_one_rejected_batch_never_posts_but_other_valid_source_can_continue(self):
        class Two(Api):
            def request(self, route, payload=None):
                out = super().request(route, payload)
                if route.endswith('/config'): out['sources'].append({'key': 'rdj_petit_journal', 'categoryIds': ['other']})
                return out
        def validator(payload, now):
            if payload['source'] == 'rdj_petit_journal':
                raise preflight.ApiPreflightRejected('api_complete_english_invalid', {'passed': False, 'diagnostics': [{'field': 'summary'}]})
            return {'passed': True}
        with tempfile.TemporaryDirectory() as directory:
            api = Two()
            result = self.run_case(directory, api, validator, sources=['rdj_turf_quinte', 'rdj_petit_journal'], translator=TestTranslator())
        self.assertEqual([payload['source'] for route, payload in api.calls if route.endswith('/import')], ['rdj_turf_quinte'])
        self.assertTrue(result['blocked'])
        self.assertFalse(result['sources'][0]['imported'])
        self.assertEqual(result['sources'][0]['apiPreflight']['diagnostics'], [{'field': 'summary'}])

    def test_preview_never_invokes_node_validator_or_posts(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runner, 'collect', return_value={'status': 'ready', 'items': [payload_item()], 'issues': []}), \
                patch.object(preflight, 'validate_api_payload', side_effect=AssertionError('no Node for preview')):
            api = Api()
            result = runner.run(arguments(directory, translate=True), fetcher=object(), api_client=api,
                translator=TestTranslator(), now=self.clock(), clock=self.clock)
        self.assertFalse(result['published'])
        self.assertEqual(len(api.calls), 1)

    def test_http_success_ignored_is_not_reported_as_imported_or_published(self):
        outcome = {'ignored': True, 'reason': 'category_inactive', 'imported': 0}
        class Ignored(Api):
            def request(self, route, payload=None):
                if route.endswith('/import'):
                    self.calls.append((route, deepcopy(payload)))
                    return deepcopy(outcome)
                return super().request(route, payload)
        with tempfile.TemporaryDirectory() as directory:
            api = Ignored()
            result = self.run_case(directory, api, lambda *args: {'passed': True}, translator=TestTranslator())
        self.assertFalse(result['sources'][0]['imported'])
        self.assertFalse(result['published'])
        self.assertEqual(result['sources'][0]['apiResult'], outcome)
        self.assertEqual(sum(route.endswith('/import') for route, _ in api.calls), 1)

    def test_real_node_cli_receipt_is_accepted_by_default_python_runner_before_import(self):
        """Exercise both contract owners, not a fabricated accepted receipt.

        Only the isolated test checkout receives a synthetic local Git commit.
        The API client is an in-memory recorder; no HTTP/model/push is used.
        """
        root = Path(__file__).resolve().parents[3]
        now = datetime.now(timezone.utc)
        edition = edition_day(now)
        next_day = edition + timedelta(days=1)
        instant = datetime.combine(next_day, datetime.min.time(), tzinfo=timezone.utc).replace(hour=14, minute=30)
        clock = instant.replace(tzinfo=None).isoformat()
        months = ('janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre')
        journal = f'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/74999-journal-{edition.day}-{months[edition.month-1]}-{edition.year}.html'
        item = {'source': 'rdj_petit_journal', 'editionDate': edition.isoformat(), 'sourceId': '6014934',
            'sourceUrl': journal, 'kind': 'match', 'title': {'fr': 'Toronto — Orlando', 'en': 'Toronto — Orlando'},
            'summary': {'fr': 'Le programme source.', 'en': 'The source programme.'},
            'startsAtUtc': instant.isoformat().replace('+00:00', 'Z'), 'status': 'upcoming',
            'sport': {'key': 'basketball', 'name': 'Basketball'}, 'competition': {'name': 'NBA'},
            'teams': {'home': {'name': 'Toronto'}, 'away': {'name': 'Orlando'}},
            'analysis': {'fr': [{'heading': 'Le contexte', 'paragraphs': ['Analyse source intégrale.']}],
                'en': [{'heading': 'Context', 'paragraphs': ['Complete source analysis.']}]},
            'selection': {'label': {'fr': 'Victoire Toronto', 'en': 'Toronto win'}, 'odds': 1.7},
            'editionConvention': 'journal_following_day',
            'scheduleProof': {'sourceUrl': journal, 'sourceId': '6014934', 'method': 'rdj_journal_clock', 'provider': 'rdj',
                'editionDate': edition.isoformat(), 'matchedParticipants': ['Toronto', 'Orlando'],
                'startsAtUtc': instant.isoformat().replace('+00:00', 'Z'), 'status': 'upcoming',
                'journalClock': clock, 'detailClock': clock}}
        class RecordedApi:
            def __init__(self): self.calls = []
            def request(self, route, payload=None):
                self.calls.append((route, deepcopy(payload)))
                if route.endswith('/config'):
                    return {'date': edition.isoformat(), 'importEnabled': True, 'notificationsEnabled': False,
                        'sources': [{'key': 'rdj_petit_journal', 'categoryIds': ['a' * 24]}]}
                if route.endswith('/import'): return {'imported': 1, 'notificationsSent': 0}
                raise AssertionError('unexpected API route: ' + route)
        with tempfile.TemporaryDirectory() as checkout, tempfile.TemporaryDirectory() as output:
            checkout = Path(checkout).resolve()
            for relative in preflight.SOURCES:
                target = checkout / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(root / relative, target)
            module_path = checkout / 'tools/wintips-editorial-worker/editorial_worker/api_preflight.py'
            module_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(Path(preflight.__file__), module_path)
            def git(*args):
                return subprocess.run(['git', *args], cwd=checkout, check=True, capture_output=True, timeout=20)
            git('init', '--quiet')
            git('config', 'core.autocrlf', 'false')
            git('add', '.')
            git('-c', 'user.name=Local test', '-c', 'user.email=local-test@example.invalid', 'commit', '--quiet', '-m', 'Isolated validator fixture')
            api = RecordedApi()
            with patch.object(preflight, '__file__', str(module_path)), \
                    patch.dict(os.environ, {'RDJ_CONTENT_HUB_DIR': ''}), \
                    patch.object(runner, 'collect', return_value={'status': 'ready', 'items': [item], 'issues': []}):
                report = runner.run(arguments(output, edition=edition.isoformat(), source=['rdj_petit_journal'], publish=True),
                    fetcher=object(), now=now, clock=lambda: now, api_client=api)
            self.assertTrue(report['published'], report)
            self.assertFalse(report.get('blocked', False), report)
            receipt = report['sources'][0]['apiPreflight']
            self.assertTrue(receipt['passed'])
            self.assertEqual(set(receipt['checkout']['sourceSha256']), preflight.SOURCES)
            self.assertIn('src/api/services/common/petitJournalClockProof.js', receipt['checkout']['sourceSha256'])
            self.assertEqual([route for route, _ in api.calls], ['/api/internal/editorial/config', '/api/internal/editorial/import'])


class ApiHttpDiagnosticsTests(unittest.TestCase):
    def request_failure(self, status, body):
        client = runner.ApiClient('https://api.invalid', 'private-token-do-not-print')
        error = HTTPError('https://api.invalid/private-token', status, 'private-token', {}, io.BytesIO(body))
        with patch.object(client.opener, 'open', side_effect=error) as opened:
            with self.assertRaises(runner.ApiHttpError) as caught:
                client.request('/api/internal/editorial/import', {'items': []})
        self.assertEqual(opened.call_count, 1)
        self.assertTrue(error.fp.closed)
        self.assertNotIn('private-token', str(caught.exception))
        return caught.exception

    def test_400_only_known_short_code_and_never_message(self):
        failure = self.request_failure(400, b'{"error":{"code":"VALIDATION_ERROR","message":"private-token"}}')
        self.assertEqual(failure.http_diagnostic, {'status': 400, 'apiCode': 'VALIDATION_ERROR'})
        failure = self.request_failure(400, b'{"error":{"code":400,"message":"private-token"}}')
        self.assertEqual(failure.http_diagnostic, {'status': 400, 'apiCode': 400})

    def test_401_unknown_code_and_malformed_json_never_leak(self):
        for body in (b'{"error":{"code":"private-token","message":"private-token"}}',
                b'private-token malformed', b'{"error":{"code":"SECRET_TOKEN"}}',
                b'{"error":{"code":123456789}}', b'{"error": ["private-token"]}', b'x' * 16_385):
            with self.subTest(body=body[:60]):
                failure = self.request_failure(401, body)
                self.assertEqual(failure.http_diagnostic, {'status': 401})
                self.assertEqual(runner.safe_reason(failure), 'api_http_401')

    def test_runner_persists_status_and_code_without_overwriting_preflight(self):
        class Broken(Api):
            def request(self, route, payload=None):
                if route.endswith('/import'): raise runner.ApiHttpError(503, 'SERVICE_UNAVAILABLE')
                return super().request(route, payload)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runner, 'collect', return_value={'status': 'ready', 'items': [payload_item()], 'issues': []}):
            result = runner.run(arguments(directory, publish=True), fetcher=object(), api_client=Broken(),
                translator=TestTranslator(), now=RunnerPreflightTests.clock(), clock=RunnerPreflightTests.clock,
                api_validator=lambda *args: {'passed': True})
            stored = json.loads((Path(directory) / 'last-run.json').read_text('utf-8'))
        self.assertEqual(stored, result)
        self.assertEqual(result['sources'][0]['apiHttpError'], {'status': 503, 'apiCode': 'SERVICE_UNAVAILABLE'})
        self.assertEqual(result['sources'][0]['apiPreflight'], {'passed': True})
        self.assertIn('api_http_503', result['sources'][0]['issues'])


if __name__ == '__main__': unittest.main()
