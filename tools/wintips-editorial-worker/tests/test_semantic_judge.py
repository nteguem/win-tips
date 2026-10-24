"""Offline contract tests; fake verdicts are NOT a native model qualification."""
from contextlib import ExitStack
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from editorial_worker.translation import (CascadeTranslator, LocalTranslator, TranslationConfig,
    TranslationRejected, SEMANTIC_JUDGE_INSTRUCTIONS, SEMANTIC_JUDGE_SCHEMA,
    SEMANTIC_JUDGE_VERSION, validate_english_sentence)


SOURCE = 'Brest a gagné trois matchs contre Nice.'
GOOD = 'Brest won three matches against Nice.'
BAD = 'Brest won three matches against Nice in Paris.'
ITEM = {'editionDate': '2026-10-24', 'sport': {'key': 'football'},
        'teams': {'home': {'name': 'Brest'}, 'away': {'name': 'Nice'}}}


def response(text, **extra):
    return {'done': True, 'done_reason': 'stop', 'message': {'content': text}, **extra}


def verdict(faithful=True, errors=None):
    return response(json.dumps({'faithful': faithful, 'errors': errors or []}), model=TranslationConfig().model)


class SemanticJudgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = Path(self.temp.name)

    def trap(self, *args, **kwargs):
        self.fail('Unexpected transport, runtime startup or model release')

    def local(self, request=None, *, cache=None, **kwargs):
        return LocalTranslator(cache_dir=cache or self.cache, request=request or self.trap,
            semantic_judge_enabled=True, **kwargs)

    def primary(self, request=None, *, cache=None, **kwargs):
        return CascadeTranslator(mt_request=self.trap, mt_model='offline-test-only',
            request=request or self.trap, cache_dir=cache or self.cache,
            qwen_primary=True, semantic_judge_enabled=True, **kwargs)

    def test_strict_closed_json_accepts_only_consistent_boolean_and_known_codes(self):
        parse = LocalTranslator._parse_semantic_verdict
        self.assertEqual(parse(verdict()), {'faithful': True, 'errors': []})
        self.assertEqual(parse(verdict(False, ['result_changed']))['errors'], ['result_changed'])
        bad = [
            '', 'true', '[]', 'null', '```json\n{"faithful":true,"errors":[]}\n```',
            '{"faithful":true,"errors":[],"reason":"because"}',
            '{"faithful":true,"faithful":false,"errors":[]}',
            '{"faithful":1,"errors":[]}', '{"faithful":"true","errors":[]}',
            '{"faithful":false,"errors":[]}', '{"faithful":true,"errors":["result_changed"]}',
            '{"faithful":false,"errors":["invented_code"]}',
            '{"faithful":false,"errors":["result_changed","result_changed"]}',
            '{"faithful":false,"errors":[null]}', '{"faithful":NaN,"errors":[]}',
        ]
        for text in bad:
            with self.subTest(text=text), self.assertRaises(TranslationRejected) as rejected:
                parse(response(text))
            self.assertEqual(rejected.exception.code, 'semantic_judge_response_invalid')
        for result in [response('{}', done=False), response('{}', done_reason='length'),
                       {'message': {'content': '{}'}}, response('{}', error='failed'),
                       response({'faithful': True}), {'done': True, 'message': 'wrong'}]:
            with self.subTest(result=result), self.assertRaises(TranslationRejected):
                parse(result)

    def test_actual_loopback_request_uses_closed_schema_bounded_tokens_and_separate_data_message(self):
        captured=[]
        class Reply:
            def __enter__(self): return self
            def __exit__(self,*args): return False
            def read(self,maximum): return json.dumps(verdict()).encode()
        class Opener:
            def open(self,request,timeout):
                captured.append((request,timeout))
                return Reply()
        with patch('editorial_worker.translation.build_opener',return_value=Opener()):
            translator=LocalTranslator(cache_dir=self.cache,semantic_judge_enabled=True)
            self.assertTrue(translator.judge_candidate(SOURCE,SOURCE,GOOD,ITEM)['faithful'])
        request,timeout=captured[0]
        body=json.loads(request.data)
        self.assertEqual(request.full_url,'http://127.0.0.1:11439/api/chat')
        self.assertEqual(body['format'],SEMANTIC_JUDGE_SCHEMA)
        self.assertEqual(body['options']['num_predict'],192)
        self.assertFalse(body['stream'])
        self.assertEqual(body['messages'][0]['role'],'system')
        self.assertEqual(body['messages'][1]['role'],'user')
        self.assertEqual(json.loads(body['messages'][1]['content'])['candidateEn'],GOOD)
        self.assertLessEqual(timeout,translator.config.request_timeout)

    def test_native_response_model_identity_is_required_and_no_wrong_model_is_accepted(self):
        for model in [None,'translategemma:4b','qwen-different']:
            with self.subTest(model=model):
                result=verdict()
                if model is None: result.pop('model')
                else: result['model']=model
                translator=self.local(lambda *args:result,cache=self.cache/str(model))
                with self.assertRaises(TranslationRejected) as error:
                    translator.judge_candidate(SOURCE,SOURCE,GOOD,ITEM)
                self.assertEqual(error.exception.code,'semantic_judge_response_model_mismatch')

    def test_native_identity_contains_exact_source_context_candidate_fixture_and_contract(self):
        calls = []
        paragraph = 'Brest reste en forme.\n' + SOURCE
        snapshot = deepcopy(ITEM)
        translator = self.local(lambda model, prompt, remaining: calls.append((model, prompt, remaining)) or verdict())
        result = translator.judge_candidate(SOURCE, paragraph, GOOD, ITEM)
        self.assertTrue(result['faithful'])
        self.assertEqual(ITEM, snapshot)
        self.assertEqual(len(calls), 1)
        record = json.loads(next((self.cache/'semantic-judge').glob('*.json')).read_text('utf-8'))
        identity = record['identity']
        self.assertEqual(identity['sourceSegmentFr'].encode(), SOURCE.encode())
        self.assertEqual(identity['sourceParagraphFr'].encode(), paragraph.encode())
        self.assertEqual(identity['candidateEn'].encode(), GOOD.encode())
        self.assertEqual(identity['format'], SEMANTIC_JUDGE_SCHEMA)
        self.assertEqual(identity['options']['num_predict'], 192)
        self.assertEqual(record['response'], verdict())
        self.assertNotIn('validation', record)

    def test_target_context_fixture_and_prompt_changes_cannot_reuse_a_verdict(self):
        calls = []
        translator = self.local(lambda *a: calls.append(a) or verdict())
        a = translator.judge_candidate(SOURCE, SOURCE, GOOD, ITEM)
        b = translator.judge_candidate(SOURCE, SOURCE, BAD, ITEM)
        c = translator.judge_candidate(SOURCE, 'Brest reste en forme. ' + SOURCE, GOOD, ITEM)
        other = deepcopy(ITEM); other['editionDate'] = '2026-10-25'
        d = translator.judge_candidate(SOURCE, SOURCE, GOOD, other)
        self.assertEqual(len(calls), 4)
        self.assertEqual(len({x['cacheKey'] for x in (a,b,c,d)}), 4)
        with patch('editorial_worker.translation.SEMANTIC_JUDGE_INSTRUCTIONS', SEMANTIC_JUDGE_INSTRUCTIONS + ' Contract changed.'):
            e = translator.judge_candidate(SOURCE, SOURCE, GOOD, ITEM)
        self.assertNotEqual(e['cacheKey'], a['cacheKey'])

    def test_v2_scoped_examples_change_identity_without_reusing_or_rewriting_v1_verdict(self):
        calls=[]
        translator=self.local(lambda *args:calls.append(args) or verdict())
        with patch('editorial_worker.translation.SEMANTIC_JUDGE_VERSION','wintips-contextual-faithfulness-v1'):
            old=translator.judge_candidate(SOURCE,SOURCE,GOOD,ITEM)
        old_path=self.cache/'semantic-judge'/(old['cacheKey']+'.json')
        old_bytes=old_path.read_bytes()
        current=translator.judge_candidate(SOURCE,SOURCE,GOOD,ITEM)
        self.assertEqual(len(calls),2)
        self.assertNotEqual(current['cacheKey'],old['cacheKey'])
        self.assertEqual(old_path.read_bytes(),old_bytes)
        self.assertIn('v2',SEMANTIC_JUDGE_VERSION)
        self.assertIn('Compare uniquement sourceSegmentFr et candidateEn',SEMANTIC_JUDGE_INSTRUCTIONS)
        self.assertIn("leur absence n'est PAS une erreur",SEMANTIC_JUDGE_INSTRUCTIONS)
        self.assertEqual(SEMANTIC_JUDGE_INSTRUCTIONS.count('Contexte :'),2)
        self.assertIn('3. Phrase FR',SEMANTIC_JUDGE_INSTRUCTIONS)
        self.assertNotIn('Celle-ci lost on the pitch',SEMANTIC_JUDGE_INSTRUCTIONS)
        self.assertNotIn('Ceramica',SEMANTIC_JUDGE_INSTRUCTIONS)
        self.assertNotIn('Girona',SEMANTIC_JUDGE_INSTRUCTIONS)

    def test_cache_is_reparsed_and_stale_acceptance_metadata_never_overrides_raw_rejection(self):
        first = self.local(lambda *a: verdict())
        result = first.judge_candidate(SOURCE, SOURCE, GOOD, ITEM)
        path = self.cache/'semantic-judge'/(result['cacheKey']+'.json')
        data = json.loads(path.read_text('utf-8'))
        data.update({'passed': True, 'validation': {'passed': True}})
        data['response'] = verdict(False, ['result_changed'])
        path.write_text(json.dumps(data), encoding='utf-8')
        before = path.read_bytes()
        second = self.local()
        checked = second.judge_candidate(SOURCE, SOURCE, GOOD, ITEM, cache_only=True)
        self.assertFalse(checked['faithful'])
        self.assertTrue(checked['cached'])
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(second.semantic_judge_requests, 0)

    def test_invalid_identity_or_raw_cached_json_fails_closed_without_transport(self):
        for mutation in ['identity', 'response']:
            with self.subTest(mutation=mutation):
                directory=self.cache/mutation
                first=self.local(lambda *a: verdict(),cache=directory)
                result=first.judge_candidate(SOURCE,SOURCE,GOOD,ITEM)
                path=directory/'semantic-judge'/(result['cacheKey']+'.json')
                data=json.loads(path.read_text('utf-8'))
                if mutation=='identity': data['identity']['candidateEn']=BAD
                else: data['response']=response('not json')
                path.write_text(json.dumps(data),encoding='utf-8')
                with self.assertRaises(TranslationRejected):
                    self.local(cache=directory).judge_candidate(SOURCE,SOURCE,GOOD,ITEM)

    def test_cache_only_missing_verdict_never_starts_runtime_but_normal_route_judges(self):
        seed = LocalTranslator(cache_dir=self.cache/'qwen', request=lambda *a: response(GOOD))
        self.assertEqual(seed.sentence(SOURCE, ITEM), GOOD)
        original = {p:p.read_bytes() for p in (self.cache/'qwen').glob('*.json')}
        calls=[]; starts=[]
        def request(model,prompt,remaining):
            calls.append(prompt)
            self.assertTrue(prompt.startswith(SEMANTIC_JUDGE_INSTRUCTIONS))
            return verdict()
        translator=self.primary(request,ensure_fallback_ready=lambda:starts.append(True))
        self.assertEqual(translator.sentence(SOURCE,ITEM),GOOD)
        self.assertEqual(len(calls),1)
        self.assertEqual(starts,[True])
        self.assertTrue(all(p.read_bytes()==b for p,b in original.items()))
        replay=self.primary(ensure_fallback_ready=self.trap,release_model=self.trap)
        self.assertEqual(replay.sentence(SOURCE,ITEM),GOOD)
        self.assertFalse(replay.fallback_ready)
        self.assertTrue(replay.records[-1]['proof']['semanticJudge']['cached'])

    def test_content_rejection_uses_existing_retry_feedback_and_separate_qwen_model_lease(self):
        self.assertTrue(validate_english_sentence(SOURCE,BAD,ITEM)[1]['passed'],
                        'This fixture demonstrates an extra relation beyond the lexical guard')
        calls=[]; releases=[]; started=[]
        def request(model,prompt,remaining):
            calls.append((model,prompt,remaining))
            if prompt.startswith(SEMANTIC_JUDGE_INSTRUCTIONS):
                candidate=json.loads(prompt.rsplit('\n\n\n',1)[1])['candidateEn']
                return verdict(candidate==GOOD, [] if candidate==GOOD else ['unsupported_addition'])
            return response(BAD if model.startswith('qwen') else GOOD)
        translator=self.primary(request,ensure_fallback_ready=lambda:started.append(True),
            release_model=lambda model,remaining:releases.append(model))
        self.assertEqual(translator.text(SOURCE,ITEM),GOOD)
        self.assertEqual(len(calls),4)
        self.assertEqual(started,[True])
        self.assertEqual(releases,[translator.config.model,translator.config.fallback_model])
        repair=next(prompt for model,prompt,_ in calls if model==translator.config.fallback_model)
        self.assertIn('semantic_unsupported_addition',repair)
        self.assertIn('sourceParagraphFr',repair)
        self.assertEqual(repair.rsplit('\n\n\n',1)[1],SOURCE)
        self.assertTrue(translator.records[-1]['proof']['semanticJudge']['faithful'])
        self.assertEqual(translator.semantic_judge_requests,2)

    def test_all_content_rejections_still_have_at_most_three_translation_attempts(self):
        calls=[]
        def request(model,prompt,remaining):
            calls.append((model,prompt))
            return verdict(False,['meaning_omitted']) if prompt.startswith(SEMANTIC_JUDGE_INSTRUCTIONS) else response(GOOD)
        translator=self.primary(request,release_model=lambda *a:None)
        with self.assertRaises(TranslationRejected) as error:
            translator.sentence(SOURCE,ITEM)
        self.assertEqual(error.exception.code,'translation_models_exhausted')
        self.assertEqual(sum(not p.startswith(SEMANTIC_JUDGE_INSTRUCTIONS) for _,p in calls),3)
        self.assertEqual(translator.records,[])

    def test_malformed_timeout_and_failed_unload_are_technical_not_content_retries(self):
        for failure,code in [(response('not json',model=TranslationConfig().model),'semantic_judge_response_invalid'),
                             (TimeoutError('offline'),'semantic_judge_transport_failed'),
                             (TranslationRejected('model_unload_not_confirmed'),'semantic_judge_model_unload_not_confirmed'),
                             (TranslationRejected('translation_time_budget_exceeded'),'semantic_judge_time_budget_exceeded')]:
            with self.subTest(code=code):
                calls=[]
                def request(model,prompt,remaining):
                    calls.append(prompt)
                    if prompt.startswith(SEMANTIC_JUDGE_INSTRUCTIONS):
                        if isinstance(failure,Exception): raise failure
                        return failure
                    return response(GOOD)
                translator=self.primary(request,cache=self.cache/code,release_model=lambda *a:None)
                with self.assertRaises(TranslationRejected) as error: translator.sentence(SOURCE,ITEM)
                self.assertEqual(error.exception.code,code)
                self.assertEqual(len(calls),2)
                self.assertEqual(translator.records,[])

    def test_low_level_local_judge_model_failure_never_falls_back_to_gemma(self):
        calls=[]
        def request(model,prompt,remaining):
            calls.append((model,prompt))
            if prompt.startswith(SEMANTIC_JUDGE_INSTRUCTIONS):
                raise TranslationRejected('local_model_failed')
            return response(GOOD)
        translator=self.local(request)
        with self.assertRaises(TranslationRejected) as rejected:
            translator.text(SOURCE,ITEM)
        self.assertEqual(rejected.exception.code,'semantic_judge_model_failed')
        self.assertEqual(len(calls),2)
        self.assertTrue(all(model==translator.config.model for model,_ in calls))
        self.assertEqual(translator.records,[])

    def test_same_deadline_covers_translation_and_judge_and_rejects_late_success(self):
        calls=[]; translator=None
        def request(model,prompt,remaining):
            calls.append(remaining)
            if prompt.startswith(SEMANTIC_JUDGE_INSTRUCTIONS):
                translator.started-=translator.config.max_seconds+1
                return verdict()
            return response(GOOD)
        translator=self.primary(request)
        with self.assertRaises(TranslationRejected) as error: translator.sentence(SOURCE,ITEM)
        self.assertEqual(error.exception.code,'semantic_judge_time_budget_exceeded')
        self.assertEqual(len(calls),2)
        self.assertLessEqual(calls[1],calls[0])
        self.assertEqual(translator.records,[])

    def test_full_original_paragraph_supplies_anaphora_context_without_mutating_fr(self):
        source='Brest a gagné trois matchs contre Nice. Il reste en forme.'
        candidates={SOURCE:GOOD,'Il reste en forme.':'It remains in good form.'}
        captured=[]
        def request(model,prompt,remaining):
            if prompt.startswith(SEMANTIC_JUDGE_INSTRUCTIONS):
                captured.append(json.loads(prompt.rsplit('\n\n\n',1)[1]))
                return verdict()
            return response(candidates[prompt.rsplit('\n\n\n',1)[1]])
        translator=self.local(request)
        original=source.encode()
        self.assertEqual(translator.text(source,ITEM),GOOD+' It remains in good form.')
        self.assertEqual(len(captured),2)
        self.assertTrue(all(x['sourceParagraphFr'].encode()==original for x in captured))
        self.assertEqual(captured[1]['sourceSegmentFr'],'Il reste en forme.')
        self.assertIsNone(translator._source_paragraph_fr)
        self.assertEqual(source.encode(),original)

    def test_known_bad_contexts_are_sent_intact_to_native_judge_not_handwritten_repaired(self):
        # Fake transport tests wiring only. Root qualifies these against REAL Qwen separately.
        cases=[('Celle-ci a été décrochée à domicile.',
                'Brest a remporté une victoire. Celle-ci a été décrochée à domicile.',
                'This was lost at home.','result_changed'),
               ('Ils ont gagné au stade de la Ceramica.',
                'La Ceramica est le stade du club. Ils ont gagné au stade de la Ceramica.',
                'They won against the Ceramica.','venue_opponent_confused')]
        seen=[]
        def request(model,prompt,remaining):
            values=json.loads(prompt.rsplit('\n\n\n',1)[1]);seen.append(values)
            return verdict(False,[cases[len(seen)-1][3]])
        translator=self.local(request)
        for source,context,target,code in cases:
            checked=translator.judge_candidate(source,context,target,ITEM)
            self.assertFalse(checked['faithful'])
            self.assertEqual(checked['errors'],[code])
            self.assertEqual(seen[-1]['sourceParagraphFr'],context)
            self.assertEqual(seen[-1]['candidateEn'],target)

    def test_oversize_or_unrelated_context_is_never_silently_truncated(self):
        translator=self.local()
        for context,code in [('unrelated context','semantic_judge_context_invalid'),
                             (SOURCE+' '*12000+'fin','semantic_judge_context_too_large')]:
            with self.subTest(code=code),self.assertRaises(TranslationRejected) as error:
                translator.judge_candidate(SOURCE,context,GOOD,ITEM)
            self.assertEqual(error.exception.code,code)
        self.assertEqual(translator.semantic_judge_requests,0)

    def test_production_factory_and_both_runner_providers_always_enable_judge(self):
        from editorial_worker import mt_translation,runner
        transport=SimpleNamespace(model_id='offline-only',manifest_sha256='f'*64)
        with patch.object(mt_translation,'MarianTransport',return_value=transport),patch.dict('os.environ',
                {'WINTIPS_EDITORIAL_QWEN_PRIMARY':'true','WINTIPS_EDITORIAL_MANAGE_MODEL':'false',
                 'WINTIPS_EDITORIAL_SEMANTIC_JUDGE':'false'},clear=False):
            direct=mt_translation.create_translator_from_env(self.cache)
            self.assertTrue(direct.semantic_judge_enabled)
            for mode in ('marian','ollama'):
                with self.subTest(mode=mode),patch.dict('os.environ',{'WINTIPS_EDITORIAL_TRANSLATOR':mode}),ExitStack() as resources:
                    translator=runner.make_translator(SimpleNamespace(translation_max_seconds=1200),self.cache,resources)
                    self.assertTrue(translator.semantic_judge_enabled)
                    self.assertIsInstance(translator,CascadeTranslator)
                    self.assertTrue(translator.qwen_primary)

    def test_default_ollama_provider_is_lazy_and_releases_gemma_before_qwen_judgment(self):
        from editorial_worker import runner
        calls=[]; releases=[]
        def request(translator,model,prompt,remaining):
            calls.append((model,prompt))
            if prompt.startswith(SEMANTIC_JUDGE_INSTRUCTIONS):
                candidate=json.loads(prompt.rsplit('\n\n\n',1)[1])['candidateEn']
                return verdict(candidate==GOOD,[] if candidate==GOOD else ['unsupported_addition'])
            return response(BAD if model.startswith('qwen') else GOOD)
        with patch.dict('os.environ',{'WINTIPS_EDITORIAL_TRANSLATOR':'ollama',
                'WINTIPS_EDITORIAL_MANAGE_MODEL':'false'}),patch.object(LocalTranslator,'_request',request),ExitStack() as resources:
            translator=runner.make_translator(SimpleNamespace(translation_max_seconds=1200),self.cache,resources)
            self.assertFalse(translator.fallback_ready)
            self.assertIsNone(translator.last_requested_model)
            self.assertFalse(calls)
            translator.release_model=lambda model,remaining:releases.append(model)
            with patch.object(translator.mt,'request',self.trap):
                self.assertEqual(translator.text(SOURCE,ITEM),GOOD)
            self.assertEqual([model for model,_ in calls],
                [translator.config.model,translator.config.model,translator.config.fallback_model,translator.config.model])
            self.assertEqual(releases,[translator.config.model,translator.config.fallback_model])
            self.assertFalse(translator.records[-1]['mtAccepted'])

    def test_default_ollama_provider_keeps_three_attempt_limit_with_no_mt_prose(self):
        from editorial_worker import runner
        calls=[]
        def request(translator,model,prompt,remaining):
            calls.append((model,prompt))
            return verdict(False,['meaning_omitted']) if prompt.startswith(SEMANTIC_JUDGE_INSTRUCTIONS) else response(GOOD)
        with patch.dict('os.environ',{'WINTIPS_EDITORIAL_TRANSLATOR':'ollama',
                'WINTIPS_EDITORIAL_MANAGE_MODEL':'false'}),patch.object(LocalTranslator,'_request',request),ExitStack() as resources:
            translator=runner.make_translator(SimpleNamespace(translation_max_seconds=1200),self.cache,resources)
            translator.release_model=lambda *args:None
            with patch.object(translator.mt,'request',self.trap),self.assertRaises(TranslationRejected):
                translator.text(SOURCE,ITEM)
            translations=[model for model,prompt in calls if not prompt.startswith(SEMANTIC_JUDGE_INSTRUCTIONS)]
            self.assertEqual(translations,[translator.config.model,translator.config.fallback_model,translator.config.model])
            self.assertEqual(translator.records,[])


if __name__=='__main__':
    unittest.main()
