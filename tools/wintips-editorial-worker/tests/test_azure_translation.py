"""Azure transport doubles only: these tests are NOT cloud quality evidence."""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from editorial_worker.azure_translation import (
    AzureConfig, AzureFailure, AzureTranslator, AzureTransport, ENDPOINT,
    Quota, _characters, create_translator_from_env, protect, validate_output,
)
from editorial_worker.translation import TranslationRejected, translate_batch


KEY = 'testOnlyNeverAnAzureCredential123'
NOW = datetime(2026, 10, 24, 5, tzinfo=timezone.utc)


def item():
    return {'source': 'rdj_football_analysis', 'sourceId': '5802966',
        'editionDate': '2026-10-24', 'title': {'fr': 'Brest — Nice'},
        'summary': {'fr': 'Brest reste en forme.'}, 'sport': {'key': 'football'},
        'teams': {'home': {'name': 'Brest'}, 'away': {'name': 'Nice'}},
        'startsAtUtc': '2026-10-24T18:45:00Z', 'status': 'upcoming',
        'selection': {'label': {'fr': 'Victoire Brest'}, 'odds': 2.15},
        'analysis': {'fr': [{'heading': 'Analyse du match', 'paragraphs': [
            'Brest a gagné trois matchs. Nice a perdu 2 matchs (1-0).']}]}}


def english_html(value):
    # Deliberately small scripted fixture; no external provider is called.
    for source, target in [('reste en forme', 'remains in good form'),
            ('a gagné', 'won'), ('a perdu', 'lost'), ('matchs', 'matches'),
            ('Offensivement', 'Offensively'), ('ont gagné', 'won')]:
        value = value.replace(source, target)
    return value


def response(texts, timeout=None):
    return [{'translations': [{'to': 'en', 'text': english_html(value)}]} for value in texts]


class AzureTranslationTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = Path(self.directory.name)
        self.config = AzureConfig(KEY)

    def translator(self, request=response, **kw):
        return AzureTranslator(self.config, cache_dir=self.cache, quota_dir=self.cache / 'quota',
            request=request, now=lambda: NOW, **kw)

    def test_grouped_whole_paragraphs_preserve_all_fr_and_facts(self):
        calls = []
        def request(texts, timeout):
            calls.append((deepcopy(texts), timeout))
            return response(texts)
        original = {'source': 'rdj_football_analysis', 'editionDate': '2026-10-24', 'items': [item()]}
        snapshot = deepcopy(original)
        translator = self.translator(request)
        result, audit = translate_batch(original, translator)
        self.assertEqual(original, snapshot)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0][0]), 2)
        self.assertIn('Nice', calls[0][0][1])
        self.assertIn('>1-0</span>)', calls[0][0][1])
        self.assertEqual(calls[0][1], 30)
        target = result['items'][0]
        self.assertEqual(target['analysis']['en'][0]['paragraphs'], ['Brest won three matches. Nice lost 2 matches (1-0).'])
        self.assertEqual(target['selection']['label']['en'], 'Brest to win')
        self.assertEqual(target['selection']['odds'], 2.15)
        self.assertEqual(target['startsAtUtc'], snapshot['items'][0]['startsAtUtc'])
        self.assertTrue(audit['frAndStructuralFactsPreserved'])
        self.assertTrue(all(record['provider'] == 'azure' for record in audit['records']))
        self.assertTrue(all(record['proof']['semanticQualityProven'] is False for record in audit['records']))
        usage = json.loads((self.cache / 'quota/usage.json').read_bytes())
        self.assertEqual(usage['months']['2026-10'], sum(_characters(text) for text in calls[0][0]))

    def test_cache_reuses_exact_response_with_no_new_spend(self):
        def request(texts, timeout): return response(texts)
        first = self.translator(request)
        expected = first.text(item()['summary']['fr'], item())
        usage = (self.cache / 'quota/usage.json').read_bytes()
        second = self.translator(lambda *args: self.fail('No cloud request on cache hit'))
        self.assertEqual(second.text(item()['summary']['fr'], item()), expected)
        self.assertTrue(second.records[-1]['cached'])
        self.assertEqual((self.cache / 'quota/usage.json').read_bytes(), usage)

    def test_changed_source_facts_region_or_contract_do_not_reuse_cache(self):
        translator = self.translator(lambda texts, timeout: response(texts))
        source = item()['summary']['fr']
        initial = translator.job(source, item())['key']
        for altered in [dict(item(), startsAtUtc='2026-10-24T19:00:00Z'),
                        dict(item(), selection={'label': {'fr': 'Victoire Brest'}, 'odds': 2.16})]:
            self.assertNotEqual(translator.job(source, altered)['key'], initial)
        self.assertNotEqual(translator.job(source + '!', item())['key'], initial)
        regional = AzureTranslator(replace(self.config, region='francecentral'), cache_dir=self.cache, quota_dir=self.cache / 'quota')
        self.assertNotEqual(regional.job(source, item())['key'], initial)
        with patch('editorial_worker.azure_translation.VERSION', 'test-next-contract'):
            self.assertNotEqual(translator.job(source, item())['key'], initial)
        with_en = deepcopy(item())
        with_en['summary']['en'] = 'Ignored historical English'
        self.assertEqual(translator.job(source, with_en)['key'], initial)

    def test_cached_passed_metadata_cannot_hide_changed_number(self):
        source = item()['analysis']['fr'][0]['paragraphs'][0]
        translator = self.translator(lambda texts, timeout: response(texts))
        translator.text(source, item())
        path = next((self.cache / 'azure/responses').glob('*.json'))
        record = json.loads(path.read_bytes())
        record['html'] = record['html'].replace('>2<', '>9<')
        record['proof'] = {'passed': True}
        path.write_text(json.dumps(record), 'utf-8')
        with self.assertRaises(TranslationRejected):
            self.translator(lambda *a: self.fail('Corrupt cache must not cause spend')).text(source, item())

    def test_html_protection_rejects_missing_duplicated_mutated_and_injected_facts(self):
        source = item()['analysis']['fr'][0]['paragraphs'][0]
        html, anchors = protect(source, item())
        good = english_html(html)
        target, proof = validate_output(source, item(), good)
        self.assertIn('won three matches', target)
        span = re.search(r'<span[^>]+>Brest</span>', good)[0]
        bad = [good.replace(span, ''), good.replace(span, span + span),
            good.replace('>Brest<', '>Lyon<'), good.replace('>2<', '>9<'),
            good.replace('>1-0<', '>0-1<'), good.replace('</div>', ' four defeats</div>'),
            good.replace('</div>', ' one point</div>'), good.replace('</div>', ' Brest</div>'),
            good.replace('</div>', '<script>alert(1)</script></div>'),
            good.replace('<div>', '<div onclick="x()">'),
            good.replace('</div>', '<!--comment--></div>'),
            good.replace('</div>', '<span id="wt999" class="notranslate" translate="no">9</span></div>')]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(TranslationRejected):
                validate_output(source, item(), value)

    def test_names_only_and_markets_never_call_cloud(self):
        translator = self.translator(lambda *args: self.fail('Deterministic label called Azure'))
        self.assertEqual(translator.text('Brest — Nice', item()), 'Brest — Nice')
        self.assertEqual(translator.text('Analyse du match', item()), 'Match analysis')
        self.assertEqual(translator.market('Victoire Brest', item()), 'Brest to win')
        self.assertFalse((self.cache / 'quota/usage.json').exists())

    def test_name_case_variants_keep_occurrences_and_protected_spans_byte_exact(self):
        source = 'brest reste en forme.'
        target, proof = validate_output(source, item(), '<div>Brest remains in good form.</div>')
        self.assertEqual(target, 'Brest remains in good form.')
        self.assertTrue(proof['passed'])
        for html in ('<div>Nice remains in good form.</div>',
                '<div>Brest remains in good form. brest</div>',
                '<div>Brests remain in good form.</div>',
                '<div>Remains in good form.</div>'):
            with self.subTest(html=html), self.assertRaises(TranslationRejected):
                validate_output(source, item(), html)
        protected_source = 'Brest reste en forme.'
        protected_html, _ = protect(protected_source, item())
        good = english_html(protected_html)
        # Even an equivalent case change INSIDE a protected name remains invalid.
        for bad in (good.replace('>Brest<', '>brest<'), good.replace('>Brest<', '>Lyon<')):
            with self.subTest(html=bad), self.assertRaises(TranslationRejected):
                validate_output(protected_source, item(), bad)

    def test_reordering_preserved_spans_for_english_grammar_is_allowed(self):
        source = 'Brest et Nice ont gagné 3 matchs.'
        html, anchors = protect(source, item())
        spans = re.findall(r'<span[^>]+>.*?</span>', html)
        reordered = '<div>With ' + spans[2] + ' wins, ' + spans[0] + ' and ' + spans[1] + ' succeeded.</div>'
        target, proof = validate_output(source, item(), reordered)
        self.assertEqual(target, 'With 3 wins, Brest and Nice succeeded.')
        self.assertFalse(proof['lexicalOrderRequired'])

    def test_sentence_opening_adverb_is_translated_not_an_invented_proper_name(self):
        source = 'Offensivement, Brest a gagné 3 matchs.'
        result = self.translator(lambda texts, timeout: response(texts)).text(source, item())
        self.assertEqual(result, 'Offensively, Brest won 3 matches.')

    def test_safe_xml_is_constructed_from_text_not_source_markup(self):
        source = 'Brest <script> reste en forme & calme.'
        html, _ = protect(source, item())
        self.assertIn('&lt;script&gt;', html)
        self.assertIn('&amp;', html)
        target, _ = validate_output(source, item(), html.replace('reste en forme', 'remains in good form'))
        self.assertIn('<script>', target)  # plain TEXT, never returned as HTML
        self.assertNotIn('<span', target)

    def test_decimal_sign_percent_time_and_ordinal_protections_are_exact(self):
        source = 'Brest a 52,5 % de réussite, −3 points, à 20:15, au 18ème rang (1-0).'
        html, _ = protect(source, item())
        self.assertIn('>52.5 %<', html)
        self.assertIn('>-3<', html)
        self.assertIn('>20:15<', html)
        self.assertIn('>18th<', html)
        good = html.replace('a ', 'has ', 1).replace('de réussite', 'accuracy')
        validate_output(source, item(), good)
        for old, new in [('52.5 %', '52.5'), ('-3', '3'), ('20:15', '20:16'), ('18th', '19th')]:
            with self.subTest(old=old), self.assertRaises(TranslationRejected):
                validate_output(source, item(), good.replace('>' + old + '<', '>' + new + '<'))

    def test_attached_clock_ids_units_and_new_adjective_do_not_invent_counts(self):
        source = 'Brest a un effectif neuf et neuf joueurs à 21h00, R1C4, sur 2850m.'
        html, anchors = protect(source, item())
        self.assertIn('un effectif neuf', html)
        self.assertIn('>nine</span> joueurs', html)
        for value in ['21h00', 'R1C4', '2850m']:
            self.assertIn('>' + value + '</span>', html)
        target = html.replace('a un effectif neuf et', 'has a new squad and').replace('joueurs', 'players')
        text, _ = validate_output(source, item(), target)
        self.assertIn('new squad and nine players', text)

    def test_malformed_partial_wrong_language_and_copy_only_fail_before_result(self):
        source = item()['summary']['fr']
        for make in [lambda t: {}, lambda t: [], lambda t: [None],
                lambda t: [{'translations': [{'to': 'de', 'text': t[0]}]}],
                lambda t: [{'error': {}, 'translations': [{'to': 'en', 'text': t[0]}]}],
                lambda t: [{'translations': [{'to': 'en', 'text': t[0]}]}]]:
            with self.subTest(make=make), TemporaryDirectory() as directory:
                translator = AzureTranslator(self.config, cache_dir=directory, quota_dir=Path(directory) / 'quota', request=lambda texts, timeout: make(texts))
                with self.assertRaises(TranslationRejected): translator.text(source, item())
                self.assertEqual(translator.records, [])

    def test_retry_is_bounded_and_every_attempt_including_markup_is_reserved(self):
        calls, pauses = [], []
        def transient(texts, timeout):
            calls.append(texts)
            if len(calls) < 3: raise AzureFailure(429, 1)
            return response(texts)
        translator = self.translator(transient, sleep=lambda value: pauses.append(value))
        translator.text(item()['summary']['fr'], item())
        self.assertEqual(len(calls), 3)
        self.assertEqual(pauses, [1, 2])
        used = json.loads((self.cache / 'quota/usage.json').read_bytes())['months']['2026-10']
        self.assertEqual(used, 3 * _characters(calls[0][0]))
        self.assertGreater(used, 3 * len(item()['summary']['fr']))

    def test_unauthorized_quota_and_technical_errors_do_not_retry_or_run_local(self):
        for failure, expected in [(AzureFailure(401), 'azure_http_401'),
                (AzureFailure(403), 'azure_http_403'), (AzureFailure(400), 'azure_http_400'),
                (TranslationRejected('azure_transport_failed'), 'azure_transport_failed')]:
            with self.subTest(expected=expected), TemporaryDirectory() as directory:
                calls = []
                def reject(*args): calls.append(True); raise failure
                translator = AzureTranslator(self.config, cache_dir=directory, quota_dir=Path(directory) / 'quota', request=reject)
                with self.assertRaises(TranslationRejected) as caught:
                    translator.text(item()['summary']['fr'], item())
                self.assertEqual(caught.exception.code, expected)
                self.assertEqual(calls, [True])

    def test_daily_monthly_and_restart_quota_are_fail_closed(self):
        clock = [NOW]
        config = replace(self.config, daily_characters=10, monthly_characters=15)
        quota = Quota(self.cache / 'quota', config, lambda: clock[0])
        quota.reserve(7)
        with self.assertRaises(TranslationRejected): quota.reserve(4)
        quota = Quota(self.cache / 'quota', config, lambda: clock[0])
        clock[0] = datetime(2026, 10, 25, tzinfo=timezone.utc)
        quota.reserve(7)
        with self.assertRaises(TranslationRejected): quota.reserve(2)
        clock[0] = datetime(2026, 11, 1, tzinfo=timezone.utc)
        quota.reserve(10)
        state = json.loads((self.cache / 'quota/usage.json').read_bytes())
        self.assertEqual(state['months'], {'2026-10': 14, '2026-11': 10})

    def test_distinct_preview_caches_share_the_same_durable_resource_quota(self):
        source = item()['summary']['fr']
        budget = _characters(protect(source, item())[0])
        config = replace(self.config, daily_characters=budget, monthly_characters=budget)
        quota = self.cache / 'resource-quota'
        first = AzureTranslator(config, cache_dir=self.cache / 'preview-one', quota_dir=quota,
            request=response, now=lambda: NOW)
        expected = first.text(source, item())
        second = AzureTranslator(config, cache_dir=self.cache / 'different-preview', quota_dir=quota,
            request=lambda *a: self.fail('Changing output must not reset the quota'), now=lambda: NOW)
        with self.assertRaises(TranslationRejected) as caught:
            second.text(source, item())
        self.assertEqual(caught.exception.code, 'azure_character_quota_exhausted')
        cached = AzureTranslator(config, cache_dir=self.cache / 'preview-one', quota_dir=quota,
            request=lambda *a: self.fail('A valid cached response is free'), now=lambda: NOW)
        self.assertEqual(cached.text(source, item()), expected)

    def test_corrupt_quota_is_not_reset_and_quota_refusal_has_zero_request(self):
        calls = []
        config = replace(self.config, daily_characters=1)
        translator = AzureTranslator(config, cache_dir=self.cache, quota_dir=self.cache / 'quota', request=lambda *a: calls.append(True))
        with self.assertRaises(TranslationRejected): translator.text(item()['summary']['fr'], item())
        self.assertEqual(calls, [])
        path = self.cache / 'quota/usage.json'
        path.write_text('[]', 'utf-8')
        with self.assertRaises(TranslationRejected): self.translator().text(item()['summary']['fr'], item())
        self.assertEqual(path.read_text('utf-8'), '[]')

    def test_elapsed_global_time_stops_before_second_cloud_attempt(self):
        ticks = [0]
        def rejected(texts, timeout): ticks[0] = 180; raise AzureFailure(503)
        translator = self.translator(rejected, monotonic=lambda: ticks[0], sleep=lambda *a: self.fail('No remaining time'))
        with self.assertRaises(TranslationRejected) as caught:
            translator.text(item()['summary']['fr'], item())
        self.assertEqual(caught.exception.code, 'azure_time_budget_exhausted')
        self.assertEqual(translator.requests, 1)

    def test_direct_text_and_send_cannot_bypass_request_size_or_item_caps(self):
        translator = self.translator(lambda *a: self.fail('Request rejected before transport'))
        source = 'Le commentaire continue. ' * 1000
        with self.assertRaises(TranslationRejected) as caught:
            translator.text(source, item())
        self.assertEqual(caught.exception.code, 'azure_request_size_exceeded')
        job = translator.job(item()['summary']['fr'], item())
        with self.assertRaises(TranslationRejected): translator.send([job] * 26)
        self.assertFalse((self.cache / 'quota/usage.json').exists())

    def test_group_failure_does_not_return_any_partial_bilingual_source(self):
        original = {'items': [item()]}
        def partial(texts, timeout):
            good = response(texts)
            good[-1]['translations'][0]['text'] = '<div>Wrong 9.</div>'
            return good
        translator = self.translator(partial)
        with self.assertRaises(TranslationRejected): translate_batch(original, translator)
        self.assertNotIn('en', original['items'][0]['summary'])
        self.assertEqual(translator.records, [])
        self.assertFalse((self.cache / 'azure/responses').exists())

    def test_factory_needs_key_rejects_paid_tier_and_caps_month(self):
        with patch.dict('os.environ', {}, clear=True), self.assertRaises(TranslationRejected):
            create_translator_from_env(self.cache)
        self.assertNotIn(KEY, repr(self.config))
        for change in [{'tier': 'S1'}, {'monthly_characters': 2_000_001},
                {'endpoint': 'https://attacker.example'}, {'request_timeout': 31},
                {'max_seconds': 181}, {'daily_characters': True}, {'retries': 3}]:
            with self.subTest(change=change), self.assertRaises(TranslationRejected): replace(self.config, **change)
        with patch.dict('os.environ', {'WINTIPS_EDITORIAL_AZURE_KEY': KEY,
                'WINTIPS_EDITORIAL_AZURE_QUOTA_DIR': str(self.cache / 'resource-quota')}, clear=True):
            translator = create_translator_from_env(self.cache, max_seconds=1200)
        self.assertEqual(translator.config.max_seconds, 180)

    def test_transport_has_fixed_https_headers_no_proxies_and_no_secret_in_errors(self):
        transport = AzureTransport(replace(self.config, region='francecentral'))
        class Reply:
            def __enter__(self): return self
            def __exit__(self, *a): pass
            def read(self, maximum): return b'[]'
        with patch.object(transport.opener, 'open', return_value=Reply()) as opened:
            self.assertEqual(transport(['<div>test</div>'], 30), [])
        request = opened.call_args.args[0]
        self.assertTrue(request.full_url.startswith(ENDPOINT + '/translate?'))
        self.assertIn('textType=html', request.full_url)
        self.assertEqual(request.get_header('Ocp-apim-subscription-key'), KEY)
        self.assertEqual(request.get_header('Ocp-apim-subscription-region'), 'francecentral')
        self.assertNotIn(KEY, request.full_url)


if __name__ == '__main__': unittest.main()
