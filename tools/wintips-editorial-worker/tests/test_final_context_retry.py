"""Offline limits and native-cache contracts for the last contextual Qwen try."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from editorial_worker.translation import CascadeTranslator, TranslationRejected


SOURCE = "Brest a gagné trois matchs contre Nice."
GOOD = "Brest won three matches against Nice."
BAD_NUMBER = "Brest won four matches against Nice."
BAD_ACTOR = "Nice won three matches against Brest."
ITEM = {
    "editionDate": "2026-10-23", "startsAtUtc": "2026-10-23T18:45:00Z",
    "sport": {"key": "football"},
    "teams": {"home": {"name": "Brest"}, "away": {"name": "Nice"}},
}


def response(text):
    return {"done": True, "message": {"content": text}}


class FinalContextRetryTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = Path(self.directory.name)

    def trap(self, *args):
        self.fail("No additional transport, runtime startup, or unload is permitted")

    def primary(self, request=None, *, cache=None, **kwargs):
        return CascadeTranslator(
            qwen_primary=True, mt_model="test-only-marian",
            mt_request=self.trap, request=request or self.trap,
            cache_dir=cache or self.cache, **kwargs)

    def seed_final_success(self):
        calls, releases = [], []
        outputs = [BAD_NUMBER, BAD_ACTOR, GOOD]

        def request(model, prompt, remaining):
            calls.append((model, prompt))
            self.assertLessEqual(len(calls), 3, "The final contextual try cannot become an unbounded loop")
            return response(outputs[len(calls) - 1])

        translator = self.primary(request=request, release_model=lambda model, remaining: releases.append(model))
        self.assertTrue(translator.final_context_retry)
        self.assertEqual(translator.sentence(SOURCE, ITEM), GOOD)
        return translator, calls, releases

    def test_one_final_qwen_try_preserves_full_source_and_treats_candidate_as_untrusted(self):
        translator, calls, releases = self.seed_final_success()
        self.assertEqual([row[0] for row in calls], [translator.config.model, translator.config.fallback_model, translator.config.model])
        self.assertEqual(releases, [translator.config.model, translator.config.fallback_model])
        self.assertEqual([prompt.rsplit("\n\n\n", 1)[-1] for _, prompt in calls], [SOURCE] * 3)
        record = translator.records[-1]
        self.assertTrue(record["finalContextRetryUsed"])
        self.assertTrue(record["earlierModelsRejected"])
        self.assertEqual(record["acceptedModel"], translator.config.model)
        self.assertEqual(record["primaryRouting"], "qwen_free_form")
        self.assertFalse(record["mtAccepted"])
        final = json.loads((self.cache / "qwen" / (record["cacheKey"] + ".json")).read_text("utf8"))
        feedback = final["identity"]["repairFeedback"]
        self.assertEqual(feedback["repairRound"], "final_qwen_context_1")
        self.assertIs(feedback["candidateIsUntrusted"], True)
        self.assertEqual(feedback["rejectedCandidate"], BAD_ACTOR)
        self.assertEqual(final["identity"]["source"].encode("utf8"), SOURCE.encode("utf8"))
        self.assertEqual(final["identity"]["prompt"].rsplit("\n\n\n", 1)[-1], SOURCE)
        self.assertNotEqual(calls[0][1], calls[2][1])

    def test_native_final_cache_is_revalidated_without_any_model_or_runtime(self):
        self.seed_final_success()
        translator = self.primary(ensure_fallback_ready=self.trap, release_model=self.trap)
        self.assertEqual(translator.sentence(SOURCE, ITEM), GOOD)
        record = translator.records[-1]
        self.assertTrue(record["finalContextRetryUsed"])
        self.assertTrue(record["contextualRepair"])
        self.assertTrue(record["attempts"][-1]["cached"])
        self.assertFalse(translator.fallback_ready)
        self.assertIsNone(translator.last_requested_model)

    def test_final_cache_does_not_trust_a_stale_passed_flag_after_response_changes(self):
        seed, _, _ = self.seed_final_success()
        record = seed.records[-1]
        path = self.cache / "qwen" / (record["cacheKey"] + ".json")
        cached = json.loads(path.read_text("utf8"))
        self.assertTrue(cached["validation"]["passed"])
        cached["response"] = response(BAD_NUMBER)
        path.write_text(json.dumps(cached), encoding="utf8")
        calls = []
        def still_wrong(model, prompt, remaining):
            calls.append(model)
            self.assertLessEqual(len(calls), 3)
            return response(BAD_NUMBER)
        translator = self.primary(request=still_wrong, release_model=lambda *args: None)
        with self.assertRaises(TranslationRejected):
            translator.sentence(SOURCE, ITEM)
        self.assertEqual(translator.records, [])

    def test_final_context_never_accepts_changed_quantity_actor_or_opponent(self):
        for index, final_target in enumerate([
            BAD_NUMBER, BAD_ACTOR, "Brest won three matches against Lille.",
        ]):
            with self.subTest(final_target=final_target):
                calls = []
                outputs = [BAD_NUMBER, BAD_ACTOR, final_target]

                def request(model, prompt, remaining):
                    calls.append(model)
                    self.assertLessEqual(len(calls), 3)
                    return response(outputs[len(calls) - 1])

                translator = self.primary(request=request, cache=self.cache / str(index), release_model=lambda *args: None)
                with self.assertRaises(TranslationRejected) as rejected:
                    translator.sentence(SOURCE, ITEM)
                self.assertEqual(rejected.exception.code, "translation_models_exhausted")
                self.assertEqual(calls, [translator.config.model, translator.config.fallback_model, translator.config.model])
                self.assertEqual(translator.records, [])

    def test_technical_failures_never_trigger_a_further_context_attempt(self):
        failures = [
            (OSError("offline fixture"), "translation_transport_failed"),
            (TimeoutError("timed out fixture"), "translation_transport_failed"),
            ({"message": "malformed"}, "local_model_response_invalid"),
            (TranslationRejected("translation_time_budget_exceeded"), "translation_time_budget_exceeded"),
            (TranslationRejected("model_unload_not_confirmed"), "model_unload_not_confirmed"),
        ]
        for index, (failure, code) in enumerate(failures):
            for fail_at in [1, 2, 3]:
                with self.subTest(code=code, fail_at=fail_at):
                    calls = []

                    def request(model, prompt, remaining):
                        calls.append(model)
                        self.assertLessEqual(len(calls), fail_at)
                        if len(calls) == fail_at:
                            if isinstance(failure, Exception):
                                raise failure
                            return failure
                        return response(BAD_NUMBER if len(calls) == 1 else BAD_ACTOR)

                    translator = self.primary(request=request, cache=self.cache / (str(index) + "-" + str(fail_at)), release_model=lambda *args: None)
                    with self.assertRaises(TranslationRejected) as rejected:
                        translator.sentence(SOURCE, ITEM)
                    self.assertEqual(rejected.exception.code, code)
                    self.assertEqual(len(calls), fail_at)
                    self.assertEqual(translator.records, [])

    def test_deadline_exhausted_after_second_model_prevents_final_inference(self):
        calls = []
        translator = None

        def request(model, prompt, remaining):
            calls.append(model)
            if len(calls) == 2:
                translator.started -= translator.config.max_seconds + 1
            return response(BAD_NUMBER)

        translator = self.primary(request=request, release_model=lambda *args: None)
        with self.assertRaises(TranslationRejected) as rejected:
            translator.sentence(SOURCE, ITEM)
        self.assertEqual(rejected.exception.code, "translation_time_budget_exceeded")
        self.assertEqual(calls, [translator.config.model, translator.config.fallback_model])
        self.assertEqual(translator.records, [])

    def test_legacy_constructor_has_no_final_context_retry(self):
        calls = []
        translator = CascadeTranslator(
            mt_model="test-only-marian", mt_request=lambda *args: response(BAD_NUMBER),
            request=lambda model, *args: calls.append(model) or response(BAD_ACTOR),
            release_model=lambda *args: None)
        self.assertFalse(translator.final_context_retry)
        with self.assertRaises(TranslationRejected):
            translator.sentence(SOURCE, ITEM)
        self.assertEqual(calls, [translator.config.model, translator.config.fallback_model])


if __name__ == "__main__":
    unittest.main()
