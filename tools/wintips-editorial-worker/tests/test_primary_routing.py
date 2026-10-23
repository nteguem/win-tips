"""No-model safety checks for Qwen-first free-form editorial English."""
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from editorial_worker import mt_translation
from editorial_worker.translation import (
    CascadeTranslator, LocalTranslator, TranslationConfig, TranslationRejected,
)


SOURCE = "Brest a gagné trois matchs."
GOOD = "Brest won three matches."
BAD_FACT = "Brest won four matches."
# Deliberately bad English that the factual guard alone historically accepts.
BAD_GRAMMAR = "Brest won three match."
MT_MODEL = "test-only-marian"
ITEM = {
    "editionDate": "2026-10-23", "startsAtUtc": "2026-10-23T18:45:00Z",
    "sport": {"key": "football"},
    "teams": {"home": {"name": "Brest"}, "away": {"name": "Nice"}},
}


def response(text):
    return {"done": True, "message": {"content": text}}


class PrimaryRoutingTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = Path(self.directory.name)

    def trap(self, *args):
        self.fail("This path must not invoke transport, runtime startup, or unload")

    def seed_mt(self, target=BAD_GRAMMAR):
        translator = LocalTranslator(
            TranslationConfig(model=MT_MODEL, fallback_model=None, num_threads=1),
            cache_dir=self.cache / "mt", request=lambda *args: response(target))
        self.assertEqual(translator.sentence(SOURCE, ITEM), target)
        self.assertTrue(translator.records[-1]["proof"]["passed"])

    def primary(self, request=None, **kwargs):
        return CascadeTranslator(
            qwen_primary=True, mt_model=MT_MODEL, cache_dir=self.cache,
            mt_request=self.trap, request=request or self.trap, **kwargs)

    def test_previously_guard_passed_bad_mt_cache_never_becomes_primary_english(self):
        self.seed_mt()
        calls, starts = [], []
        original = deepcopy(ITEM)

        def qwen(model, prompt, remaining):
            calls.append((model, prompt))
            return response(GOOD)

        translator = self.primary(request=qwen, ensure_fallback_ready=lambda: starts.append(True))
        self.assertEqual(translator.sentence(SOURCE, ITEM), GOOD)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], translator.config.model)
        self.assertEqual(calls[0][1].rsplit("\n\n\n", 1)[-1], SOURCE)
        self.assertEqual(starts, [True])
        self.assertEqual(translator.mt.records, [])
        self.assertFalse(translator.records[-1]["mtAccepted"])
        self.assertEqual(translator.records[-1]["primaryRouting"], "qwen_free_form")
        self.assertEqual(ITEM, original)

    def test_valid_native_qwen_cache_needs_no_mt_transport_or_model_runtime(self):
        self.seed_mt()
        LocalTranslator(
            TranslationConfig(fallback_model=None), cache_dir=self.cache / "qwen",
            request=lambda *args: response(GOOD)).sentence(SOURCE, ITEM)
        translator = self.primary(ensure_fallback_ready=self.trap, release_model=self.trap)
        self.assertEqual(translator.sentence(SOURCE, ITEM), GOOD)
        record = translator.records[-1]
        self.assertTrue(record["attempts"][-1]["cached"])
        self.assertFalse(record["contextualRepair"])
        self.assertFalse(record["mtAccepted"])
        self.assertFalse(translator.fallback_ready)
        self.assertIsNone(translator.last_requested_model)

    def test_old_rejected_mt_feedback_can_find_exact_native_qwen_repair_without_runtime(self):
        old = CascadeTranslator(
            mt_model=MT_MODEL, cache_dir=self.cache,
            mt_request=lambda *args: response(BAD_FACT),
            request=lambda *args: response(GOOD))
        self.assertEqual(old.sentence(SOURCE, ITEM), GOOD)
        self.assertTrue(old.records[-1]["contextualRepair"])
        translator = self.primary(ensure_fallback_ready=self.trap, release_model=self.trap)
        self.assertEqual(translator.sentence(SOURCE, ITEM), GOOD)
        record = translator.records[-1]
        self.assertTrue(record["contextualRepair"])
        self.assertTrue(record["attempts"][-1]["cached"])
        self.assertTrue(record["mtDiagnosticRead"])
        self.assertFalse(record["mtAccepted"])
        self.assertEqual(translator.mt.records, [])
        self.assertFalse(translator.fallback_ready)

    def test_constructor_default_keeps_legacy_mt_behavior_only_when_not_primary(self):
        calls = []
        translator = CascadeTranslator(
            mt_model=MT_MODEL, cache_dir=self.cache,
            mt_request=lambda *args: calls.append("mt") or response(BAD_GRAMMAR),
            request=self.trap, ensure_fallback_ready=self.trap)
        self.assertFalse(translator.qwen_primary)
        self.assertEqual(translator.sentence(SOURCE, ITEM), BAD_GRAMMAR)
        self.assertEqual(calls, ["mt"])
        self.assertEqual(translator.records[-1]["engine"], "local_mt")

    def test_primary_qwen_and_fallback_still_cannot_change_factual_quantities(self):
        calls, releases = [], []
        translator = self.primary(
            request=lambda model, *args: calls.append(model) or response(BAD_FACT),
            release_model=lambda model, remaining: releases.append(model))
        with self.assertRaises(TranslationRejected) as rejected:
            translator.sentence(SOURCE, ITEM)
        self.assertEqual(rejected.exception.code, "translation_models_exhausted")
        self.assertEqual(calls, [translator.config.model, translator.config.fallback_model, translator.config.model])
        self.assertEqual(releases, [translator.config.model,translator.config.fallback_model])
        self.assertEqual(translator.records, [])

    def test_factory_requires_qwen_primary_without_loading_any_transport(self):
        transport = SimpleNamespace(model_id=MT_MODEL, manifest_sha256="a" * 64)
        with patch.dict("os.environ", {}, clear=True), \
             patch.object(mt_translation, "MarianTransport", return_value=transport):
            translator = mt_translation.create_translator_from_env(self.cache)
        self.assertTrue(translator.qwen_primary)
        for value in ["false", "invalid"]:
            with self.subTest(value=value), \
                 patch.dict("os.environ", {"WINTIPS_EDITORIAL_QWEN_PRIMARY": value}, clear=True), \
                 patch.object(mt_translation, "MarianTransport", return_value=transport), \
                 self.assertRaises(TranslationRejected):
                mt_translation.create_translator_from_env(self.cache)

    def test_primary_source_validation_remains_typed_and_never_starts_engines(self):
        for source in [None, "", "x" * 4001]:
            with self.subTest(source_type=type(source).__name__):
                translator = self.primary(ensure_fallback_ready=self.trap)
                with self.assertRaises(TranslationRejected):
                    translator.sentence(source, ITEM)


if __name__ == "__main__":
    unittest.main()
