"""Offline regression contracts for guarded contextual repairs and exact caches."""
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from editorial_worker.translation import (
    CascadeTranslator, LocalTranslator, TranslationConfig, TranslationRejected,
    _fixture, _guard_feedback,
)
from editorial_worker.vendor import rdj_translation as guard


SOURCE = "Brest a gagné trois matchs."
GOOD = "Brest won three matches."
BAD = "Brest won four matches."
ITEM = {
    "editionDate": "2026-10-23", "startsAtUtc": "2026-10-23T18:45:00Z",
    "sport": {"key": "football"},
    "teams": {"home": {"name": "Brest"}, "away": {"name": "Nice"}},
}


def response(text):
    return {"done": True, "message": {"content": text}}


def feedback():
    fixture = _fixture(ITEM)
    masked, anchors = guard._protect(SOURCE, fixture)
    _, proof = LocalTranslator._validate(SOURCE, fixture, masked, anchors, response(BAD))
    assert not proof["passed"]
    return _guard_feedback(anchors, proof)


class ContextRepairTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = Path(self.directory.name)

    def trap(self, *args):
        self.fail("An exact validated response must not start transport or model runtime")

    def local(self, request=None, **kwargs):
        translator = LocalTranslator(
            TranslationConfig(fallback_model=None, **kwargs),
            cache_dir=self.cache, request=request or self.trap)
        translator.contextual_feedback = True
        return translator

    def test_valid_base_cache_wins_over_repair_feedback_without_transport(self):
        seed = self.local(lambda *args: response(GOOD))
        seed.sentence(SOURCE, ITEM)
        original = deepcopy(ITEM)
        translator = self.local()
        self.assertEqual(translator.sentence(SOURCE, ITEM, feedback=feedback()), GOOD)
        self.assertEqual(ITEM, original)
        self.assertFalse(translator.records[-1]["contextualRepair"])
        self.assertTrue(translator.records[-1]["attempts"][-1]["cached"])

    def test_cascade_repair_cache_replay_starts_neither_transport_nor_runtime(self):
        calls, starts = [], []

        def mt_request(model, prompt, remaining):
            calls.append(("mt", model, prompt))
            return response(BAD)

        def qwen_request(model, prompt, remaining):
            calls.append(("qwen", model, prompt))
            return response(GOOD)

        original = deepcopy(ITEM)
        first = CascadeTranslator(
            mt_model="test-local-marian", cache_dir=self.cache,
            mt_request=mt_request, request=qwen_request,
            ensure_fallback_ready=lambda: starts.append(True))
        self.assertEqual(first.sentence(SOURCE, ITEM), GOOD)
        self.assertEqual([call[0] for call in calls], ["mt", "qwen"])
        self.assertEqual(starts, [True])
        self.assertTrue(first.records[-1]["contextualRepair"])
        repair_record = json.loads(next((self.cache / "qwen").glob("*.json")).read_text("utf8"))
        self.assertEqual(repair_record["identity"]["source"], SOURCE)
        self.assertEqual(repair_record["identity"]["prompt"].rsplit("\n\n\n", 1)[-1], SOURCE)
        self.assertEqual(repair_record["identity"]["repairFeedback"]["schema"], 1)
        self.assertTrue(repair_record["identity"]["repairFeedback"]["errors"])
        self.assertEqual(ITEM, original)

        second = CascadeTranslator(
            mt_model="test-local-marian", cache_dir=self.cache,
            mt_request=self.trap, request=self.trap,
            ensure_fallback_ready=self.trap, release_model=self.trap)
        self.assertEqual(second.sentence(SOURCE, ITEM), GOOD)
        record = second.records[-1]
        self.assertTrue(record["contextualRepair"])
        self.assertTrue(record["attempts"][-1]["cached"])
        self.assertTrue(record["rejectedMt"]["attempts"][-1]["rejectedCacheNotReinferred"])
        self.assertFalse(second.fallback_ready)
        self.assertIsNone(second.last_requested_model)

    def test_different_guard_feedback_has_distinct_exact_prompt_and_cache_identity(self):
        calls = []
        first_feedback = feedback()
        second_feedback = deepcopy(first_feedback)
        second_feedback["errors"].append("additional_test_guard_finding")
        translator = self.local(lambda model, prompt, remaining: calls.append(prompt) or response(GOOD))
        self.assertEqual(translator.sentence(SOURCE, ITEM, feedback=first_feedback), GOOD)
        self.assertEqual(translator.sentence(SOURCE, ITEM, feedback=second_feedback), GOOD)
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(translator.records[0]["cacheKey"], translator.records[1]["cacheKey"])
        self.assertNotEqual(calls[0], calls[1])
        self.assertEqual([prompt.rsplit("\n\n\n", 1)[-1] for prompt in calls], [SOURCE, SOURCE])
        records = [json.loads(p.read_text("utf8")) for p in self.cache.glob("*.json")]
        self.assertCountEqual([r["identity"]["repairFeedback"] for r in records], [first_feedback, second_feedback])

    def test_new_repair_with_changed_fact_is_rejected_and_not_reinferred(self):
        calls = []
        translator = self.local(lambda *args: calls.append(True) or response(BAD))
        with self.assertRaises(TranslationRejected) as rejected:
            translator.sentence(SOURCE, ITEM, feedback=feedback())
        self.assertEqual(rejected.exception.code, "translation_models_exhausted")
        self.assertEqual(calls, [True])
        self.assertEqual(translator.records, [])
        second = self.local()
        with self.assertRaises(TranslationRejected) as cached:
            second.sentence(SOURCE, ITEM, feedback=feedback())
        self.assertTrue(cached.exception.audit["attempts"][-1]["rejectedCacheNotReinferred"])
        self.assertEqual(second.records, [])

    def test_repair_cache_is_revalidated_instead_of_trusting_old_passed_metadata(self):
        translator = self.local(lambda *args: response(GOOD))
        translator.sentence(SOURCE, ITEM, feedback=feedback())
        path = next(self.cache.glob("*.json"))
        record = json.loads(path.read_text("utf8"))
        self.assertTrue(record["validation"]["passed"])
        record["response"] = response(BAD)
        path.write_text(json.dumps(record), encoding="utf8")
        with self.assertRaises(TranslationRejected) as rejected:
            self.local().sentence(SOURCE, ITEM, feedback=feedback())
        self.assertEqual(rejected.exception.code, "translation_models_exhausted")
        self.assertTrue(rejected.exception.audit["attempts"][-1]["contextualRepair"])

    def test_technical_and_malformed_failures_never_start_another_content_engine(self):
        for failure, expected in [
            (OSError("offline test"), "translation_transport_failed"),
            (ValueError("invalid transport JSON"), "translation_transport_failed"),
            (TranslationRejected("translation_time_budget_exceeded"), "translation_time_budget_exceeded"),
            (TranslationRejected("model_unload_not_confirmed"), "model_unload_not_confirmed"),
            ({"message": "malformed"}, "local_model_response_invalid"),
        ]:
            with self.subTest(expected=expected, failure=type(failure).__name__):
                calls = []

                def fail_request(model, prompt, remaining):
                    calls.append(model)
                    if isinstance(failure, Exception):
                        raise failure
                    return failure

                translator = CascadeTranslator(
                    mt_model="test-local-marian", mt_request=lambda *args: response(BAD),
                    request=fail_request, release_model=self.trap)
                with self.assertRaises(TranslationRejected) as rejected:
                    translator.sentence(SOURCE, ITEM)
                self.assertEqual(rejected.exception.code, expected)
                self.assertEqual(calls, [translator.config.model])
                self.assertEqual(translator.records, [])

    def test_corrupt_cache_is_not_hidden_by_context_repair_or_fresh_inference(self):
        translator = self.local(lambda *args: response(GOOD))
        translator.sentence(SOURCE, ITEM)
        next(self.cache.glob("*.json")).write_text("{not-json", encoding="utf8")
        with self.assertRaises(TranslationRejected) as rejected:
            self.local().sentence(SOURCE, ITEM, feedback=feedback())
        self.assertEqual(rejected.exception.code, "translation_cache_corrupt")

    def test_expired_budget_cannot_be_bypassed_by_valid_cache_or_repair_feedback(self):
        self.local(lambda *args: response(GOOD)).sentence(SOURCE, ITEM)
        translator = self.local(max_seconds=1)
        translator.started -= 2
        with self.assertRaises(TranslationRejected) as rejected:
            translator.sentence(SOURCE, ITEM, feedback=feedback())
        self.assertEqual(rejected.exception.code, "translation_time_budget_exceeded")
        self.assertEqual(translator.records, [])


if __name__ == "__main__":
    unittest.main()
