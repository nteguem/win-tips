"""V4 subset repair, native bindings and spend limits. No external transport."""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from editorial_worker import gemini_translation as gemini
from editorial_worker.translation import TranslationRejected


KEY = 'onlyAnOfflineTestCredential12345'
ITEM = {'sport': {'key': 'football'}, 'teams': {'home': {'name': 'Brest'}, 'away': {'name': 'Nice'}}}
SOURCES = ['Brest a gagné 2 matchs.', 'Nice concède 3 unités de débours sur la 4ème place.',
    'Nice a perdu 1 match.']


def envelope(rows):
    return {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [
        {'text': json.dumps({'translations': rows})}]}}]}


def translated(text):
    return text.replace('a gagné', 'won').replace('matchs', 'matches').replace('a perdu', 'lost').replace(
        'match.', 'match.').replace('concède', 'is').replace('unités de débours sur la', 'points behind').replace('place.', 'place.')


class Native:
    def __init__(self, mutate=None, initial_bad=('1',)):
        self.feedback, self.calls = None, []
        self.mutate, self.initial_bad = mutate, initial_bad

    def set_feedback(self, value): self.feedback = deepcopy(value)

    def __call__(self, texts, timeout):
        ids = self.feedback['fragmentIds'] if self.feedback else [str(i) for i in range(len(texts))]
        self.calls.append({'texts': deepcopy(texts), 'feedback': deepcopy(self.feedback), 'ids': ids})
        rows = [{'id': key, 'text': translated(text)} for key, text in zip(ids, texts)]
        if len(self.calls) == 1:
            for row in rows:
                if row['id'] in self.initial_bad: row['text'] = row['text'].replace('</div>', ' 3 points</div>')
        if self.mutate: self.mutate(self, rows)
        self.calls[-1]['rows'] = deepcopy(rows)
        return envelope(rows)


class SubsetRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = gemini.GeminiConfig(KEY)

    def translator(self, request, **options):
        return gemini.GeminiTranslator(options.pop('config', self.config), cache_dir=self.root,
            quota_dir=self.root/'quota', request=request,
            now=lambda: datetime(2026, 10, 24, tzinfo=timezone.utc), sleep=lambda _: None, **options)

    def jobs(self, translator): return [translator.job(source, deepcopy(ITEM)) for source in SOURCES]

    def test_subset_uses_original_ids_preserves_good_native_bytes_and_binds_each_cache(self):
        native = Native(); translator = self.translator(native); jobs = self.jobs(translator)
        original = deepcopy(jobs); translator.send(jobs)
        self.assertEqual(jobs, original)
        self.assertEqual([row['ids'] for row in native.calls], [['0', '1', '2'], ['1']])
        self.assertEqual(native.calls[1]['texts'], [jobs[1]['html']])
        self.assertIsNone(native.feedback)
        self.assertTrue(translator.attempts[-1]['completeBatchRevalidated'])
        keys = [row['nativeResponseKey'] for row in translator.attempts]
        for index, job in enumerate(jobs):
            record = json.loads((self.root/'gemini/responses'/(job['key']+'.json')).read_bytes())
            call = native.calls[1] if index == 1 else native.calls[0]
            raw_row = next(row for row in call['rows'] if row['id'] == str(index))
            self.assertEqual(record['html'], raw_row['text'])
            self.assertEqual(record['nativeFragmentId'], str(index))
            self.assertEqual(record['nativeResponseKey'], keys[1 if index == 1 else 0])
        replay = self.translator(lambda *a: self.fail('Native cache must not spend'))
        self.assertTrue(all(replay.cached(job) for job in self.jobs(replay)))
        self.assertEqual(replay.requests, 0)

    def test_diagnostic_locates_free_duplicate_and_typed_deficit_rank(self):
        native = Native(); translator = self.translator(native); translator.send(self.jobs(translator))
        feedback = native.calls[1]['feedback']; diagnostic = feedback['rejections'][0]['diagnostics']
        number = next(row for row in diagnostic['unprotectedNumbers'] if row['value'] == '3')
        self.assertEqual(len(number['duplicatesProtectedSpans']), 1)
        self.assertEqual(number['duplicatesProtectedSpans'][0]['value'], '3')
        relation = diagnostic['typedRelations'][0]
        self.assertEqual(relation['type'], 'points_deficit_to_rank')
        self.assertNotEqual(relation['quantitySpanId'], relation['rankSpanId'])
        payload = gemini.request_payload(self.config, native.calls[1]['texts'], feedback)
        data = json.loads(payload['contents'][0]['parts'][0]['text'])
        self.assertEqual(data['fragments'], [{'id': '1', 'text': native.calls[0]['texts'][1]}])
        self.assertEqual(data['contentRepairFeedback'], feedback)
        self.assertNotIn('Everton', payload['systemInstruction']['parts'][0]['text'])

    def test_actual_failed_native_duplicate_stays_rejected_and_is_localized(self):
        case = json.loads((Path(__file__).parent/'fixtures/gemini-subset-repair-20261024.json').read_bytes())
        translator = self.translator(Native()); job = translator.job(case['source'], case['item'])
        with self.assertRaises(TranslationRejected) as caught:
            gemini._validated(job['source'], job['item'], case['candidateHtml'])
        self.assertEqual(caught.exception.code, 'gemini_unprotected_number_added')
        diagnostics = gemini._repair_diagnostics(job, case['candidateHtml'])
        duplicate = next(row for row in diagnostics['unprotectedNumbers'] if row['value'] == '3')
        self.assertEqual(duplicate['duplicatesProtectedSpans'], [{'id': 'wt3', 'value': '3'}])
        self.assertEqual(diagnostics['typedRelations'][0]['quantitySpanId'], 'wt3')
        self.assertEqual(diagnostics['typedRelations'][0]['rankSpanId'], 'wt4')

    def test_typed_guidance_does_not_create_deficit_from_ahead_or_other_units(self):
        translator = self.translator(Native())
        for source in (SOURCES[1].replace('débours', 'avance'), SOURCES[1].replace('unités', 'joueurs')):
            job = translator.job(source, ITEM)
            self.assertEqual(gemini._repair_diagnostics(job, job['html'])['typedRelations'], [])

    def test_score_changed_in_repaired_row_stays_rejected(self):
        def mutate(native, rows):
            if len(native.calls) > 1: rows[0]['text'] = rows[0]['text'].replace('>1-0<', '>0-1<')
        native = Native(mutate, initial_bad=('0',)); translator = self.translator(native)
        jobs = [translator.job('Brest a gagné (1-0).', ITEM)]
        with self.assertRaises(TranslationRejected): translator.send(jobs)
        self.assertEqual(translator.prepared, {})

    def test_two_rejected_rows_keep_non_contiguous_original_ids(self):
        native = Native(initial_bad=('0', '2')); translator = self.translator(native)
        translator.send(self.jobs(translator))
        self.assertEqual(native.calls[1]['ids'], ['0', '2'])
        self.assertEqual(len(translator.prepared), 3)

    def test_persistent_error_has_one_repair_and_exposes_no_partial_batch(self):
        def mutate(native, rows):
            if len(native.calls) > 1: rows[0]['text'] += ' 7 wins'
        native = Native(mutate); translator = self.translator(native)
        with self.assertRaises(TranslationRejected): translator.send(self.jobs(translator))
        self.assertEqual(len(native.calls), 2); self.assertEqual(translator.prepared, {})
        self.assertFalse((self.root/'gemini/responses').exists())

    def test_unknown_duplicate_or_good_ids_cannot_replace_requested_subset(self):
        for mode in ('unknown', 'good', 'duplicate', 'omitted'):
            def mutate(native, rows):
                if len(native.calls) < 2: return
                if mode == 'unknown': rows[0]['id'] = '9'
                if mode == 'good': rows[0]['id'] = '0'
                if mode == 'duplicate': rows.append(deepcopy(rows[0]))
                if mode == 'omitted': rows.clear()
            with self.subTest(mode=mode):
                native = Native(mutate); translator = self.translator(native)
                with self.assertRaises(TranslationRejected): translator.send(self.jobs(translator))
                self.assertEqual(translator.prepared, {})

    def test_repaired_quantity_rank_actor_and_score_mutations_are_rejected(self):
        for old, new in (('>3<', '>4<'), ('>4th<', '>5th<'), ('>Nice<', '>Brest<')):
            def mutate(native, rows):
                if len(native.calls) > 1: rows[0]['text'] = rows[0]['text'].replace(old, new)
            with self.subTest(new=new):
                native = Native(mutate); translator = self.translator(native)
                with self.assertRaises(TranslationRejected): translator.send(self.jobs(translator))
                self.assertEqual(translator.prepared, {})

    def test_full_batch_is_revalidated_including_initial_good_rows(self):
        native = Native(); translator = self.translator(native); jobs = self.jobs(translator)
        original = gemini._validated
        def validate(source, item, html):
            if len(native.calls) == 2 and source == SOURCES[0]: raise TranslationRejected('gemini_changed_guard')
            return original(source, item, html)
        with patch.object(gemini, '_validated', side_effect=validate), self.assertRaises(TranslationRejected):
            translator.send(jobs)
        self.assertEqual(translator.prepared, {})
        self.assertFalse((self.root/'gemini/responses').exists())

    def test_http_retry_and_repair_share_three_requests_and_full_prompt_quota(self):
        native = Native(); attempts = []
        def request(texts, timeout):
            attempts.append(1)
            if len(attempts) == 1: raise gemini.GeminiFailure(429)
            return native(texts, timeout)
        request.set_feedback = native.set_feedback
        translator = self.translator(request); translator.send(self.jobs(translator))
        self.assertEqual(translator.requests, 3)
        self.assertEqual([row['textCount'] for row in translator.attempts], [3, 3, 1])
        used = json.loads((self.root/'quota/usage.json').read_bytes())['days']['2026-10-24']
        self.assertEqual(used, sum(row['inputCharactersReserved'] for row in translator.attempts))

    def test_quota_or_global_deadline_before_repair_never_sends_subset(self):
        for mode in ('quota', 'deadline'):
            clock = [0]; native = Native()
            def request(texts, timeout):
                raw = native(texts, timeout)
                if mode == 'deadline': clock[0] = 181
                return raw
            request.set_feedback = native.set_feedback
            translator = self.translator(request, monotonic=lambda: clock[0])
            reserve = translator.quota.reserve
            def limited(count):
                if translator.requests: raise TranslationRejected('azure_character_quota_exhausted')
                return reserve(count)
            with self.subTest(mode=mode), patch.object(translator.quota, 'reserve', side_effect=limited if mode == 'quota' else reserve):
                with self.assertRaises(TranslationRejected): translator.send(self.jobs(translator))
                self.assertEqual(len(native.calls), 1); self.assertEqual(translator.prepared, {})

    def test_cache_native_row_binding_cannot_be_reassigned_to_another_response(self):
        native = Native(); translator = self.translator(native); jobs = self.jobs(translator); translator.send(jobs)
        path = self.root/'gemini/responses'/(jobs[0]['key']+'.json')
        record = json.loads(path.read_bytes()); record['nativeResponseKey'] = translator.attempts[1]['nativeResponseKey']
        path.write_text(json.dumps(record), encoding='utf-8')
        with self.assertRaises(TranslationRejected): self.translator(native).cached(jobs[0])

    def test_old_version_cache_identity_and_schema_ids_cannot_alias_v4(self):
        translator = self.translator(Native()); current = translator.job(SOURCES[0], ITEM)['key']
        with patch.object(gemini, 'VERSION', 'gemini-html-facts-v3-sports-bounded-repair'):
            self.assertNotEqual(current, translator.job(SOURCES[0], ITEM)['key'])
        for ids in (['1', '1'], ['0', {}], ['-1', '0']):
            with self.subTest(ids=ids), self.assertRaises(TranslationRejected): gemini._fragment_ids(2, ids)


if __name__ == '__main__': unittest.main()
