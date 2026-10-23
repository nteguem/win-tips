"""Exact response caching never caches a successful guard decision."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from editorial_worker import translation as t
from editorial_worker.vendor import rdj_translation as guard
from test_translation import fixture, response


class ResponseCacheTests(unittest.TestCase):
    source = 'Brest a gagné trois matchs.'
    english = 'Brest won three matches.'

    def translator(self, directory, calls, **config):
        def request(model, prompt, remaining):
            calls.append({'model': model, 'prompt': prompt})
            return response(self.english)
        return t.LocalTranslator(t.TranslationConfig(fallback_model=None, **config),
                                 cache_dir=directory, request=request)

    def test_guard_only_revision_reuses_exact_response_and_revalidates_it(self):
        with tempfile.TemporaryDirectory() as directory:
            calls=[]
            item=fixture()['items'][0]
            first=self.translator(directory,calls)
            first.sentence(self.source,item)
            original=json.loads(next(Path(directory).glob('*.json')).read_text('utf8'))
            with patch.object(guard,'GUARD_VERSION','stronger-test-guard'):
                second=self.translator(directory,calls)
                self.assertEqual(second.sentence(self.source,item),self.english)
                self.assertEqual(len(calls),1)
                proof=second.records[-1]['proof']
                self.assertEqual(proof['guard_version'],'stronger-test-guard')
                self.assertTrue(second.records[-1]['attempts'][-1]['cached'])
            saved=json.loads(next(Path(directory).glob('*.json')).read_text('utf8'))
            self.assertEqual(saved['response'],original['response'])
            self.assertEqual(saved['identity'],original['identity'])
            self.assertEqual(saved['generatedGuardVersion'],original['generatedGuardVersion'])
            self.assertEqual(saved['validatedGuardVersion'],'stronger-test-guard')

    def test_strengthened_guard_rejects_old_success_and_cannot_trust_cached_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            calls=[]
            item=fixture()['items'][0]
            first=self.translator(directory,calls)
            first.sentence(self.source,item)
            real_validate=t.LocalTranslator._validate
            def stronger(*args):
                target,proof=real_validate(*args)
                proof['passed']=False
                proof['errors'].append('new_fact_rule_rejects_this_response')
                return target,proof
            second=self.translator(directory,calls)
            with patch.object(guard,'GUARD_VERSION','stronger-test-guard'), patch.object(t.LocalTranslator,'_validate',staticmethod(stronger)):
                with self.assertRaises(t.TranslationRejected) as caught:
                    second.sentence(self.source,item)
            self.assertEqual(caught.exception.code,'translation_models_exhausted')
            self.assertEqual(len(calls),2) # A fresh response can be tried; it too failed.
            self.assertEqual(second.records,[])
            errors=caught.exception.audit['attempts'][0]['cacheRejectionErrors']
            self.assertIn('new_fact_rule_rejects_this_response',errors)

    def test_changed_exact_prompt_requires_real_new_request(self):
        with tempfile.TemporaryDirectory() as directory:
            calls=[]; item=fixture()['items'][0]
            self.translator(directory,calls).sentence(self.source,item)
            original=t._prompt
            with patch.object(t,'_prompt',lambda *a:original(*a)+'\nNew exact transport instruction.'):
                self.translator(directory,calls).sentence(self.source,item)
            self.assertEqual(len(calls),2)
            self.assertNotEqual(calls[0]['prompt'],calls[1]['prompt'])
            self.assertEqual(len(list(Path(directory).glob('*.json'))),2)

    def test_changed_fact_frame_even_with_same_source_and_prompt_is_not_reused(self):
        for field in ['odds','startsAtUtc','homeAway']:
            with self.subTest(field=field),tempfile.TemporaryDirectory() as directory:
                calls=[]; item=fixture()['items'][0]
                self.translator(directory,calls).sentence(self.source,item)
                changed=deepcopy(item)
                if field=='odds':changed['selection']['odds']=3.5
                elif field=='startsAtUtc':changed['startsAtUtc']='2026-10-23T19:00:00Z'
                else:changed['teams']['home'],changed['teams']['away']=changed['teams']['away'],changed['teams']['home']
                self.translator(directory,calls).sentence(self.source,changed)
                self.assertEqual(len(calls),2)
                self.assertEqual(calls[0]['prompt'],calls[1]['prompt'])

    def test_changing_model_or_request_options_invalidates_response_identity(self):
        for config in [{'model':'qwen-different-model'},{'num_threads':1},{'endpoint':'http://127.0.0.1:11440/api/'}]:
            with self.subTest(config=config),tempfile.TemporaryDirectory() as directory:
                calls=[]; item=fixture()['items'][0]
                self.translator(directory,calls).sentence(self.source,item)
                self.translator(directory,calls,**config).sentence(self.source,item)
                self.assertEqual(len(calls),2)

    def test_adding_english_only_does_not_change_french_fact_context(self):
        with tempfile.TemporaryDirectory() as directory:
            calls=[]; item=fixture()['items'][0]
            self.translator(directory,calls).sentence(self.source,item)
            enriched=deepcopy(item)
            enriched['title']['en']='Brest versus Nice'
            enriched['summary']['en']='Summary'
            enriched['analysis']['en']=[{'heading':'Match analysis','paragraphs':['Brest won three matches.']}]
            enriched['selection']['label']['en']='Brest to win'
            self.translator(directory,calls).sentence(self.source,enriched)
            self.assertEqual(len(calls),1)

    def test_source_bytes_change_even_if_meaning_is_similar_is_not_a_cache_hit(self):
        with tempfile.TemporaryDirectory() as directory:
            calls=[]; item=fixture()['items'][0]
            self.translator(directory,calls).sentence(self.source,item)
            self.translator(directory,calls).sentence(self.source.replace('trois','3'),item)
            self.assertEqual(len(calls),2)

    def test_next_hour_recheck_with_identical_recollected_facts_keeps_response(self):
        with tempfile.TemporaryDirectory() as directory:
            calls=[]
            item=fixture()['items'][0]
            with patch.object(t.time,'monotonic',return_value=100):
                self.translator(directory,calls).sentence(self.source,item)
            # A collector produces a fresh object on the next hourly pass.
            # Its transport/report collection time is not an item field.
            recollected=json.loads(json.dumps(item,ensure_ascii=False))
            with patch.object(t.time,'monotonic',return_value=3700):
                second=self.translator(directory,calls)
                self.assertEqual(second.sentence(self.source,recollected),self.english)
            self.assertEqual(len(calls),1)
            self.assertTrue(second.records[-1]['attempts'][-1]['cached'])

    def test_tampered_identity_is_rejected_without_starting_model(self):
        with tempfile.TemporaryDirectory() as directory:
            calls=[]; item=fixture()['items'][0]
            self.translator(directory,calls).sentence(self.source,item)
            path=next(Path(directory).glob('*.json'))
            record=json.loads(path.read_text('utf8'));record['identity']['factContextSha256']='wrong'
            path.write_text(json.dumps(record),'utf8')
            with self.assertRaisesRegex(t.TranslationRejected,'translation_cache_identity_mismatch'):
                self.translator(directory,calls).sentence(self.source,item)
            self.assertEqual(len(calls),1)

    def test_malformed_cache_records_and_error_responses_fail_structurally(self):
        for malformed in ['list','null_message','null_content','error','bad_metadata']:
            with self.subTest(malformed=malformed),tempfile.TemporaryDirectory() as directory:
                calls=[];item=fixture()['items'][0]
                self.translator(directory,calls).sentence(self.source,item)
                path=next(Path(directory).glob('*.json'));record=json.loads(path.read_text('utf8'))
                if malformed=='list':record=[]
                elif malformed=='null_message':record['response']['message']=None
                elif malformed=='null_content':record['response']['message']['content']=None
                elif malformed=='error':record['response']['error']='real model failed'
                else:record['generatedGuardVersion']=[]
                path.write_text(json.dumps(record),'utf8')
                with self.assertRaises(t.TranslationRejected):
                    self.translator(directory,calls).sentence(self.source,item)
                self.assertEqual(len(calls),1)

    def test_nonfinite_french_facts_cannot_get_an_identity_or_start_model(self):
        for amount in [float('nan'),float('inf'),-float('inf')]:
            with self.subTest(amount=amount),tempfile.TemporaryDirectory() as directory:
                calls=[];item=fixture()['items'][0];item['selection']['odds']=amount
                with self.assertRaisesRegex(t.TranslationRejected,'translation_fact_context_invalid'):
                    self.translator(directory,calls).sentence(self.source,item)
                self.assertEqual(calls,[])
                self.assertEqual(list(Path(directory).glob('*.json')),[])


if __name__=='__main__':unittest.main()
