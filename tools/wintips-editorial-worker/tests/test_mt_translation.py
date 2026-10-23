"""Offline safety/contract checks for the optional Marian transport."""
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from editorial_worker import mt_translation as mt
from editorial_worker.translation import CascadeTranslator, TranslationRejected, _fixture, _prompt
from editorial_worker.vendor import rdj_translation as guard


class MarianTransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.manifest = self.root / "manifest.json"
        records = []
        for name in ("model/model.bin", "model/config.json", "model/shared_vocabulary.json",
                     "original/source.spm", "original/target.spm", "original/LICENSE"):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(name.encode())
            records.append({"name": name, "bytes": target.stat().st_size,
                            "sha256": sha256(target.read_bytes()).hexdigest()})
        self.metadata = {"files": records, "modelDirectory": "model",
                         "sourceSentencePiece": "original/source.spm",
                         "targetSentencePiece": "original/target.spm"}
        self.save_manifest()
        self.loads, self.encoded, self.decode_calls, self.translate_calls = [], [], [], []
        owner = self
        class SentencePiece:
            def __init__(self, model_file):
                self.path = model_file
            def encode(self, source, out_type):
                owner.encoded.append((source, out_type))
                return source.split()
            def decode(self, tokens):
                owner.decode_calls.append(tokens)
                return "Nice won 3-1."
        class Translator:
            def __init__(self, directory, **kwargs):
                owner.loads.append((directory, kwargs))
            def translate_batch(self, tokens, **kwargs):
                owner.translate_calls.append((tokens, kwargs))
                return [SimpleNamespace(hypotheses=[["generated", "tokens"]])]
        self.modules = {"ctranslate2": SimpleNamespace(Translator=Translator),
                        "sentencepiece": SimpleNamespace(SentencePieceProcessor=SentencePiece)}

    def save_manifest(self):
        self.manifest.write_text(json.dumps(self.metadata), encoding="utf-8")

    def transport(self, **kwargs):
        return mt.MarianTransport(self.root, manifest_path=self.manifest,
                                  loader=lambda name: self.modules[name], **kwargs)

    def test_model_integrity_checked_before_runtime_is_loaded(self):
        transport = self.transport()
        self.assertEqual(self.loads, [])
        self.assertIn(transport.manifest_sha256, transport.model_id)
        (self.root / "model/model.bin").write_bytes(b"changed model!")
        with self.assertRaisesRegex(TranslationRejected, "mt_model_integrity_failed"):
            self.transport()
        self.assertEqual(self.loads, [])

    def test_path_escape_and_duplicate_manifest_entries_refused(self):
        self.metadata["files"][0]["name"] = "../outside-model"
        self.save_manifest()
        with self.assertRaisesRegex(TranslationRejected, "mt_model_integrity_failed"):
            self.transport()
        self.metadata["files"][0] = self.metadata["files"][1]
        self.save_manifest()
        with self.assertRaisesRegex(TranslationRejected, "mt_model_integrity_failed"):
            self.transport()

    def test_all_runtime_components_must_have_verified_hashes(self):
        self.metadata["files"] = self.metadata["files"][1:]
        self.save_manifest()
        with self.assertRaisesRegex(TranslationRejected, "mt_model_integrity_failed"):
            self.transport()

    def test_transport_receives_original_french_not_protected_placeholders(self):
        source = "Nice a gagné 3-1."
        item = {"teams": {"home": {"name": "Nice"}, "away": {"name": "Lille"}}, "sport": {"key": "football"}}
        masked, anchors = guard._protect(source, _fixture(item))
        prompt = _prompt(masked, anchors)
        transport = self.transport()
        response = transport(transport.model_id, prompt, 30)
        self.assertEqual(self.encoded, [(source, str)])
        self.assertEqual(response["message"]["content"], "Nice won 3-1.")
        self.assertTrue(response["done"])
        self.assertEqual(self.loads[0][1], {"device": "cpu", "compute_type": "int8", "inter_threads": 1, "intra_threads": 1})
        self.assertEqual(self.translate_calls[0][1]["max_input_length"], 0)

    def test_missing_frame_unknown_model_and_expired_budget_never_load_runtime(self):
        transport = self.transport()
        for model, prompt, remaining, code in (
            ("unapproved", "Header\n\n\nNice", 1, "mt_model_identity_mismatch"),
            (transport.model_id, "No source frame", 1, "mt_source_frame_invalid"),
            (transport.model_id, "Header\n\n\nNice", 0, "translation_time_budget_exceeded"),
        ):
            with self.subTest(code=code), self.assertRaisesRegex(TranslationRejected, code):
                transport(model, prompt, remaining)
        self.assertEqual(self.loads, [])

    def test_overlong_token_sequence_is_rejected_without_truncation(self):
        transport = self.transport()
        source = "x " * 513
        with self.assertRaisesRegex(TranslationRejected, "mt_source_token_budget_exceeded"):
            transport(transport.model_id, "Header\n\n\n" + source, 30)
        self.assertEqual(self.translate_calls, [])

    def test_result_after_deadline_is_never_accepted(self):
        ticks = iter([0, 0, 2])
        transport = self.transport(clock=lambda: next(ticks))
        with self.assertRaisesRegex(TranslationRejected, "translation_time_budget_exceeded"):
            transport(transport.model_id, "Header\n\n\nNice", 1)

    def test_factory_builds_one_guarded_cascade_without_starting_qwen(self):
        transport = self.transport()
        callback = lambda: self.fail("Qwen was eagerly started")
        with patch.dict("os.environ", {"WINTIPS_EDITORIAL_MT_ROOT": str(self.root)}, clear=True), \
             patch.object(mt, "MarianTransport", return_value=transport):
            cascade = mt.create_translator_from_env(self.root / "cache", 60, callback)
        self.assertIsInstance(cascade, CascadeTranslator)
        self.assertEqual(cascade.mt.config.model, transport.model_id)
        self.assertEqual(cascade.config.model, "qwen2.5:7b-instruct-q4_K_M")
        self.assertEqual(cascade.config.num_threads, 2)
        self.assertEqual(cascade.mt.config.num_threads, 1)
        self.assertEqual(cascade.config.fallback_model, "translategemma:4b")
        self.assertFalse(cascade.fallback_ready)
        self.assertEqual(cascade.records, [])
        self.assertEqual(self.loads, [])


if __name__ == "__main__":
    unittest.main()
