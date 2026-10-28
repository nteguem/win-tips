"""Authoritative pure Node validator from this exact API checkout, never HTTP."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

SOURCES = {'tools/wintips-editorial-worker/validate-api-payload.cjs',
    'src/api/services/common/editorialValidation.js', 'src/api/services/common/editorialNumericFacts.js',
    'src/api/services/common/editorialSources.js', 'src/api/services/common/editorialCalendar.js',
    'src/api/services/common/editorialCopy.js', 'src/api/services/common/couponTeaser.js'}


class ApiPreflightRejected(ValueError):
    def __init__(self, code, audit=None):
        super().__init__(code)
        self.code, self.audit = code, audit or {}


def payload_bytes(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def validate_api_payload(payload, now=None):
    # Never freeze the CLI clock to collection/translation time. The Node
    # subprocess uses the current clock immediately before the real POST.
    directory = Path(__file__).resolve().parents[1]
    tool = directory / 'validate-api-payload.cjs'
    binary = shutil.which('node')
    if not binary or not tool.is_file() or tool.is_symlink():
        raise ApiPreflightRejected('api_validator_unavailable')
    raw = payload_bytes(payload)
    if len(raw) > 4_000_000:
        raise ApiPreflightRejected('api_payload_too_large')
    try:
        done = subprocess.run([binary, str(tool)], input=raw, capture_output=True, timeout=20,
            cwd=directory, shell=False)
        if len(done.stdout) > 1_000_000:
            raise ValueError()
        receipt = json.loads(done.stdout)
    except subprocess.TimeoutExpired:
        raise ApiPreflightRejected('api_validator_timeout') from None
    except (OSError, ValueError, TypeError):
        raise ApiPreflightRejected('api_validator_receipt_invalid') from None
    if not isinstance(receipt, dict) or receipt.get('version') != 'editorial-api-preflight-v1':
        raise ApiPreflightRejected('api_validator_receipt_invalid')
    if done.returncode or receipt.get('passed') is not True:
        code = receipt.get('code')
        if code not in {'api_validator_checkout_unavailable', 'api_payload_schema_or_clock_invalid',
                'api_complete_english_invalid', 'api_payload_too_large'}:
            code = 'api_validator_rejected'
        # The trusted tool emits only paths, typed codes and source identities.
        # Never forward child stderr, process environment or backend messages.
        raise ApiPreflightRejected(code, receipt)
    checkout = receipt.get('checkout')
    if (receipt.get('payloadSha256') != hashlib.sha256(raw).hexdigest() or
            receipt.get('source') != payload.get('source') or
            receipt.get('editionDate') != payload.get('editionDate') or
            type(receipt.get('itemCount')) is not int or receipt['itemCount'] != len(payload.get('items', [])) or
            not isinstance(checkout, dict) or not isinstance(checkout.get('head'), str) or not re.fullmatch(r'[a-f0-9]{40}', checkout['head']) or
            not isinstance(checkout.get('sourceSha256'), dict) or set(checkout['sourceSha256']) != SOURCES or
            any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in checkout['sourceSha256'].values())):
        raise ApiPreflightRejected('api_validator_receipt_binding_invalid')
    return receipt
