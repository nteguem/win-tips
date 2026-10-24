"""Bounded HTTP metadata and repair diagnostics, no network or actual waiting."""
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import test_gemini_subset_repair as subset
from editorial_worker import gemini_translation as gemini
from editorial_worker.translation import TranslationRejected


def error_body(delay='39.1s', quota='GenerateRequestsPerMinutePerProjectPerModel-FreeTier'):
    return json.dumps({'error': {'code': 429, 'message': subset.KEY, 'details': [
        {'@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': delay},
        {'@type': 'type.googleapis.com/google.rpc.QuotaFailure', 'violations': [
            {'quotaId': quota, 'subject': subset.KEY, 'description': subset.KEY,
                'quotaDimensions': {'project': subset.KEY}, 'quotaValue': subset.KEY}]}]}}).encode()


class RetryDiagnosticsTests(unittest.TestCase):
    setUp = subset.SubsetRepairTests.setUp
    translator = subset.SubsetRepairTests.translator
    jobs = subset.SubsetRepairTests.jobs

    def test_retry_info_rounds_up_and_only_exact_quota_ids_become_closed_enums(self):
        for delay, quota, expected in [('39.1s', 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'RPM'),
                ('2.000000001s', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'RPD'),
                ('0.001s', subset.KEY, 'unknown')]:
            with self.subTest(quota=expected):
                metadata = gemini._rate_limit_metadata(error_body(delay, quota), '2')
                self.assertEqual(metadata['quotaTypes'], [expected])
                self.assertEqual(metadata['retryAfterHeaderSeconds'], 2)
                self.assertNotIn(subset.KEY, json.dumps(metadata))
        self.assertEqual(gemini._rate_limit_metadata(error_body(), '')['retryInfoSeconds'], 40)

    def test_429_transport_reads_at_most_32k_plus_sentinel_and_drops_error_body(self):
        reads = []
        class Tracked(io.BytesIO):
            def read(self, count=-1): reads.append(count); return super().read(count)
        transport = gemini.GeminiTransport(self.config)
        failure = HTTPError('https://unused.invalid/'+subset.KEY, 429, subset.KEY, {'Retry-After': '3'}, Tracked(error_body()))
        with patch.object(transport.opener, 'open', side_effect=failure), self.assertRaises(gemini.GeminiFailure) as caught:
            transport(['<div>French</div>'], 5)
        self.assertEqual(reads, [32769])
        self.assertEqual(caught.exception.retry_after, 40)
        self.assertEqual(caught.exception.rate_limit['quotaTypes'], ['RPM'])
        self.assertNotIn(subset.KEY, str(caught.exception)+json.dumps(caught.exception.rate_limit))
        self.assertTrue(failure.fp.closed)

    def test_larger_header_is_not_shortened_to_body_delay_or_old_600_second_cap(self):
        transport = gemini.GeminiTransport(self.config)
        failure = HTTPError('https://unused.invalid', 429, '', {'Retry-After': '999'}, io.BytesIO(error_body('1s')))
        with patch.object(transport.opener, 'open', side_effect=failure), self.assertRaises(gemini.GeminiFailure) as caught:
            transport(['<div>x</div>'], 5)
        self.assertEqual(caught.exception.retry_after, 999)

    def test_invalid_oversize_and_unknown_metadata_never_export_raw_fields(self):
        for raw in (b'not JSON '+subset.KEY.encode(), b'x'*32769,
                json.dumps({'error': {'details': [{'@type': subset.KEY, 'message': subset.KEY}]}}).encode()):
            with self.subTest(size=len(raw)):
                metadata = gemini._rate_limit_metadata(raw, '7', 'too_large' if len(raw)>32768 else 'parsed')
                self.assertEqual(metadata['retryAfterHeaderSeconds'], 7)
                self.assertEqual(metadata['quotaTypes'], ['unknown'])
                self.assertNotIn(subset.KEY, json.dumps(metadata))
        malicious = gemini.GeminiFailure(429, 1, {'quotaTypes': [subset.KEY, 'RPM'], 'bodyStatus': subset.KEY, 'secret': subset.KEY})
        self.assertNotIn(subset.KEY, json.dumps(malicious.rate_limit))

    def test_retry_wait_uses_body_header_and_backoff_before_next_charged_request(self):
        for header, body_delay, expected in [('2', '39.1s', 40), ('50', '2s', 50)]:
            calls, pauses = [], []; native = subset.Native(initial_bad=())
            def request(texts, timeout):
                calls.append(texts)
                if len(calls)==1:
                    metadata=gemini._rate_limit_metadata(error_body(body_delay),header)
                    raise gemini.GeminiFailure(429,max(metadata['retryAfterHeaderSeconds'],metadata['retryInfoSeconds']),metadata)
                return native(texts,timeout)
            with self.subTest(delay=expected):
                translator=self.translator(request);translator.sleep=pauses.append;translator.send(self.jobs(translator))
                self.assertEqual(pauses,[expected]);self.assertEqual(translator.requests,2)
                self.assertEqual(translator.attempts[0]['retryDelaySeconds'],expected)
                self.assertEqual(translator.attempts[0]['rateLimit']['quotaTypes'],['RPM'])

    def test_delay_outside_global_budget_never_sleeps_retries_or_resets_quota(self):
        pauses=[];metadata=gemini._rate_limit_metadata(error_body('180.1s'),'1')
        translator=self.translator(lambda *a: (_ for _ in ()).throw(gemini.GeminiFailure(429,metadata['retryInfoSeconds'],metadata)))
        translator.sleep=pauses.append
        with self.assertRaises(TranslationRejected) as caught: translator.send(self.jobs(translator))
        self.assertEqual(caught.exception.code,'gemini_retry_delay_exceeds_budget')
        self.assertEqual(translator.requests,1);self.assertEqual(pauses,[])
        used=json.loads((self.root/'quota/usage.json').read_bytes())['days']['2026-10-24']
        self.assertEqual(used,translator.attempts[0]['inputCharactersReserved'])

    def test_real_arsenal_failures_have_exact_duplicate_mutated_and_missing_span_feedback(self):
        case=json.loads((Path(__file__).parent/'fixtures/gemini-span-failures-20261024.json').read_bytes())
        translator=self.translator(subset.Native());job=translator.job(case['source'],case['item'])
        for number,candidate in enumerate(case['candidateHtml']):
            with self.subTest(number=number),self.assertRaises(TranslationRejected):gemini._validated(case['source'],case['item'],candidate)
        initial=gemini._repair_diagnostics(job,case['candidateHtml'][0])
        self.assertEqual(initial['duplicateSpans'],[{'id':'wt1','requiredValue':'3-0','requiredValueTruncated':False,'expectedOccurrences':1,'actualOccurrences':2}])
        self.assertEqual(initial['mutatedSpans'],[{'id':'wt1','requiredValue':'3-0','requiredValueTruncated':False,'actualValue':'PSG','actualValueTruncated':False}])
        repair=gemini._repair_diagnostics(job,case['candidateHtml'][1])
        self.assertEqual(repair['missingSpans'],[{'id':'wt7','requiredValue':'3','requiredValueTruncated':False}])

    def test_span_diagnostic_values_are_bounded_without_false_mutation_for_long_exact_name(self):
        long_name='A'*200;item={'teams':{'home':{'name':long_name}}};source=long_name+' a gagné 3 matchs.'
        translator=self.translator(subset.Native());job=translator.job(source,item)
        self.assertEqual(gemini._repair_diagnostics(job,job['html'])['mutatedSpans'],[])
        changed=job['html'].replace('>'+long_name+'<','>'+'B'*300+'<')
        diagnostics=gemini._repair_diagnostics(job,changed);row=diagnostics['mutatedSpans'][0]
        self.assertEqual(len(row['actualValue']),160);self.assertEqual(len(row['requiredValue']),160)
        self.assertTrue(row['actualValueTruncated']);self.assertTrue(row['requiredValueTruncated'])
        too_large=gemini._repair_diagnostics(job,'x'*200001)
        self.assertTrue(too_large['diagnosticsTruncated'])


if __name__=='__main__':unittest.main()
