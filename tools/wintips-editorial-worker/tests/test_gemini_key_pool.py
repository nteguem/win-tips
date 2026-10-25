"""Credential fallback doubles only; no network or production credentials."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from editorial_worker import gemini_translation as g
from editorial_worker.translation import TranslationRejected


PRIMARY = 'primarySyntheticNotARealSecret12345'
BACKUP = 'AQ.backupSyntheticNotARealSecret12345'
OTHER = 'thirdSyntheticNotARealSecret12345'


class Transport:
    def __init__(self, callback):
        self.callback, self.calls, self.key, self.feedback = callback, [], None, None

    def set_key(self, key): self.key = key
    def set_feedback(self, feedback): self.feedback = feedback

    def __call__(self, texts, timeout):
        self.calls.append((self.key, texts, self.feedback))
        return self.callback(self, texts, timeout)


class GeminiKeyPoolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.instant = datetime(2026, 10, 25, 12, tzinfo=timezone.utc)
        self.config = g.GeminiConfig(PRIMARY, fallback_keys=(BACKUP,))
        self.source = 'Liverpool occupe la 1\u00e8re place avec 9 points apr\u00e8s un match (0-3).'
        self.item = {'home': 'Liverpool', 'away': 'Brighton', 'competition': 'Premier League',
            'teams': {'home': {'name': 'Liverpool'}, 'away': {'name': 'Brighton'}}}
        self.pauses = []

    def good(self, texts, ids=None):
        values = [text.replace(' occupe la ', ' occupies ').replace(' avec ', ' with ')
            .replace(' points apr\u00e8s ', ' points after ') for text in texts]
        return {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': json.dumps({
            'translations': [{'id': str(i) if ids is None else ids[i], 'text': value}
                for i, value in enumerate(values)]})}]}}]}

    def daily(self, kind='RPD', seconds=100):
        return g.GeminiFailure(429, seconds, {'quotaTypes': [kind], 'bodyStatus': 'parsed'})

    def translator(self, transport, config=None):
        return g.GeminiTranslator(config or self.config, cache_dir=self.root / 'cache',
            quota_dir=self.root / 'quota', request=transport, now=lambda: self.instant, sleep=self.pauses.append)

    def run_job(self, translator):
        job = translator.job(self.source, self.item)
        translator.send([job])
        return job

    def assert_private_evidence_has_no_credentials(self):
        for path in self.root.rglob('*.json'):
            value = path.read_text('utf-8')
            for key in (PRIMARY, BACKUP, OTHER): self.assertNotIn(key, value)

    def test_formats_deduplication_bounds_and_repr_do_not_expose_keys(self):
        config = g.GeminiConfig(PRIMARY, fallback_keys=(PRIMARY, BACKUP, BACKUP))
        self.assertEqual(g.credentials(config), (PRIMARY, BACKUP))
        for key in g.credentials(config): self.assertNotIn(key, repr(config))
        for fallback in ([BACKUP], (BACKUP,) * 4, ('bad',), ('AQ.bad\nheader',), (None,)):
            with self.subTest(fallback_type=type(fallback).__name__), self.assertRaises(TranslationRejected):
                g.GeminiConfig(PRIMARY, fallback_keys=fallback)
        for key in ('AQ.syntheticNotARealSecret12345', PRIMARY): g.GeminiConfig(key)
        for key in ('bad.prefix.with.dots1234567890', 'AQ.abcdefghijklmno', 'AQ.abcdef\nheaderValue12345'):
            with self.assertRaises(TranslationRejected): g.GeminiConfig(key)

    def test_env_helper_does_not_log_and_preserves_explicit_fallback_order(self):
        with patch.dict(os.environ, {'GEMINI_API_KEY_FALLBACK': ' ' + BACKUP + ' , ' + OTHER + ' '}, clear=True):
            self.assertEqual(g.fallback_keys_from_env(), (BACKUP, OTHER))
        with patch.dict(os.environ, {}, clear=True): self.assertEqual(g.fallback_keys_from_env(), ())

    def test_primary_success_never_uses_backup(self):
        transport = Transport(lambda _, texts, timeout: self.good(texts))
        t = self.translator(transport); self.run_job(t)
        self.assertEqual([call[0] for call in transport.calls], [PRIMARY])
        self.assertEqual([row['credentialOrdinal'] for row in t.attempts], [0])
        self.assert_private_evidence_has_no_credentials()

    def test_daily_quota_falls_back_once_and_reserves_full_prompt_for_each_physical_request(self):
        def request(transport, texts, timeout):
            if transport.key == PRIMARY: raise self.daily()
            return self.good(texts)
        transport = Transport(request); t = self.translator(transport); self.run_job(t)
        self.assertEqual([call[0] for call in transport.calls], [PRIMARY, BACKUP])
        self.assertEqual(t.requests, 2); self.assertEqual(self.pauses, [])
        self.assertTrue(t.attempts[0]['credentialFailoverScheduled'])
        usage = json.loads((self.root / 'quota/usage.json').read_bytes())
        self.assertEqual(usage['days']['2026-10-25'], sum(row['inputCharactersReserved'] for row in t.attempts))
        self.assert_private_evidence_has_no_credentials()

    def test_daily_token_quota_also_selects_backup_and_records_exact_kind(self):
        def request(transport, texts, timeout):
            if transport.key == PRIMARY: raise self.daily('TPD')
            return self.good(texts)
        transport = Transport(request); t = self.translator(transport); self.run_job(t)
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(t.attempts[0]['providerCooldown']['quotaTypes'], ['TPD'])

    def test_both_keys_exhausted_do_not_loop_or_cache_or_reset_usage(self):
        transport = Transport(lambda *_: (_ for _ in ()).throw(self.daily()))
        t = self.translator(transport)
        with self.assertRaises(TranslationRejected) as caught: self.run_job(t)
        self.assertEqual(caught.exception.code, 'gemini_daily_request_quota_exhausted')
        self.assertEqual([call[0] for call in transport.calls], [PRIMARY, BACKUP])
        before = (self.root / 'quota/usage.json').read_bytes()
        other = self.translator(Transport(lambda *_: self.fail('All keys remain cooling')))
        with self.assertRaises(TranslationRejected): self.run_job(other)
        self.assertEqual((self.root / 'quota/usage.json').read_bytes(), before)
        self.assertEqual(list((self.root / 'cache').rglob('responses/*.json')), [])

    def test_zero_delay_does_not_retry_exhausted_key_within_invocation(self):
        transport = Transport(lambda *_: (_ for _ in ()).throw(self.daily(seconds=0)))
        t = self.translator(transport)
        with self.assertRaises(TranslationRejected): self.run_job(t)
        self.assertEqual([call[0] for call in transport.calls], [PRIMARY, BACKUP])
        self.assertEqual(self.pauses, [])

    def test_legacy_model_cooldown_only_blocks_primary_and_expiry_does_not_reset_usage(self):
        t = self.translator(Transport(lambda *_: self.fail('Unused')))
        t.cooldown.remember(self.config.model, 100)
        transport = Transport(lambda _, texts, timeout: self.good(texts))
        warm = self.translator(transport); self.run_job(warm)
        self.assertEqual([call[0] for call in transport.calls], [BACKUP])
        self.instant += timedelta(seconds=100)
        self.assertEqual(g.GeminiKeyPool(self.config, self.root / 'quota', lambda: self.instant).select(), (0, PRIMARY))

    def test_shared_scoped_cooldown_survives_credential_reordering_and_keeps_longest_delay(self):
        pool = g.GeminiKeyPool(self.config, self.root / 'quota', lambda: self.instant)
        first = pool.remember(1, 100)
        other = g.GeminiKeyPool(replace(self.config, key=BACKUP, fallback_keys=(PRIMARY,)),
            self.root / 'quota', lambda: self.instant)
        self.assertEqual(other.remember(0, 10), first)
        self.assertEqual(other.select(), (1, PRIMARY))

    def test_global_character_cap_blocks_both_keys_before_transport(self):
        transport = Transport(lambda *_: self.fail('Global cap must prevent every credential'))
        t = self.translator(transport, replace(self.config, daily_characters=10, monthly_characters=20))
        with self.assertRaises(TranslationRejected) as caught: self.run_job(t)
        self.assertEqual(caught.exception.code, 'gemini_character_quota_exhausted')
        self.assertEqual(t.requests, 0); self.assertEqual(transport.calls, [])
        self.assertFalse((self.root / 'quota/usage.json').exists())

    def test_request_and_retry_caps_still_bound_failover(self):
        for config in (replace(self.config, max_requests=1), replace(self.config, retries=0)):
            transport = Transport(lambda *_: (_ for _ in ()).throw(self.daily(seconds=0)))
            t = self.translator(transport, config)
            with self.assertRaises(TranslationRejected): self.run_job(t)
            self.assertEqual(len(transport.calls), 1)

    def test_global_spend_cap_after_failed_primary_cannot_be_bypassed_by_backup(self):
        seed = self.translator(Transport(lambda *_: self.fail('Unused')))
        job = seed.job(self.source, self.item)
        count = g._characters(g._json_bytes(g.request_payload(self.config, [job['html']])).decode('utf-8'))
        transport = Transport(lambda *_: (_ for _ in ()).throw(self.daily()))
        t = self.translator(transport, replace(self.config, daily_characters=count, monthly_characters=count * 3))
        with self.assertRaises(TranslationRejected) as caught: self.run_job(t)
        self.assertEqual(caught.exception.code, 'gemini_character_quota_exhausted')
        self.assertEqual([call[0] for call in transport.calls], [PRIMARY])
        self.assertEqual(t.requests, 1)
        self.assertEqual(json.loads((self.root / 'quota/usage.json').read_bytes())['days']['2026-10-25'], count)

    def test_total_deadline_exhausted_by_primary_cannot_be_restarted_for_backup(self):
        clock = [0.0]
        def request(*_):
            clock[0] = 2.0
            raise self.daily()
        transport = Transport(request)
        t = g.GeminiTranslator(replace(self.config, max_seconds=1), cache_dir=self.root / 'cache',
            quota_dir=self.root / 'quota', request=transport, now=lambda: self.instant,
            sleep=self.pauses.append, monotonic=lambda: clock[0])
        with self.assertRaises(TranslationRejected) as caught: self.run_job(t)
        self.assertEqual(caught.exception.code, 'gemini_time_budget_exhausted')
        self.assertEqual([call[0] for call in transport.calls], [PRIMARY])
        self.assertEqual(t.requests, 1)

    def test_rpm_uses_original_backoff_on_primary_and_does_not_rotate(self):
        def request(transport, texts, timeout):
            if len(transport.calls) == 1:
                raise g.GeminiFailure(429, 2, {'quotaTypes': ['RPM'], 'bodyStatus': 'parsed'})
            return self.good(texts)
        transport = Transport(request); t = self.translator(transport); self.run_job(t)
        self.assertEqual([call[0] for call in transport.calls], [PRIMARY, PRIMARY])
        self.assertEqual(self.pauses, [2])

    def test_auth_and_bad_request_errors_never_rotate(self):
        for status in (400, 401, 403):
            transport = Transport(lambda *_: (_ for _ in ()).throw(g.GeminiFailure(status)))
            t = self.translator(transport)
            with self.assertRaises(TranslationRejected) as caught: self.run_job(t)
            self.assertEqual(caught.exception.code, 'gemini_http_' + str(status))
            self.assertEqual([call[0] for call in transport.calls], [PRIMARY])

    def test_credential_rotation_does_not_invalidate_native_cache_or_spend_again(self):
        t = self.translator(Transport(lambda _, texts, timeout: self.good(texts)))
        job = self.run_job(t); before = (self.root / 'quota/usage.json').read_bytes()
        rotated = self.translator(Transport(lambda *_: self.fail('Native cache must remain usable')),
            replace(self.config, key=OTHER, fallback_keys=(BACKUP,)))
        other_job = rotated.job(self.source, self.item)
        self.assertEqual(other_job['identity'], job['identity']); self.assertEqual(other_job['key'], job['key'])
        rotated.key_pool.remember(0, 100); rotated.key_pool.remember(1, 100)
        self.assertTrue(rotated.cached(other_job))
        self.assertEqual((self.root / 'quota/usage.json').read_bytes(), before)

    def test_echo_of_any_configured_key_is_rejected_before_native_persistence(self):
        for key in (PRIMARY, BACKUP):
            def request(_, texts, timeout):
                value = self.good(texts); value['echo'] = key; return value
            transport = Transport(request); t = self.translator(transport)
            with self.assertRaises(TranslationRejected) as caught: self.run_job(t)
            self.assertEqual(caught.exception.code, 'gemini_credential_echo_rejected')
            self.assertEqual(len(transport.calls), 1)
            self.assertEqual(list((self.root / 'cache').rglob('native/*.json')), [])
            self.assert_private_evidence_has_no_credentials()

    def test_failover_then_factual_repair_preserves_original_ids_and_three_attempt_budget(self):
        second_source = 'Brighton occupe la 2\u00e8me place avec 8 points apr\u00e8s un match (1-0).'
        def request(transport, texts, timeout):
            if transport.key == PRIMARY: raise self.daily()
            if transport.feedback is None:
                raw = self.good(texts)
                document = json.loads(raw['candidates'][0]['content']['parts'][0]['text'])
                document['translations'][1]['text'] = document['translations'][1]['text'].replace('>8<', '>7<')
                raw['candidates'][0]['content']['parts'][0]['text'] = json.dumps(document)
                return raw
            self.assertEqual(transport.feedback['fragmentIds'], ['1'])
            self.assertEqual(len(texts), 1)
            return self.good(texts, ['1'])
        transport = Transport(request); t = self.translator(transport)
        jobs = [t.job(self.source, self.item), t.job(second_source, self.item)]
        t.send(jobs)
        self.assertEqual([call[0] for call in transport.calls], [PRIMARY, BACKUP, BACKUP])
        self.assertEqual(t.requests, 3)
        records = [json.loads((t.directory / 'responses' / (job['key'] + '.json')).read_bytes()) for job in jobs]
        self.assertEqual([row['nativeFragmentId'] for row in records], ['0', '1'])
        self.assertNotEqual(records[0]['nativeResponseKey'], records[1]['nativeResponseKey'])
        for job in jobs: self.assertTrue(t.cached(job))
        self.assertTrue(t.attempts[-1]['completeBatchRevalidated'])

    def test_corrupt_scoped_cooldown_fails_closed_before_reserving_or_leaking_state(self):
        t = self.translator(Transport(lambda *_: self.fail('Corrupt private cooldown must block')))
        path = t.key_pool.cooldowns[0].path; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'{"secret":"must-not-escape"}'); path.chmod(0o600)
        with self.assertRaises(TranslationRejected) as caught: self.run_job(t)
        self.assertEqual(caught.exception.code, 'gemini_cooldown_state_invalid')
        self.assertNotIn('must-not-escape', str(caught.exception))
        self.assertFalse((self.root / 'quota/usage.json').exists())

    def test_native_cache_echo_of_a_new_backup_is_rejected_even_with_valid_content_hash(self):
        t = self.translator(Transport(lambda _, texts, timeout: self.good(texts)))
        job = self.run_job(t)
        response_path = t.directory / 'responses' / (job['key'] + '.json')
        response = json.loads(response_path.read_bytes())
        native = json.loads((t.directory / 'native' / (response['nativeResponseKey'] + '.json')).read_bytes())
        native['raw']['echo'] = OTHER
        native_key = g._native_key(native)
        g._write_private(t.directory / 'native' / (native_key + '.json'), native)
        response['nativeResponseKey'] = native_key
        g._write_private(response_path, response)
        other = self.translator(Transport(lambda *_: self.fail('Rejected cache must not call transport')),
            replace(self.config, fallback_keys=(OTHER,)))
        with self.assertRaises(TranslationRejected) as caught: other.cached(other.job(self.source, self.item))
        self.assertEqual(caught.exception.code, 'gemini_credential_echo_rejected')

    def test_environment_factory_attaches_shared_fallback_without_changing_global_quota_location(self):
        with patch.dict(os.environ, {'GEMINI_API_KEY': PRIMARY, 'GEMINI_API_KEY_FALLBACK': BACKUP,
                'WINTIPS_EDITORIAL_GEMINI_QUOTA_DIR': str(self.root / 'shared-quota')}, clear=True):
            translator = g.create_translator_from_env(self.root / 'factory-cache')
        self.assertEqual(g.credentials(translator.config), (PRIMARY, BACKUP))
        self.assertEqual(translator.quota.directory, self.root / 'shared-quota')

    def test_selected_transport_header_changes_without_serializing_keys_in_wire(self):
        transport = g.GeminiTransport(self.config)
        captured = []
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, *args): return b'{"ok":true}'
        def opened(request, timeout):
            captured.append((request.get_header('X-goog-api-key'), request.data)); return Reply()
        transport.opener.open = opened
        transport.set_key(BACKUP); self.assertEqual(transport(['<div>data</div>'], 1), {'ok': True})
        self.assertEqual(captured[0][0], BACKUP)
        self.assertFalse(any(key.encode() in captured[0][1] for key in g.credentials(self.config)))
        with self.assertRaises(TranslationRejected): transport.set_key(OTHER)


if __name__ == '__main__': unittest.main()
