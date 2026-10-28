"""Optional coupon copy orchestration; all cloud, hub and HTTP are mocked."""
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


TEASER = {'version': 'wintips-coupon-teaser-v1', 'sourceHash': 'a' * 64,
    'body': {'fr': 'Les ambitions de la soirée, entre forme du moment et nouveaux défis.',
             'en': 'Tonight’s ambitions, recent form and fresh challenges.'}}


class TeaserApi(fixtures.Api):
    def __init__(self, state='missing', copy_state='frozen'):
        super().__init__(); self.teaser_state = state; self.copy_state = copy_state

    def request(self, route, payload=None):
        result = super().request(route, payload)
        if route.endswith('/config'):
            for row in result['sources']:
                row['couponTeaserState'] = self.teaser_state
                row['editorialCopyState'] = {'state': self.copy_state, 'legacy': False}
        return result


class CouponTeaserRunnerTests(unittest.TestCase):
    def run_case(self, directory, api, **changes):
        return fixtures.BilingualRunnerTests().run_case(directory, api,
            fixtures.TestTranslator(), **changes)

    def mocked_modules(self, generate=None, fallback=None, validate=None, hub_value=None):
        hub = ModuleType('rdj_hub')
        copy = ModuleType('rdj_hub.editorial_copy')
        teaser = ModuleType('rdj_hub.coupon_teaser')
        copy.facts_from_wintips = lambda payload: {
            'source': payload['source'], 'items': deepcopy(payload.get('items', []))}
        teaser.facts_from_wintips = copy.facts_from_wintips
        teaser.generate = generate or (lambda *args, **kwargs: deepcopy(TEASER))
        teaser.fallback = fallback or (lambda *args: deepcopy(TEASER))
        teaser.validate_teaser = validate or (lambda *args: None)
        package = type('Package', (), {'open_hub': staticmethod(lambda *_: hub_value)})()
        return package, {'rdj_hub': hub, 'rdj_hub.editorial_copy': copy, 'rdj_hub.coupon_teaser': teaser}

    def translator(self, remaining=80):
        config = make_dataclass('TeaserConfig', [('max_seconds', float), ('request_timeout', float)])(180, 45)
        return type('Translator', (), {'config': config, 'remaining': lambda self: remaining})()

    def test_ten_matches_generate_one_global_teaser_before_preflight_import(self):
        count = 10
        rows = [deepcopy(fixtures.payload_item()) for _ in range(count)]
        for number, row in enumerate(rows): row['sourceId'] += '-' + str(number)
        seen = []
        def author(payload, translator):
            seen.append(len(payload['items']))
            return deepcopy(TEASER)
        def validator(payload, clock):
            self.assertEqual(payload['couponTeaser'], TEASER)
            self.assertEqual(len(payload['items']), count)
            return {'passed': True}
        with TemporaryDirectory() as directory, \
             patch.object(runner, 'collect', return_value={'status': 'ready', 'items': rows, 'issues': []}), \
             patch.object(runner, 'validate_item'), \
             patch.object(runner, 'build_coupon_teaser', side_effect=author):
            api = TeaserApi()
            result = runner.run(fixtures.arguments(directory, publish=True),
                fetcher=object(), api_client=api, translator=fixtures.TestTranslator(),
                api_validator=validator, now=fixtures.BilingualRunnerTests.clock(),
                clock=fixtures.BilingualRunnerTests.clock)
            posted = next(payload for route, payload in api.calls if route.endswith('/import'))
            self.assertEqual(posted['couponTeaser'], TEASER)
            self.assertEqual(seen, [10])
            self.assertTrue(result['published'])
            self.assertTrue(all(len(value) <= 100 for value in posted['couponTeaser']['body'].values()))
            self.assertEqual(posted['items'][0]['analysis']['fr'], rows[0]['analysis']['fr'])

    def test_missing_teaser_is_allowed_even_when_original_copy_is_frozen(self):
        with TemporaryDirectory() as directory, \
             patch.object(runner, 'build_editorial_copy', side_effect=AssertionError('Frozen copy must stay unchanged')) as old_copy, \
             patch.object(runner, 'build_coupon_teaser', return_value=deepcopy(TEASER)) as author:
            api = TeaserApi(state='missing', copy_state='frozen')
            result = self.run_case(directory, api, publish=True)
            old_copy.assert_not_called(); author.assert_called_once()
            posted = next(payload for route, payload in api.calls if route.endswith('/import'))
            self.assertEqual(posted['couponTeaser'], TEASER)
            self.assertNotIn('editorialCopy', posted)
            self.assertTrue(result['published'])

    def test_hourly_ready_unknown_or_absent_state_never_generates(self):
        for state in ['ready', 'unknown', None, '', {'state': 'missing'}]:
            with self.subTest(state=state), TemporaryDirectory() as directory, \
                 patch.object(runner, 'build_coupon_teaser', side_effect=AssertionError('Only missing may generate')) as author:
                api = TeaserApi(state=state)
                result = self.run_case(directory, api, publish=True)
                author.assert_not_called()
                self.assertTrue(result['published'])
                posted = next(payload for route, payload in api.calls if route.endswith('/import'))
                self.assertNotIn('couponTeaser', posted)

    def test_state_requires_one_source_and_current_edition(self):
        row = {'key': 'rdj_turf_quinte', 'couponTeaserState': 'missing'}
        valid = {'date': '2026-10-23', 'sources': [row]}
        self.assertTrue(runner.coupon_teaser_allowed(valid, row['key'], valid['date']))
        for value in [None, {}, {**valid, 'date': '2026-10-24'}, {**valid, 'sources': []},
                      {**valid, 'sources': None}, {**valid, 'sources': [row, row]},
                      {**valid, 'sources': [{'key': row['key']}]}]:
            self.assertFalse(runner.coupon_teaser_allowed(value, row['key'], '2026-10-23'))

    def test_cosmetic_exception_never_blocks_source_import_or_notification_drain(self):
        with TemporaryDirectory() as directory, \
             patch.object(runner, 'build_coupon_teaser', side_effect=ValueError('optional copy unavailable')):
            api = TeaserApi()
            result = self.run_case(directory, api, publish=True)
            self.assertTrue(result['published']); self.assertFalse(result.get('blocked', False))
            posted = next(payload for route, payload in api.calls if route.endswith('/import'))
            self.assertNotIn('couponTeaser', posted)
            self.assertEqual(posted['items'][0]['summary']['fr'], 'Deux chevaux.')
            self.assertEqual(posted['items'][0]['selection']['orderedNumbers'], [2, 1])
            self.assertEqual(api.calls[-1][0], '/api/internal/editorial/notifications/drain')

    def test_optional_gemini_call_shares_quota_hub_and_at_most_fifteen_seconds(self):
        calls = []
        def generate(facts, **kwargs):
            calls.append((facts, kwargs)); return deepcopy(TEASER)
        marker = object()
        package, modules = self.mocked_modules(generate=generate, hub_value=marker)
        with patch('editorial_worker.content_hub.module', return_value=package), \
             patch.dict(sys.modules, modules), patch.dict('os.environ', {
                 'WINTIPS_EDITORIAL_TRANSLATOR': 'gemini',
                 'WINTIPS_EDITORIAL_GEMINI_QUOTA_DIR': str(Path.cwd())}, clear=False):
            for remaining in [80, 4]:
                self.assertEqual(runner.build_coupon_teaser({'source': 'rdj_turf_quinte',
                    'editionDate': '2026-10-23', 'items': []}, self.translator(remaining)), TEASER)
        self.assertEqual(len(calls), 2)
        for expected, (_, kwargs) in zip([15, 4], calls):
            self.assertEqual(kwargs['config'].max_seconds, expected)
            self.assertEqual(kwargs['config'].request_timeout, expected)
            self.assertEqual(kwargs['quota_dir'], Path.cwd())
            self.assertIs(kwargs['hub'], marker)

    def test_generation_or_validation_failure_uses_validated_fallback(self):
        def unavailable(*args, **kwargs): raise ValueError('optional unavailable')
        for generate in [unavailable, lambda *args, **kwargs: {'invalid': True}]:
            validated = []
            def validate(facts, value):
                validated.append(value)
                if value != TEASER: raise ValueError('invalid cosmetic response')
            package, modules = self.mocked_modules(generate=generate, validate=validate, hub_value=object())
            with self.subTest(generate=generate), patch('editorial_worker.content_hub.module', return_value=package), \
                 patch.dict(sys.modules, modules), patch.dict('os.environ', {
                     'WINTIPS_EDITORIAL_TRANSLATOR': 'gemini',
                     'WINTIPS_EDITORIAL_GEMINI_QUOTA_DIR': str(Path.cwd())}):
                self.assertEqual(runner.build_coupon_teaser({'source': 'rdj_turf_quinte',
                    'editionDate': '2026-10-23'}, self.translator()), TEASER)
                self.assertEqual(validated[-1], TEASER)

    def test_exhausted_budget_or_missing_hub_uses_no_cloud_and_unavailable_fallback_omits_teaser(self):
        def no_cloud(*args, **kwargs): self.fail('Optional cloud must not be called')
        def no_fallback(*args): raise ValueError('No optional fallback')
        for remaining, hub_value in [(0, object()), (80, None)]:
            package, modules = self.mocked_modules(generate=no_cloud, hub_value=hub_value)
            with self.subTest(remaining=remaining), patch('editorial_worker.content_hub.module', return_value=package), \
                 patch.dict(sys.modules, modules), patch.dict('os.environ', {'WINTIPS_EDITORIAL_TRANSLATOR': 'gemini'}):
                self.assertEqual(runner.build_coupon_teaser({'source': 'rdj_turf_quinte',
                    'editionDate': '2026-10-23'}, self.translator(remaining)), TEASER)
        package, modules = self.mocked_modules(generate=no_cloud, fallback=no_fallback)
        with patch('editorial_worker.content_hub.module', return_value=package), patch.dict(sys.modules, modules):
            self.assertIsNone(runner.build_coupon_teaser({'source': 'rdj_turf_quinte',
                'editionDate': '2026-10-23'}, self.translator()))


if __name__ == '__main__': unittest.main()
