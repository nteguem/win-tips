"""Actual ordinal false rejection and persistent provider backoff; no network."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from editorial_worker import gemini_translation as g
from editorial_worker.translation import TranslationRejected


class GeminiRpdOrdinalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.instant = datetime(2026, 10, 25, 5, 7, tzinfo=timezone.utc)
        self.config = g.GeminiConfig(key='local-test-key-not-a-real-secret', model='gemini-2.5-flash')
        self.pauses = []
        self.case = json.loads((Path(__file__).parent / 'fixtures/gemini-rpd-ordinal-20261025.json').read_bytes())
        # Synthetic transport fixture with both adapters' fact shapes. The
        # actual captured BigWin context remains untouched in self.case.
        self.source = 'Liverpool occupe la 1\u00e8re place avec 9 points apr\u00e8s un match (0-3).'
        self.item = {'home': 'Liverpool', 'away': 'Brighton', 'competition': 'Premier League',
            'teams': {'home': {'name': 'Liverpool'}, 'away': {'name': 'Brighton'}}}
    def tearDown(self):
        self.temporary.cleanup()
    def translator(self, request, model=None):
        return g.GeminiTranslator(replace(self.config, model=model or self.config.model), cache_dir=self.root / 'cache',
            quota_dir=self.root / 'quota', request=request, now=lambda: self.instant, sleep=self.pauses.append)
    def job(self, translator):
        return translator.job(self.source, self.item)
    def daily(self, seconds=6767):
        return g.GeminiFailure(429, seconds, {'quotaTypes': ['RPD'], 'retryInfoSeconds': seconds,
            'retryAfterHeaderSeconds': 0, 'bodyStatus': 'parsed'})
    def good(self, texts, timeout):
        # Explicit fake transport, never represented as a native model result.
        candidate = g._protected(self.source, self.item)[0].replace(' occupe la ', ' occupies ').replace(' avec ', ' with ').replace(' points apr\u00e8s ', ' points after ')
        return {'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': json.dumps({
            'translations': [{'id': str(i), 'text': candidate} for i in range(len(texts))]})}]}}]}

    def test_actual_native_first_rank_and_full_bigwin_context_are_preserved(self):
        source, candidate = self.case['source'], self.case['candidateHtml']
        self.assertEqual(self.case['previousRejection']['mutatedSpans'][0]['requiredValue'], '1\u00e8re')
        self.assertEqual(g.protect.__globals__['_number_display']('1\u00e8re'), '1st')
        self.assertIn('>1st</span> place', candidate)
        if g.__name__.startswith('journal_worker.'):
            target, proof = g._validated(source, self.case['item'], candidate)
            self.assertIn('1st place', target)
            self.assertTrue(proof['passed'])
        else:
            # BigWin's captured top-level home/away/competition fact schema is
            # not a WinTips typed item. Do not fabricate a full WinTips replay.
            typed = {'teams': {'home': {'name': self.case['item']['home']},
                               'away': {'name': self.case['item']['away']}}}
            _, anchors = g._protected(source, typed)
            self.assertEqual([a['value'] for a in anchors if a['source'] == '1\u00e8re'], ['1st'])
        self.assertEqual(self.case['source'], source)
        self.assertEqual(self.case['candidateHtml'], candidate)

    def test_ordinal_gender_accents_and_plural_keep_exact_rank_and_other_quantities(self):
        for spelling in ('1er', '1ers', '1re', '1res', '1\u00e8re', '1\u00e8res', '1ere', '1eres', '1e\u0300re', '1e\u0300res'):
            _, anchors = g._protected('La ' + spelling + ' place.', {})
            self.assertEqual([a['value'] for a in anchors], ['1st'], spelling)
        for source, expected in [('2\u00e8me place', '2nd'), ('3\u00e8me place', '3rd'), ('11\u00e8me place', '11th'),
                                 ('21\u00e8me place', '21st'), ('1,50', '1.50'), ('0-3', '0-3'), ('52%', '52%')]:
            _, anchors = g._protected(source, {})
            self.assertEqual([a['value'] for a in anchors], [expected])

    def test_native_wrong_rank_quantity_score_missing_or_duplicate_remains_rejected(self):
        source, item = self.source, self.item
        original = g._protected(source, item)[0].replace(' occupe la ', ' occupies ')
        _, proof = g._validated(source, item, original)
        self.assertTrue(proof['passed'])
        _, anchors = g._protected(source, item)
        ordinal = next(a for a in anchors if a['value'] == '1st')
        span = '<span id="' + ordinal['id'] + '" class="notranslate" translate="no">1st</span>'
        self.assertIn(span, original)
        for candidate in (original.replace('>1st<', '>2nd<'), original.replace('>9<', '>8<'),
                original.replace('>0-3<', '>3-0<'), original.replace(span, ''), original.replace(span, span + span)):
            with self.assertRaises(TranslationRejected):
                g._validated(source, item, candidate)

    def test_rpd_records_shared_cooldown_without_sleep_retry_or_quota_reset(self):
        calls = []
        def request(*args):
            calls.append(args)
            raise self.daily()
        t = self.translator(request)
        with self.assertRaises(TranslationRejected) as caught: t.send([self.job(t)])
        self.assertEqual(caught.exception.code, 'gemini_daily_request_quota_exhausted')
        self.assertEqual(len(calls), 1); self.assertEqual(t.requests, 1); self.assertEqual(self.pauses, [])
        self.assertFalse(t.attempts[0]['retryScheduled'])
        self.assertEqual(t.attempts[0]['providerCooldown']['untilUtc'], '2026-10-25T06:59:47+00:00')
        usage = json.loads((self.root / 'quota/usage.json').read_bytes())
        self.assertEqual(usage['days']['2026-10-25'], t.attempts[0]['inputCharactersReserved'])
        self.assertEqual(usage['months']['2026-10'], usage['days']['2026-10-25'])
        self.assertEqual(list((self.root / 'cache').rglob('responses/*.json')), [])

    def test_new_instance_and_other_worker_same_model_make_zero_calls_or_reservations(self):
        t = self.translator(lambda *a: (_ for _ in ()).throw(self.daily(8970)))
        with self.assertRaises(TranslationRejected): t.send([self.job(t)])
        before = (self.root / 'quota/usage.json').read_bytes()
        for _ in range(2):
            other = self.translator(lambda *a: self.fail('cooldown must prevent HTTP'))
            with self.assertRaises(TranslationRejected) as caught: other.send([self.job(other)])
            self.assertEqual(caught.exception.code, 'gemini_provider_cooldown_active')
            self.assertEqual(caught.exception.audit['providerCooldown']['quotaTypes'], ['RPD'])
            self.assertEqual(other.requests, 0)
        self.assertEqual((self.root / 'quota/usage.json').read_bytes(), before)

    def test_other_model_is_independent_and_exact_deadline_reopens_without_reset(self):
        t = self.translator(lambda *a: (_ for _ in ()).throw(self.daily()))
        with self.assertRaises(TranslationRejected): t.send([self.job(t)])
        other = self.translator(self.good, model='gemini-2.5-flash-lite')
        other.send([self.job(other)]); self.assertEqual(other.requests, 1)
        self.instant += timedelta(seconds=6767)
        reopened = self.translator(self.good); reopened.send([self.job(reopened)])
        self.assertEqual(reopened.requests, 1)
        usage = json.loads((self.root / 'quota/usage.json').read_bytes())
        self.assertEqual(usage['days']['2026-10-25'], sum(x.attempts[0]['inputCharactersReserved'] for x in (t, other, reopened)))

    def test_valid_native_cache_stays_usable_during_provider_cooldown(self):
        t = self.translator(self.good); job = self.job(t); t.send([job])
        t.cooldown.remember(self.config.model, 6767)
        warm = self.translator(lambda *a: self.fail('warm cache must not call'))
        self.assertTrue(warm.cached(self.job(warm)))
        self.assertEqual(warm.requests, 0)

    def test_concurrent_shorter_deadline_never_overwrites_longer_shared_backoff(self):
        t = self.translator(self.good)
        first = t.cooldown.remember(self.config.model, 8970)
        second = self.translator(self.good).cooldown.remember(self.config.model, 6767)
        self.assertEqual(first, second)
        self.instant += timedelta(seconds=100)
        self.assertEqual(t.cooldown.active(self.config.model), first)

    def test_missing_or_unbounded_daily_delay_never_gets_shortened_into_retry(self):
        for seconds, expected in [(0, 'gemini_daily_request_quota_exhausted'),
                (172801, 'gemini_cooldown_delay_out_of_range')]:
            t = self.translator(lambda *a: (_ for _ in ()).throw(self.daily(seconds)))
            with self.assertRaises(TranslationRejected) as caught: t.send([self.job(t)])
            self.assertEqual(caught.exception.code, expected)
            self.assertEqual(t.requests, 1)
        self.assertEqual(self.pauses, [])

    def test_corrupt_state_fails_closed_before_character_reservation(self):
        for malformed in (b'not json', b'{"schema":true,"models":{}}',
                b'{"schema":1,"models":{"gemini-x":{"secret":"must-not-escape"}}}'):
            directory = self.root / 'quota'; directory.mkdir(exist_ok=True)
            path = directory / 'provider-cooldowns.json'; path.write_bytes(malformed); path.chmod(0o600)
            t = self.translator(lambda *a: self.fail('corrupt state must block'))
            with self.assertRaises(TranslationRejected) as caught: t.send([self.job(t)])
            self.assertEqual(caught.exception.code, 'gemini_cooldown_state_invalid')
            self.assertNotIn('must-not-escape', str(caught.exception))
            self.assertFalse((directory / 'usage.json').exists())

    def test_transient_rpm_keeps_existing_bounded_retry_and_quota_on_both_attempts(self):
        calls = []
        def request(texts, timeout):
            calls.append(texts)
            if len(calls) == 1:
                raise g.GeminiFailure(429, 2, {'quotaTypes': ['RPM'], 'retryInfoSeconds': 2, 'bodyStatus': 'parsed'})
            return self.good(texts, timeout)
        t = self.translator(request); t.send([self.job(t)])
        self.assertEqual(len(calls), 2); self.assertEqual(self.pauses, [2])
        self.assertFalse((self.root / 'quota/provider-cooldowns.json').exists())
        self.assertEqual(json.loads((self.root / 'quota/usage.json').read_bytes())['days']['2026-10-25'],
            sum(a['inputCharactersReserved'] for a in t.attempts))

    def test_v6_wire_keeps_original_html_and_closed_schema_with_explicit_markup_contract(self):
        t = self.translator(self.good); job = self.job(t)
        wire = g.request_payload(t.config, [job['html']])
        self.assertEqual(json.loads(wire['contents'][0]['parts'][0]['text'])['fragments'], [{'id': '0', 'text': job['html']}])
        schema = wire['generationConfig']['responseJsonSchema']
        self.assertFalse(schema['additionalProperties'])
        self.assertFalse(schema['properties']['translations']['items']['additionalProperties'])
        self.assertEqual(schema['properties']['translations']['items']['properties']['text']['description'], g.TEXT_DESCRIPTION)
        span = '<span id="wt0" class="notranslate" translate="no">EXACT_SOURCE_VALUE</span>'
        self.assertEqual(g.INSTRUCTIONS.count(span), 2)
        self.assertIn('league-table/standings passage about points', g.INSTRUCTIONS)
        self.assertIn('goalless draw cannot become a scored goal', g.INSTRUCTIONS)
        self.assertIn('explicitly discusses a goals tally instead', g.INSTRUCTIONS)
        for forbidden in ('Marseille', 'Liverpool', 'Le Havre', 'Brighton', '0-0', '6767'):
            self.assertNotIn(forbidden, g.INSTRUCTIONS)

    def test_v6_version_and_exact_schema_description_change_cache_identity(self):
        t = self.translator(self.good); current = self.job(t)
        self.assertEqual(current['identity']['version'], 'gemini-html-facts-v6-explicit-html-contract')
        self.assertEqual(current['identity']['generation']['responseTextDescription'], g.TEXT_DESCRIPTION)
        with patch.object(g, 'VERSION', 'gemini-html-facts-v5-source-prose-guard'):
            self.assertNotEqual(self.job(t)['key'], current['key'])
        with patch.object(g, 'TEXT_DESCRIPTION', 'different typed output contract'):
            self.assertNotEqual(self.job(t)['key'], current['key'])

    def test_v6_still_rejects_plaintext_even_if_all_visible_factual_values_are_correct(self):
        html = json.loads(self.good(['test'], 1)['candidates'][0]['content']['parts'][0]['text'])['translations'][0]['text']
        _, proof = g._validated(self.source, self.item, html)
        self.assertTrue(proof['passed'])
        import re
        stripped = re.sub(r'</?span\b[^>]*>', '', html)
        with self.assertRaises(TranslationRejected):
            g._validated(self.source, self.item, stripped)


if __name__ == '__main__':
    unittest.main()
