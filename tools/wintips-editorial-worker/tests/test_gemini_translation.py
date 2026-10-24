"""Offline transport doubles only; these are not Gemini quality/credential proofs."""
from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from hashlib import sha256
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from editorial_worker import gemini_translation as gemini, runner, model_runtime, mt_translation
from editorial_worker.translation import LocalTranslator, TranslationRejected, translate_batch
from test_azure_translation import item, english_html
from test_bilingual_runner import Api, TestTranslator, arguments, payload_item


KEY = 'testOnlyNotAGeminiCredential12345'
NOW = datetime(2026, 10, 24, 8, tzinfo=timezone.utc)


def response(texts, ids=None):
    return {'candidates': [{'finishReason': 'STOP', 'content': {'role': 'model', 'parts': [{'text':
        json.dumps({'translations': [{'id': str(i) if ids is None else ids[i], 'text': english_html(value)}
            for i, value in enumerate(texts)]})}]}}],
        'usageMetadata': {'promptTokenCount': 100, 'candidatesTokenCount': 80, 'totalTokenCount': 180}}


class GeminiTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = gemini.GeminiConfig(KEY)

    def translator(self, request=None, config=None, **kwargs):
        return gemini.GeminiTranslator(config or self.config, cache_dir=self.root,
            quota_dir=self.root / 'quota', request=request or (lambda texts, timeout: response(texts)),
            now=lambda: NOW, **kwargs)

    def test_whole_batch_is_bilingual_original_facts_unchanged_and_cloud_audited(self):
        calls = []
        def request(texts, timeout):
            calls.append((texts, timeout))
            return response(texts)
        original = {'source': 'rdj_football_analysis', 'editionDate': '2026-10-24', 'items': [item()]}
        snapshot = deepcopy(original)
        translator = self.translator(request)
        translated, audit = translate_batch(original, translator)
        self.assertEqual(original, snapshot)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0][0]), 2)
        self.assertEqual(calls[0][1], 45)
        self.assertEqual(translated['items'][0]['selection']['label']['en'], 'Brest to win')
        self.assertEqual(translated['items'][0]['analysis']['en'][0]['paragraphs'],
            ['Brest won three matches. Nice lost 2 matches (1-0).'])
        self.assertEqual(audit['provider'], 'gemini')
        self.assertEqual(audit['cloudAttempts'][0]['usageMetadata']['totalTokenCount'], 180)
        self.assertTrue(all(row['provider'] == 'gemini' for row in audit['records']))
        self.assertTrue(all(row['proof']['semanticQualityProven'] is False for row in audit['records']))
        usage = json.loads((self.root / 'quota/usage.json').read_bytes())
        self.assertGreater(usage['days']['2026-10-24'], sum(gemini._characters(t) for t in calls[0][0]))
        for path in self.root.rglob('*.json'):
            self.assertNotIn(KEY, path.read_text('utf-8'))

    def test_cache_reuses_exact_native_without_spend_and_is_separate_from_azure(self):
        source = item()['summary']['fr']
        expected = self.translator().text(source, item())
        usage = (self.root / 'quota/usage.json').read_bytes()
        second = self.translator(lambda *a: self.fail('Cache hit must not request Gemini'))
        self.assertEqual(second.text(source, item()), expected)
        self.assertTrue(second.records[-1]['cached'])
        self.assertEqual((self.root / 'quota/usage.json').read_bytes(), usage)
        self.assertTrue(list((self.root / 'gemini/responses').glob('*.json')))
        self.assertFalse((self.root / 'azure').exists())

    def test_cache_identity_binds_source_facts_model_prompt_and_output_limit(self):
        translator = self.translator()
        source = item()['summary']['fr']
        original = translator.job(source, item())['key']
        changed = deepcopy(item())
        changed['selection']['odds'] = 2.16
        self.assertNotEqual(translator.job(source, changed)['key'], original)
        self.assertNotEqual(translator.job(source + '!', item())['key'], original)
        for config in (replace(self.config, model='gemini-3.8-flash'), replace(self.config, max_output_tokens=4096)):
            self.assertNotEqual(self.translator(config=config).job(source, item())['key'], original)
        with patch.object(gemini, 'INSTRUCTIONS', 'test different contract'):
            self.assertNotEqual(translator.job(source, item())['key'], original)
        changed = deepcopy(item())
        changed['analysis']['en'] = ['Old English ignored']
        self.assertEqual(translator.job(source, changed)['key'], original)

    def test_sports_contract_and_38_low_thinking_are_bound_to_wire_and_cache(self):
        settings = replace(self.config, model='gemini-3.8-flash')
        translator = self.translator(config=settings)
        source = item()['summary']['fr']
        job = translator.job(source, item())
        wire = gemini.request_payload(settings, [job['html']])['generationConfig']
        self.assertEqual(wire['thinkingConfig'], {'thinkingLevel': 'LOW'})
        self.assertEqual(wire['maxOutputTokens'], 8192)
        self.assertEqual(job['identity']['generation']['thinkingConfig'], wire['thinkingConfig'])
        self.assertNotIn('thinkingConfig', gemini.request_payload(self.config, [job['html']])['generationConfig'])
        self.assertEqual(gemini.VERSION, 'gemini-html-facts-v5-source-prose-guard')
        for rule in ('latest/most recent matchday', 'not take on or face', 'entire top-N rank',
                'last-season final', 'negation, inability or missed opportunity'):
            self.assertIn(rule, gemini.INSTRUCTIONS)
        for forbidden in ('Rayo', 'Philadelphie', 'MON PETIT PRINCE', '6014367'):
            self.assertNotIn(forbidden, gemini.INSTRUCTIONS)
        original = job['key']
        with patch.object(gemini, 'VERSION', 'gemini-html-facts-v1'):
            self.assertNotEqual(translator.job(source, item())['key'], original)
        with patch.object(gemini, 'generation_options', return_value={
                'temperature': 0, 'candidateCount': 1, 'maxOutputTokens': 8192}):
            self.assertNotEqual(translator.job(source, item())['key'], original)

    def test_cache_saved_passed_cannot_override_fact_revalidation(self):
        source = item()['analysis']['fr'][0]['paragraphs'][0]
        self.translator().text(source, item())
        path = next((self.root / 'gemini/responses').glob('*.json'))
        saved = json.loads(path.read_bytes())
        saved['html'] = saved['html'].replace('>2<', '>9<')
        saved['proof'] = {'passed': True}
        path.write_text(json.dumps(saved), 'utf-8')
        with self.assertRaises(TranslationRejected) as caught:
            self.translator(lambda *a: self.fail('Invalid cache causes no spend')).text(source, item())
        self.assertEqual(caught.exception.code, 'gemini_output_structure_or_facts_changed')

    def test_one_factual_repair_preserves_original_inputs_and_validates_entire_batch(self):
        class Native:
            feedback = None
            def __init__(self): self.calls = []
            def set_feedback(self, value): self.feedback = deepcopy(value)
            def __call__(self, texts, timeout):
                self.calls.append((deepcopy(texts), deepcopy(self.feedback)))
                raw = response(texts, self.feedback['fragmentIds'] if self.feedback else None)
                if len(self.calls) == 1:
                    rows = json.loads(raw['candidates'][0]['content']['parts'][0]['text'])
                    rows['translations'][-1]['text'] = rows['translations'][-1]['text'].replace('</div>', ' 3 points</div>')
                    raw['candidates'][0]['content']['parts'][0]['text'] = json.dumps(rows)
                return raw
        request = Native()
        translator = self.translator(request)
        source = {'items': [item()]}
        before = deepcopy(source)
        translator.prepare_batch(source)
        self.assertEqual(source, before)
        self.assertEqual(len(request.calls), 2)
        self.assertEqual(request.calls[1][0], [request.calls[0][0][1]])
        self.assertIsNone(request.calls[0][1])
        feedback = request.calls[1][1]
        self.assertTrue(feedback['candidateIsUntrusted'])
        self.assertEqual([(row['id'], row['code']) for row in feedback['rejections']], [('1', 'gemini_unprotected_number_added')])
        self.assertIn('3 points', feedback['rejectedTranslations'][0]['text'])
        wire = gemini.request_payload(self.config, request.calls[1][0], feedback)
        data = json.loads(wire['contents'][0]['parts'][0]['text'])
        self.assertEqual([row['text'] for row in data['fragments']], request.calls[1][0])
        self.assertEqual([row['id'] for row in data['fragments']], ['1'])
        self.assertEqual(data['contentRepairFeedback'], feedback)
        self.assertNotIn('3 points', wire['systemInstruction']['parts'][0]['text'])
        self.assertIsNone(request.feedback)
        self.assertEqual(len(translator.prepared), 2)
        self.assertEqual(len(list((self.root / 'gemini/native').glob('*.json'))), 2)
        self.assertTrue(translator.attempts[0]['contentRepairScheduled'])
        self.assertEqual(translator.attempts[1]['contentRepairRound'], 1)
        usage = json.loads((self.root / 'quota/usage.json').read_bytes())
        self.assertEqual(usage['days']['2026-10-24'], sum(row['inputCharactersReserved'] for row in translator.attempts))
        self.assertGreater(translator.attempts[1]['inputCharactersReserved'], gemini._characters(request.calls[1][0][0]))
        self.assertTrue(any(json.loads(path.read_bytes())['repairFeedback'] is not None
            for path in (self.root / 'gemini/native').glob('*.json')))

    def test_persistent_factual_rejection_stops_after_one_repair_without_partial_cache(self):
        calls = []
        def bad(texts, timeout):
            calls.append(texts)
            raw = response(texts, ['1'] if len(calls) > 1 else None)
            rows = json.loads(raw['candidates'][0]['content']['parts'][0]['text'])
            rows['translations'][-1]['text'] += ' 7 goals'
            raw['candidates'][0]['content']['parts'][0]['text'] = json.dumps(rows)
            return raw
        translator = self.translator(bad)
        with self.assertRaises(TranslationRejected): translator.prepare_batch({'items': [item()]})
        self.assertEqual(len(calls), 2)
        self.assertEqual(translator.prepared, {})
        self.assertFalse((self.root / 'gemini/responses').exists())
        self.assertTrue(all(row['rejection']['candidateHtml'] for row in translator.attempts))

    def test_repair_new_defect_in_requested_subset_still_blocks_entire_batch(self):
        calls = []
        def request(texts, timeout):
            calls.append(texts)
            raw = response(texts, ['1'] if len(calls) > 1 else None)
            rows = json.loads(raw['candidates'][0]['content']['parts'][0]['text'])
            index = 1 if len(calls) == 1 else 0
            rows['translations'][index]['text'] = rows['translations'][index]['text'].replace('</div>', ' 9 wins</div>')
            raw['candidates'][0]['content']['parts'][0]['text'] = json.dumps(rows)
            return raw
        translator = self.translator(request)
        with self.assertRaises(TranslationRejected): translator.prepare_batch({'items': [item()]})
        self.assertEqual(len(calls), 2)
        self.assertEqual([row['rejection']['id'] for row in translator.attempts], ['1', '1'])
        self.assertEqual(translator.prepared, {})
        self.assertFalse((self.root / 'gemini/responses').exists())

    def test_deadline_between_fact_rejection_and_repair_blocks_second_request(self):
        ticks = iter((0, 0, 0, 0, 2))
        calls = []
        def request(texts, timeout):
            calls.append(texts)
            return response([text.replace('</div>', ' 9 wins</div>') for text in texts])
        translator = self.translator(request, config=replace(self.config, max_seconds=1), monotonic=lambda: next(ticks))
        with self.assertRaises(TranslationRejected) as caught: translator.text(item()['summary']['fr'], item())
        self.assertEqual(caught.exception.code, 'gemini_time_budget_exhausted')
        self.assertEqual(len(calls), 1)
        self.assertEqual(translator.requests, 1)

    def test_repair_shares_three_physical_attempts_with_http_retry_and_global_budget(self):
        calls = []
        def request(texts, timeout):
            calls.append(texts)
            if len(calls) == 1: raise gemini.GeminiFailure(429)
            raw = response(texts)
            if len(calls) == 2:
                rows = json.loads(raw['candidates'][0]['content']['parts'][0]['text'])
                rows['translations'][0]['text'] = rows['translations'][0]['text'].replace('</div>', ' 9 wins</div>')
                raw['candidates'][0]['content']['parts'][0]['text'] = json.dumps(rows)
            return raw
        translator = self.translator(request, sleep=lambda _: None)
        translator.text(item()['summary']['fr'], item())
        self.assertEqual(len(calls), 3)
        self.assertEqual(translator.requests, 3)
        translator = self.translator(lambda texts, timeout: response([text.replace('</div>', ' 9 wins</div>') for text in texts]),
            config=replace(self.config, max_requests=1))
        with self.assertRaises(TranslationRejected) as caught: translator.text(item()['summary']['fr'] + '!', item())
        self.assertEqual(caught.exception.code, 'gemini_request_budget_exhausted')
        self.assertEqual(translator.requests, 1)

    def test_technical_schema_and_credential_failures_never_schedule_content_repair(self):
        for mode in ('401', 'schema', 'incomplete', 'credential'):
            calls = []
            def request(texts, timeout):
                calls.append(texts)
                if mode == '401': raise gemini.GeminiFailure(401)
                raw = response(texts)
                if mode == 'schema': raw['candidates'][0]['content']['parts'][0]['text'] = '{'
                if mode == 'incomplete': raw['candidates'][0]['finishReason'] = 'MAX_TOKENS'
                if mode == 'credential': raw['unexpected'] = KEY
                return raw
            translator = self.translator(request)
            with self.subTest(mode=mode), self.assertRaises(TranslationRejected): translator.text(item()['summary']['fr'], item())
            self.assertEqual(len(calls), 1)
            self.assertFalse(translator.attempts[0].get('contentRepairScheduled', False))

    def test_cache_malformed_is_closed_not_replaced_with_a_paid_request(self):
        translator = self.translator(lambda *a: self.fail('Bad cache must not request'))
        job = translator.job(item()['summary']['fr'], item())
        path = self.root / 'gemini/responses' / (job['key'] + '.json')
        path.parent.mkdir(parents=True)
        path.write_text('{', 'utf-8')
        if gemini.os.name != 'nt': path.chmod(0o600)
        with self.assertRaises(TranslationRejected) as caught:
            translator.text(item()['summary']['fr'], item())
        self.assertEqual(caught.exception.code, 'gemini_cache_invalid')

    def test_missing_duplicate_changed_names_score_and_extra_numbers_rejected(self):
        source = item()['analysis']['fr'][0]['paragraphs'][0]
        html, _ = gemini._protected(source, item())
        good = english_html(html)
        for bad in (good.replace('>Brest<', '>Lyon<'), good.replace('>1-0<', '>0-1<'),
                good.replace('>2<', '>9<'), good.replace('</div>', ' 7 goals</div>'),
                good.replace('</div>', ' Brest</div>'), good.replace('</span>', '</span></span>', 1)):
            with self.subTest(bad=bad), self.assertRaises(TranslationRejected):
                gemini._validated(source, item(), bad)

    def test_one_invalid_row_rejects_complete_response_and_retains_reason_raw(self):
        calls = []
        def request(texts, timeout):
            calls.append(texts)
            result = response(texts, ['1'] if len(calls) > 1 else None)
            rows = json.loads(result['candidates'][0]['content']['parts'][0]['text'])
            rows['translations'][-1]['text'] = rows['translations'][-1]['text'].replace('>2<', '>9<')
            result['candidates'][0]['content']['parts'][0]['text'] = json.dumps(rows)
            return result
        translator = self.translator(request)
        with self.assertRaises(TranslationRejected):
            translator.prepare_batch({'items': [item()]})
        self.assertEqual(translator.prepared, {})
        self.assertFalse((self.root / 'gemini/responses').exists())
        self.assertEqual(translator.attempts[-1]['rejection']['code'], 'gemini_output_structure_or_facts_changed')
        self.assertEqual(len(list((self.root / 'gemini/native').glob('*.json'))), 2)

    def test_retry_429_and_503_reserves_each_attempt_and_respects_retry_after(self):
        calls, pauses = [], []
        def request(texts, timeout):
            calls.append(texts)
            if len(calls) < 3: raise gemini.GeminiFailure(429 if len(calls) == 1 else 503, 3)
            return response(texts)
        translator = self.translator(request, sleep=pauses.append)
        translator.text(item()['summary']['fr'], item())
        self.assertEqual(len(calls), 3)
        self.assertEqual(pauses, [3, 3])
        usage = json.loads((self.root / 'quota/usage.json').read_bytes())
        self.assertEqual(usage['days']['2026-10-24'], 3 * translator.attempts[0]['inputCharactersReserved'])

    def test_400_no_retry_and_429_stops_after_three_requests(self):
        for status, expected in ((400, 1), (401, 1), (429, 3)):
            with self.subTest(status=status):
                translator = self.translator(lambda *a: (_ for _ in ()).throw(gemini.GeminiFailure(status)), sleep=lambda _: None)
                with self.assertRaises(TranslationRejected) as caught:
                    translator.text(item()['summary']['fr'], item())
                self.assertEqual(caught.exception.code, 'gemini_http_' + str(status))
                self.assertEqual(translator.requests, expected)

    def test_quota_exhaustion_precedes_any_transport(self):
        translator = self.translator(lambda *a: self.fail('Quota must block physical request'),
            config=replace(self.config, daily_characters=1))
        with self.assertRaises(TranslationRejected) as caught:
            translator.text(item()['summary']['fr'], item())
        self.assertEqual(caught.exception.code, 'gemini_character_quota_exhausted')
        self.assertEqual(translator.requests, 0)

    def test_shared_quota_directory_counts_both_worker_instances_at_exact_boundary(self):
        settings = replace(self.config, daily_characters=100, monthly_characters=300)
        first = self.translator(config=settings)
        second = self.translator(config=settings)
        first.quota.reserve(60)
        second.quota.reserve(40)
        with self.assertRaises(TranslationRejected) as caught:
            first.quota.reserve(1)
        self.assertEqual(caught.exception.code, 'azure_character_quota_exhausted')
        self.assertEqual(json.loads((self.root / 'quota/usage.json').read_bytes())['days']['2026-10-24'], 100)

    def test_provider_credential_echo_is_never_persisted(self):
        def request(texts, timeout):
            result = response(texts)
            result['unexpected'] = KEY
            return result
        translator = self.translator(request)
        with self.assertRaises(TranslationRejected) as caught:
            translator.text(item()['summary']['fr'], item())
        self.assertEqual(caught.exception.code, 'gemini_credential_echo_rejected')
        self.assertFalse((self.root / 'gemini/native').exists())
        self.assertNotIn(KEY, json.dumps(translator.attempts))

    def test_global_deadline_blocks_request_and_blocks_retry_wait(self):
        ticks = [0]
        translator = self.translator(lambda *a: self.fail('No request past deadline'), monotonic=lambda: ticks[0])
        ticks[0] = 181
        with self.assertRaises(TranslationRejected) as caught:
            translator.text(item()['summary']['fr'], item())
        self.assertEqual(caught.exception.code, 'gemini_time_budget_exhausted')
        translator = self.translator(lambda *a: (_ for _ in ()).throw(gemini.GeminiFailure(429, 3)),
            config=replace(self.config, max_seconds=2), sleep=lambda _: self.fail('Wait cannot exceed deadline'))
        with self.assertRaises(TranslationRejected) as caught:
            translator.text(item()['summary']['fr'], item())
        self.assertEqual(caught.exception.code, 'gemini_retry_delay_exceeds_budget')

    def test_response_closed_schema_and_finished_candidate_required(self):
        good = response(['<div>Bonjour</div>'])
        variants = []
        bad = deepcopy(good); bad['candidates'][0]['finishReason'] = 'MAX_TOKENS'; variants.append(bad)
        bad = deepcopy(good); bad['promptFeedback'] = {'blockReason': 'SAFETY'}; variants.append(bad)
        bad = deepcopy(good); bad['candidates'][0]['content']['parts'][0]['thought'] = True; variants.append(bad)
        bad = deepcopy(good); bad['candidates'][0]['content']['parts'][0]['text'] = '{"translations":[],"extra":true}'; variants.append(bad)
        bad = deepcopy(good); bad['candidates'][0]['content']['parts'][0]['text'] = '{"translations":[],"translations":[]}'; variants.append(bad)
        bad = deepcopy(good); bad['candidates'][0]['content']['parts'][0]['text'] = '{"translations":[{"id":"other","text":"x"}]}'; variants.append(bad)
        bad = deepcopy(good); bad['candidates'] *= 2; variants.append(bad)
        for raw in variants:
            with self.subTest(raw=raw), self.assertRaises(TranslationRejected): gemini.response_texts(raw, 1)
        self.assertEqual(len(gemini.response_texts(good, 1)), 1)

    def test_four_actual_native_final_parts_accept_signature_without_changing_text(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/gemini-native-parts-20261024.json').read_bytes())
        self.assertEqual(len(fixture['cases']), 4)
        for case in fixture['cases']:
            raw = case['raw']
            parts = raw['candidates'][0]['content']['parts']
            self.assertEqual([sha256(part['text'].encode()).hexdigest() for part in parts], case['textSha256'])
            self.assertIn('thoughtSignature', parts[0])
            actual = gemini.response_texts(raw, case['expectedCount'])
            without_metadata = deepcopy(raw)
            for part in without_metadata['candidates'][0]['content']['parts']: part.pop('thoughtSignature')
            self.assertEqual(actual, gemini.response_texts(without_metadata, case['expectedCount']))

    def test_signature_metadata_never_admits_thought_tools_bad_ids_or_nonstop(self):
        good = response(['<div>Bonjour</div>'])
        part = good['candidates'][0]['content']['parts'][0]
        part.update(thoughtSignature='AA==', thought=False)
        self.assertEqual(len(gemini.response_texts(good, 1)), 1)
        for signature in (None, 12, {}, 'not base64!', 'A', 'A' * 65_537):
            bad = deepcopy(good)
            bad['candidates'][0]['content']['parts'][0]['thoughtSignature'] = signature
            with self.subTest(signatureType=type(signature).__name__), self.assertRaises(TranslationRejected):
                gemini.response_texts(bad, 1)
        for field, value in (('thought', True), ('thought', 0), ('thought', None),
                ('functionCall', {}), ('inlineData', {}), ('partMetadata', {}), ('unknown', True)):
            bad = deepcopy(good)
            bad['candidates'][0]['content']['parts'][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(TranslationRejected):
                gemini.response_texts(bad, 1)
        for reason in ('MAX_TOKENS', 'SAFETY', None):
            bad = deepcopy(good)
            bad['candidates'][0]['finishReason'] = reason
            with self.subTest(reason=reason), self.assertRaises(TranslationRejected):
                gemini.response_texts(bad, 1)
        bad = deepcopy(good)
        bad['candidates'][0]['content']['parts'][0]['text'] = '{"translations":[{"id":"wrong","text":"x"}]}'
        with self.assertRaises(TranslationRejected): gemini.response_texts(bad, 1)

    def test_transport_header_key_never_url_and_only_one_physical_post(self):
        class Reply(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): self.close()
        captured = []
        def opened(request, timeout):
            captured.append(request)
            return Reply(json.dumps(response(['<div>Bonjour</div>'])).encode())
        transport = gemini.GeminiTransport(self.config)
        with patch.object(transport.opener, 'open', side_effect=opened):
            transport(['<div>Bonjour</div>'], 10)
        request = captured[0]
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(request.get_header('X-goog-api-key'), KEY)
        self.assertNotIn(KEY, request.full_url)
        self.assertNotIn(KEY.encode(), request.data)
        self.assertTrue(request.full_url.endswith('gemini-3.5-flash-lite:generateContent'))
        generation = json.loads(request.data)['generationConfig']
        self.assertEqual(generation['responseMimeType'], 'application/json')
        self.assertIn('responseJsonSchema', generation)

    def test_transport_http_error_sanitized_no_body_or_secret_and_retry_after_bounded(self):
        transport = gemini.GeminiTransport(self.config)
        failure = HTTPError('https://unused.invalid', 429, KEY, {'Retry-After': '999'}, io.BytesIO(KEY.encode()))
        with patch.object(transport.opener, 'open', side_effect=failure), self.assertRaises(gemini.GeminiFailure) as caught:
            transport(['x'], 10)
        self.assertEqual(caught.exception.retry_after, 999)
        self.assertNotIn(KEY, str(caught.exception))
        for failure in (URLError(KEY), TimeoutError(KEY), ValueError(KEY)):
            with patch.object(transport.opener, 'open', side_effect=failure), self.assertRaises(TranslationRejected) as caught:
                transport(['x'], 10)
            self.assertNotIn(KEY, str(caught.exception))

    def test_factory_credential_precedence_model_and_absolute_quota(self):
        with patch.dict('os.environ', {'GEMINI_API_KEY': KEY, 'WINTIPS_EDITORIAL_GEMINI_MODEL': 'gemini-3.8-flash',
                'WINTIPS_EDITORIAL_GEMINI_QUOTA_DIR': str(self.root / 'quota')}, clear=True):
            translator = gemini.create_translator_from_env(self.root)
        self.assertEqual(translator.config.model, 'gemini-3.8-flash')
        self.assertNotIn(KEY, repr(translator.config))
        with patch.dict('os.environ', {'GEMINI_API_KEY': KEY, 'WINTIPS_EDITORIAL_GEMINI_QUOTA_DIR': 'relative'}, clear=True), self.assertRaises(TranslationRejected):
            gemini.create_translator_from_env(self.root)
        for config in ({'model': '../wrong'}, {'daily_characters': True}, {'max_seconds': float('nan')}):
            with self.subTest(config=config), self.assertRaises(TranslationRejected): replace(self.config, **config)


class GeminiRunnerTests(unittest.TestCase):
    def trap(self, *a, **k): self.fail('Gemini must not start or admit a local model')

    def env(self):
        return patch.dict('os.environ', {'WINTIPS_EDITORIAL_TRANSLATOR': 'gemini',
            'WINTIPS_EDITORIAL_MANAGE_MODEL': 'true'}, clear=True)

    def test_gemini_factory_selected_without_any_local_engine(self):
        expected = TestTranslator()
        with TemporaryDirectory() as directory, self.env(), ExitStack() as resources, \
                patch.object(gemini, 'create_translator_from_env', return_value=expected) as factory, \
                patch.object(LocalTranslator, '__init__', side_effect=self.trap), \
                patch.object(mt_translation, 'MarianTransport', side_effect=self.trap), \
                patch.object(model_runtime, 'managed_model', side_effect=self.trap):
            self.assertIs(runner.make_translator(arguments(directory), Path(directory), resources), expected)
            factory.assert_called_once_with(cache_dir=Path(directory) / 'translation-cache', max_seconds=600)

    def run_case(self, directory, translator):
        api = Api()
        instant = datetime(2026, 10, 23, 8, tzinfo=timezone.utc)
        with self.env(), patch.object(model_runtime, 'require_admission', side_effect=self.trap), \
                patch.object(model_runtime, 'managed_model', side_effect=self.trap), \
                patch.object(runner, 'collect', return_value={'status': 'ready', 'items': [payload_item()], 'issues': []}):
            result = runner.run(arguments(directory, translate=True),
                fetcher=type('Fetch', (), {'requests': 0, 'records': []})(),
                api_client=api, translator=translator, now=instant, clock=lambda: instant)
        self.assertEqual([route for route, _ in api.calls], ['/api/internal/editorial/config'])
        return result

    def test_preview_bypasses_shared_model_window_without_post(self):
        with TemporaryDirectory() as directory:
            report = self.run_case(directory, TestTranslator())
            self.assertTrue(report['sources'][0]['bilingual'])
            self.assertNotIn('deferred', report)

    def test_failure_retains_guard_evidence_attempts_and_never_claims_publication(self):
        class Broken(TestTranslator):
            provider = 'gemini'
            def __init__(self): self.attempts = []
            def text(self, *args):
                self.attempts.append({'status': 'rejected', 'rejection': {'code': 'number_changed', 'source': 'Deux chevaux.'}})
                raise TranslationRejected('gemini_output_structure_or_facts_changed', audit={
                    'source': 'Deux chevaux.', 'errors': ['number_changed'],
                    'candidate': 'Nine horses.', 'apiKey': KEY})
        with TemporaryDirectory() as directory:
            report = self.run_case(directory, Broken())
            row = report['sources'][0]
            audit = json.loads(Path(row['translationFailureAuditFile']).read_bytes())
            self.assertEqual(audit['details']['errors'], ['number_changed'])
            self.assertEqual(audit['details']['candidate'], 'Nine horses.')
            self.assertEqual(audit['cloudAttempts'][0]['rejection']['code'], 'number_changed')
            self.assertFalse(audit['publicationAllowed'])
            self.assertNotIn(KEY, json.dumps(audit))
            self.assertTrue(report['blocked'])
            self.assertFalse(report['published'])

    def test_missing_key_never_calls_cloud_or_local_runtime(self):
        with TemporaryDirectory() as directory, self.env(), ExitStack() as resources, \
                patch.object(gemini.GeminiTransport, '__call__', side_effect=self.trap), \
                patch.object(model_runtime, 'managed_model', side_effect=self.trap), self.assertRaises(TranslationRejected) as caught:
            runner.make_translator(arguments(directory), Path(directory), resources)
        self.assertEqual(caught.exception.code, 'gemini_key_required')


if __name__ == '__main__': unittest.main()
