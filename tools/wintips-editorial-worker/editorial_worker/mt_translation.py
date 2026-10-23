"""Offline Marian transport for the guarded MT -> Qwen cascade.

No downloads, installation, model service or publication happen in this module.
Only the separately approved model files described by the bundled manifest load.
"""
from __future__ import annotations

from hashlib import sha256
import importlib
import json
import os
from pathlib import Path
import sys
import time

from .translation import CascadeTranslator, TranslationConfig, TranslationRejected

MANIFEST = Path(__file__).parent / "assets" / "mt" / "opus-mt-fr-en-20200226-int8.json"
DEFAULT_ROOT = "/opt/journal-parieur-rdj-20261022"
MAX_SOURCE_TOKENS = 512


class MarianTransport:
    """Lazy, one-thread CT2 inference; all cache/meaning checks live in cascade."""
    def __init__(self, model_root, *, manifest_path=MANIFEST, deps_dir=None,
                 loader=importlib.import_module, clock=time.monotonic):
        self.root = Path(model_root).resolve()
        self.deps_dir = Path(deps_dir).resolve() if deps_dir else None
        self.loader, self.clock = loader, clock
        self._runtime = None
        manifest_path = Path(manifest_path)
        if not manifest_path.is_file() or manifest_path.stat().st_size > 100_000:
            raise TranslationRejected("mt_manifest_missing_or_invalid")
        try:
            manifest_bytes = manifest_path.read_bytes()
            manifest = json.loads(manifest_bytes)
            files = manifest["files"]
            if not isinstance(files, list) or not 3 <= len(files) <= 12:
                raise ValueError("invalid file list")
            checked = set()
            for record in files:
                relative = record["name"]
                if not isinstance(relative, str):
                    raise ValueError("invalid filename")
                candidate = (self.root / relative).resolve()
                if not candidate.is_relative_to(self.root) or relative in checked:
                    raise ValueError("model path escape or duplicate")
                checked.add(relative)
                if not candidate.is_file() or candidate.stat().st_size != record["bytes"]:
                    raise ValueError("model file missing or wrong size")
                with candidate.open("rb") as source:
                    digest = sha256()
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        digest.update(chunk)
                if digest.hexdigest() != record["sha256"]:
                    raise ValueError("model file hash mismatch")
            self.model_dir = (self.root / manifest["modelDirectory"]).resolve()
            self.source_spm = (self.root / manifest["sourceSentencePiece"]).resolve()
            self.target_spm = (self.root / manifest["targetSentencePiece"]).resolve()
            required = [self.model_dir / "model.bin", self.model_dir / "config.json",
                        self.model_dir / "shared_vocabulary.json", self.source_spm, self.target_spm]
            if any(not path.is_relative_to(self.root) or str(path.relative_to(self.root)).replace('\\', '/') not in checked for path in required):
                raise ValueError("unverified runtime file")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise TranslationRejected("mt_model_integrity_failed") from exc
        self.manifest_sha256 = sha256(manifest_bytes).hexdigest()
        self.model_id = "helsinki-opus-fr-en-20200226-ct2-int8@" + self.manifest_sha256

    def _load(self):
        if self._runtime is None:
            # The optional directory is an existing, operator-controlled install.
            # It is not installed, modified or downloaded by the worker.
            if self.deps_dir:
                if not self.deps_dir.is_dir():
                    raise TranslationRejected("local_mt_runtime_unavailable")
                directory = str(self.deps_dir)
                if directory not in sys.path:
                    sys.path.insert(0, directory)
            try:
                ct2 = self.loader("ctranslate2")
                spm = self.loader("sentencepiece")
                translator = ct2.Translator(str(self.model_dir), device="cpu", compute_type="int8",
                                            inter_threads=1, intra_threads=1)
                source = spm.SentencePieceProcessor(model_file=str(self.source_spm))
                target = spm.SentencePieceProcessor(model_file=str(self.target_spm))
                self._runtime = translator, source, target
            except (ImportError, OSError, RuntimeError, ValueError) as exc:
                raise TranslationRejected("local_mt_runtime_unavailable") from exc
        return self._runtime

    def __call__(self, model, prompt, remaining):
        if model != self.model_id:
            raise TranslationRejected("mt_model_identity_mismatch")
        if not isinstance(prompt, str) or len(prompt) > 30_000 or "\n\n\n" not in prompt:
            raise TranslationRejected("mt_source_frame_invalid")
        # The shared guard reconstructs the ORIGINAL French after this delimiter.
        source = prompt.rsplit("\n\n\n", 1)[-1]
        if not source.strip() or len(source) > 4000:
            raise TranslationRejected("translation_source_sentence_invalid")
        if not 0 < remaining <= 1800:
            raise TranslationRejected("translation_time_budget_exceeded")
        started = self.clock()
        translator, source_sp, target_sp = self._load()
        tokens = source_sp.encode(source, out_type=str)
        if not tokens or len(tokens) > MAX_SOURCE_TOKENS:
            raise TranslationRejected("mt_source_token_budget_exceeded")
        if self.clock() - started >= remaining:
            raise TranslationRejected("translation_time_budget_exceeded")
        # No truncation and deterministic beam search. The guard rejects missing,
        # added or reordered facts before the cascade can accept this output.
        result = translator.translate_batch([tokens], beam_size=4, max_decoding_length=512,
                                            max_input_length=0)[0]
        target = target_sp.decode(result.hypotheses[0])
        if self.clock() - started >= remaining:
            raise TranslationRejected("translation_time_budget_exceeded")
        if not isinstance(target, str) or not target.strip() or len(target) > 16_000:
            raise TranslationRejected("mt_response_invalid")
        return {"done": True, "done_reason": "stop", "message": {"content": target}}


def create_translator_from_env(cache_dir, max_seconds=1200, ensure_fallback_ready=None):
    """Explicit Marian mode only; never changes the runner's default provider."""
    root = Path(os.environ.get("WINTIPS_EDITORIAL_MT_ROOT", DEFAULT_ROOT))
    dependencies = os.environ.get("WINTIPS_EDITORIAL_MT_DEPS")
    transport = MarianTransport(root, deps_dir=dependencies)
    defaults = TranslationConfig()
    config = TranslationConfig(
        endpoint=os.environ.get("WINTIPS_EDITORIAL_MODEL_ENDPOINT", defaults.endpoint),
        model=os.environ.get("WINTIPS_EDITORIAL_MODEL", defaults.model),
        fallback_model=os.environ.get("WINTIPS_EDITORIAL_FALLBACK_MODEL", defaults.fallback_model) or None,
        max_seconds=max_seconds,
        num_threads=2,
    )
    translator = CascadeTranslator(config, mt_request=transport, mt_model=transport.model_id,
                                   cache_dir=cache_dir, ensure_fallback_ready=ensure_fallback_ready)
    translator.mt_manifest_sha256 = transport.manifest_sha256
    return translator
