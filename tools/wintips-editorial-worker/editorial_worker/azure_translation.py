"""Azure F0 adapter. No local model, raw HTML rendering, or lexical LLM guard.

Only an explicit Azure key enables requests. Quotas reserve the complete HTML
input before EVERY attempt, including failed/uncertain attempts and retries.
The caller owns the worker lock; a separate nonblocking quota lock also makes
direct uses safe. All translation artifacts remain in the private state dir.
"""
from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
from html import escape
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .translation import FIXED, LocalTranslator, TranslationRejected, _names, _team_form_label, _walk


VERSION = 'azure-html-facts-v1'
ENDPOINT = 'https://api.cognitive.microsofttranslator.com'
ROUTE = '/translate?api-version=3.0&from=fr&to=en&textType=html'
MAX_MONTH = 2_000_000
CARDINALS = {
    'zéro': 'zero', 'deux': 'two', 'trois': 'three', 'quatre': 'four',
    'cinq': 'five', 'six': 'six', 'sept': 'seven', 'huit': 'eight',
    'neuf': 'nine', 'dix': 'ten', 'onze': 'eleven', 'douze': 'twelve',
    'treize': 'thirteen', 'quatorze': 'fourteen', 'quinze': 'fifteen',
    'seize': 'sixteen', 'dix-sept': 'seventeen', 'dix-huit': 'eighteen',
    'dix-neuf': 'nineteen', 'vingt': 'twenty',
}
NUMBERS = re.compile(r'(?<!\w)[+\-−]?\s*\d+(?:[.,:/\-–−]\d+)*(?:er|re|ème|eme|e|st|nd|rd|th)?(?:\s*[%€$])?(?!\w)', re.I)
WRITTEN = re.compile(r'(?<![\w-])(?:' + '|'.join(sorted(CARDINALS, key=len, reverse=True)) + r')(?![\w-])', re.I)
NUMBER_UNIT = re.compile(r'^\s+(?:(?:derniers?|dernières?|premiers?|premières?|autres?|petits?|seuls?|seules?)\s+)*(?:points?|buts?|victoires?|défaites?|matchs?|matches|rencontres?|parties?|équipes?|joueurs?|hommes?|chevaux|partants?|tirs?|rebonds?|titres?|saisons?|ans?|années?|jours?|journées?|mois|minutes?|secondes?|quarts?[- ]temps|sets?|reprises?|fois|podiums?|sorties?|courses?|départs?|participations?|accessits?|places?)\b', re.I)
RANK_UNIT = re.compile(r'^\s+(?:premiers|premières)\b', re.I)
RANK_PREFIX = re.compile(r'\b(?:dans|parmi)\s+les\s*$', re.I)
ALPHANUMERIC_FACT = re.compile(r'(?<!\w)[+\-−]?(?=[\w-]*\d)[\w-]+(?!\w)')
ONE = re.compile(r'\b(?:un|une)(?=\s+(?:(?:seul|seule|petit|petite)\s+)*(?:point|but|victoire|défaite|match|rencontre|titre|saison|an|année|jour)\b)', re.I)
EXTRA_NUMBER = re.compile(r'\d|\b(?:' + '|'.join(CARDINALS.values()) + r')\b', re.I)
EXTRA_ONE = re.compile(r'\bone(?=\s+(?:(?:single|little)\s+)*(?:point|goal|win|victory|defeat|loss|match|game|title|season|year|day)\b)', re.I)


@dataclass(frozen=True)
class AzureConfig:
    key: str = field(repr=False)
    region: str = ''
    endpoint: str = ENDPOINT
    tier: str = 'F0'
    request_timeout: float = 30
    max_seconds: float = 180
    daily_characters: int = 100_000
    monthly_characters: int = 1_800_000
    batch_characters: int = 20_000
    batch_items: int = 25
    max_requests: int = 12
    retries: int = 2

    def __post_init__(self):
        if not isinstance(self.key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,256}', self.key):
            raise TranslationRejected('azure_key_required')
        if self.endpoint != ENDPOINT or self.tier != 'F0':
            raise TranslationRejected('azure_f0_public_endpoint_required')
        if not isinstance(self.region, str) or (self.region and not re.fullmatch(r'[a-z][a-z0-9-]{1,49}', self.region)):
            raise TranslationRejected('azure_region_invalid')
        integer_fields = (self.daily_characters, self.monthly_characters, self.batch_characters,
            self.batch_items, self.max_requests, self.retries)
        if (any(type(value) is not int for value in integer_fields) or
                not 0 < self.request_timeout <= 30 or not 0 < self.max_seconds <= 180 or
                not 1 <= self.daily_characters <= self.monthly_characters <= MAX_MONTH or
                not 1 <= self.batch_characters <= 20_000 or not 1 <= self.batch_items <= 25 or
                not 1 <= self.max_requests <= 12 or not 0 <= self.retries <= 2):
            raise TranslationRejected('azure_limits_invalid')


def _json_bytes(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (ValueError, TypeError, UnicodeError) as exc:
        raise TranslationRejected('azure_identity_invalid') from exc


def _private_regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or (os.name != 'nt' and stat.S_IMODE(info.st_mode) & 0o077):
        raise TranslationRejected('azure_private_state_required')
    return info


def _write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() or path.is_symlink():
        _private_regular(path)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(_json_bytes(value))
            handle.flush()
            os.fsync(handle.fileno())
        Path(temporary).replace(path)
        if os.name != 'nt':
            directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def _quota_lock(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / 'quota.lock'
    if path.is_symlink():
        raise TranslationRejected('azure_private_state_required')
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, 'r+b') as handle:
        _private_regular(path)
        try:
            if os.name == 'nt':
                import msvcrt
                if not handle.read(1):
                    handle.write(b'0')
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise TranslationRejected('azure_quota_busy') from exc
        try:
            yield
        finally:
            if os.name == 'nt':
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _characters(value):
    # UTF-16 units conservatively cover supplementary Unicode characters too.
    return len(value.encode('utf-16-le')) // 2


class Quota:
    def __init__(self, directory, config, now):
        self.directory, self.config, self.now = Path(directory), config, now

    def reserve(self, count):
        instant = self.now()
        if instant.tzinfo is None or not isinstance(count, int) or count < 1:
            raise TranslationRejected('azure_quota_clock_or_count_invalid')
        day = instant.astimezone(timezone.utc).date().isoformat()
        with _quota_lock(self.directory):
            path = self.directory / 'usage.json'
            state = {'schema': 1, 'days': {}, 'months': {}}
            if path.exists() or path.is_symlink():
                _private_regular(path)
                try:
                    if path.stat().st_size > 1_000_000:
                        raise ValueError()
                    state = json.loads(path.read_bytes())
                    if (not isinstance(state, dict) or state.get('schema') != 1 or
                            any(not isinstance(state.get(k), dict) or any(not isinstance(n, int) or isinstance(n, bool) or n < 0 for n in state[k].values()) for k in ('days', 'months'))):
                        raise ValueError()
                except (ValueError, TypeError, UnicodeError) as exc:
                    raise TranslationRejected('azure_quota_state_invalid') from exc
            used_day, used_month = state['days'].get(day, 0), state['months'].get(day[:7], 0)
            if used_day + count > self.config.daily_characters or used_month + count > self.config.monthly_characters:
                raise TranslationRejected('azure_character_quota_exhausted')
            state['days'][day], state['months'][day[:7]] = used_day + count, used_month + count
            _write_private(path, state)
            return {'day': day, 'charactersReserved': count, 'dayReserved': used_day + count, 'monthReserved': used_month + count}


def _number_display(value):
    ordinal = re.fullmatch(r'(\d+)(?:er|re|ème|eme|e|st|nd|rd|th)', value, re.I)
    if ordinal:
        n = int(ordinal[1])
        suffix = 'th' if 10 < n % 100 < 14 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')
        return ordinal[1] + suffix
    return value.replace('−', '-').replace('–', '-').replace(',', '.')


def protect(source, item):
    if not isinstance(source, str) or not source.strip() or len(source) > 30_000 or any(ord(c) < 32 and c not in '\n\r\t' for c in source):
        raise TranslationRejected('azure_source_invalid')
    spans = []
    def add(start, end, value, kind):
        if not any(start < old['end'] and end > old['start'] for old in spans):
            spans.append({'start': start, 'end': end, 'source': source[start:end], 'value': value, 'kind': kind})
    for name in _names(item):
        for match in re.finditer(r'(?<!\w)' + re.escape(name) + r'(?!\w)', source):
            add(match.start(), match.end(), match[0], 'verified_name')
    for match in NUMBERS.finditer(source):
        add(match.start(), match.end(), _number_display(match[0]), 'number')
    # Attached source units/IDs (21h00, R1C4, 2850m) remain exact too.
    for match in ALPHANUMERIC_FACT.finditer(source):
        add(match.start(), match.end(), match[0], 'number_with_source_unit')
    for match in WRITTEN.finditer(source):
        # In particular "un effectif neuf" means NEW, not NINE players.
        if (NUMBER_UNIT.match(source[match.end():]) or
                RANK_UNIT.match(source[match.end():]) and RANK_PREFIX.search(source[:match.start()])):
            add(match.start(), match.end(), CARDINALS[match[0].casefold()], 'written_number')
    for match in ONE.finditer(source):
        add(match.start(), match.end(), 'one', 'written_number')
    result, end = ['<div>'], 0
    for index, span in enumerate(sorted(spans, key=lambda row: row['start'])):
        span['id'] = 'wt' + str(index)
        result.extend((escape(source[end:span['start']]), '<span id="' + span['id'] + '" class="notranslate" translate="no">' + escape(span['value']) + '</span>'))
        end = span['end']
    result.extend((escape(source[end:]), '</div>'))
    return ''.join(result), sorted(spans, key=lambda row: row['start'])


class ProtectedText(HTMLParser):
    def __init__(self, protected):
        super().__init__(convert_charrefs=True)
        self.expected = {row['id']: row for row in protected}
        self.stack, self.output, self.free, self.seen = [], [], [], Counter()
        self.roots, self.active, self.content = 0, None, []

    def fail(self):
        raise TranslationRejected('azure_output_structure_or_facts_changed')

    def handle_starttag(self, tag, attrs):
        if len(attrs) != len(dict(attrs)):
            self.fail()
        attrs = dict(attrs)
        if not self.stack and tag == 'div' and not attrs and self.roots == 0:
            self.roots += 1
        elif self.stack == ['div'] and tag == 'span':
            key = attrs.get('id')
            if key not in self.expected or attrs != {'id': key, 'class': 'notranslate', 'translate': 'no'}:
                self.fail()
            self.active, self.content = key, []
            self.seen[key] += 1
        else:
            self.fail()
        self.stack.append(tag)

    def handle_endtag(self, tag):
        if not self.stack or self.stack[-1] != tag:
            self.fail()
        if tag == 'span':
            value = ''.join(self.content)
            if value != self.expected[self.active]['value']:
                self.fail()
            self.output.append(value)
            self.active = None
        self.stack.pop()

    def handle_data(self, value):
        if not self.stack:
            if value.strip():
                self.fail()
        elif self.active is not None:
            self.content.append(value)
        else:
            self.output.append(value)
            self.free.append(value)

    def handle_comment(self, data): self.fail()
    def handle_decl(self, decl): self.fail()
    def handle_pi(self, data): self.fail()
    def unknown_decl(self, data): self.fail()

    def finish(self):
        self.close()
        if self.stack or self.roots != 1 or self.seen != Counter({key: 1 for key in self.expected}):
            self.fail()
        # The provider may move an entire factual span for English grammar,
        # but cannot change/drop/duplicate it or introduce a new quantity.
        if EXTRA_NUMBER.search(''.join(self.free)) or EXTRA_ONE.search(''.join(self.free)):
            raise TranslationRejected('azure_unprotected_number_added')
        target = ''.join(self.output).strip()
        if not target or any(ord(c) < 32 and c not in '\n\r\t' for c in target):
            self.fail()
        return target


def validate_output(source, item, content):
    _, anchors = protect(source, item)
    if not isinstance(content, str) or len(content) > 200_000:
        raise TranslationRejected('azure_response_invalid')
    parser = ProtectedText(anchors)
    parser.feed(content)
    target = parser.finish()
    for name in _names(item):
        # Canonical capitalization is not an added team/competition. Protected
        # span contents above still remain byte-exact; count all unprotected
        # case variants too, so a duplicate lowercase name cannot evade checks.
        pattern = r'(?<!\w)' + re.escape(name.casefold()) + r'(?!\w)'
        if len(re.findall(pattern, source.casefold())) != len(re.findall(pattern, target.casefold())):
            raise TranslationRejected('azure_name_occurrences_changed')
    # Copying an entire narrative unchanged is not an English translation.
    if target == source:
        raise TranslationRejected('azure_untranslated_text')
    return target, {'passed': True, 'validatorVersion': VERSION,
        'knownNamesPreserved': True, 'numericSpansPreserved': True,
        'htmlRemoved': True, 'lexicalOrderRequired': False,
        'semanticQualityProven': False}


class AzureFailure(Exception):
    def __init__(self, status, retry_after=0):
        super().__init__('azure_http_' + str(status))
        self.status, self.retry_after = status, retry_after


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise TranslationRejected('azure_redirect_forbidden')


class AzureTransport:
    def __init__(self, config):
        self.config = config
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def __call__(self, texts, timeout):
        headers = {'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json',
            'Ocp-Apim-Subscription-Key': self.config.key, 'User-Agent': 'WinTipsEditorialWorker/Azure1'}
        if self.config.region:
            headers['Ocp-Apim-Subscription-Region'] = self.config.region
        request = Request(self.config.endpoint + ROUTE, data=_json_bytes([{'Text': value} for value in texts]), headers=headers, method='POST')
        try:
            with self.opener.open(request, timeout=timeout) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise TranslationRejected('azure_response_too_large')
                return json.loads(raw)
        except HTTPError as exc:
            # Provider error bodies and headers can contain private metadata.
            retry = exc.headers.get('Retry-After', '') if exc.headers else ''
            exc.close()
            raise AzureFailure(exc.code, min(10, int(retry)) if re.fullmatch(r'\d{1,4}', retry) else 0) from None
        except (URLError, TimeoutError, OSError):
            raise TranslationRejected('azure_transport_failed') from None
        except (ValueError, UnicodeError):
            raise TranslationRejected('azure_response_invalid') from None


class AzureTranslator:
    version = VERSION
    provider = 'azure'

    def __init__(self, config, *, cache_dir, quota_dir, request=None, now=None, monotonic=time.monotonic, sleep=time.sleep):
        self.config, self.directory = config, Path(cache_dir) / 'azure'
        self.request = request or AzureTransport(config)
        self.monotonic, self.sleep, self.started = monotonic, sleep, monotonic()
        self.quota = Quota(quota_dir, config, now or (lambda: datetime.now(timezone.utc)))
        self.records, self.prepared, self.requests, self.attempts = [], {}, 0, []

    def remaining(self):
        value = self.config.max_seconds - (self.monotonic() - self.started)
        if value <= 0:
            raise TranslationRejected('azure_time_budget_exhausted')
        return value

    def market(self, source, item):
        # Deterministic sport markets keep participant, line and betType.
        return LocalTranslator.market(self, source, item)

    def deterministic(self, source, item):
        if not isinstance(source, str):
            raise TranslationRejected('azure_source_invalid')
        if source in FIXED:
            return FIXED[source]
        form = _team_form_label(source, item)
        if form is not None:
            return form
        if source == item.get('selection', {}).get('label', {}).get('fr'):
            return self.market(source, item)
        remainder = source
        for name in _names(item):
            remainder = remainder.replace(name, '')
        if not re.search(r'\w', remainder):
            return source
        if re.fullmatch(r'R\d+C\d+ · (?:attelé|monté|plat|haies|steeple-chase) · \d+ m', source):
            for fr, en in {'attelé': 'harness racing', 'monté': 'mounted trotting', 'plat': 'flat racing', 'haies': 'hurdles', 'steeple-chase': 'steeplechase'}.items():
                source = source.replace(' · ' + fr + ' · ', ' · ' + en + ' · ')
            return source
        return None

    def job(self, source, item):
        html, anchors = protect(source, item)
        facts = deepcopy(item)
        for row in _walk(facts):
            for field in ('title', 'summary', 'analysis'):
                if isinstance(row.get(field), dict): row[field].pop('en', None)
            if isinstance(row.get('selection', {}).get('label'), dict): row['selection']['label'].pop('en', None)
        identity = {'schema': 1, 'provider': 'azure', 'version': VERSION, 'endpoint': self.config.endpoint,
            'route': ROUTE, 'region': self.config.region, 'tier': self.config.tier,
            'source': source, 'html': html, 'anchors': anchors,
            'factContextSha256': sha256(_json_bytes(facts)).hexdigest()}
        return {'key': sha256(_json_bytes(identity)).hexdigest(), 'identity': identity, 'source': source,
            'item': item, 'html': html}

    def cached(self, job):
        path = self.directory / 'responses' / (job['key'] + '.json')
        if not path.exists() and not path.is_symlink(): return False
        _private_regular(path)
        try:
            if path.stat().st_size > 2_000_000: raise ValueError()
            record = json.loads(path.read_bytes())
            if not isinstance(record, dict) or record.get('identity') != job['identity'] or not isinstance(record.get('html'), str): raise ValueError()
        except (ValueError, TypeError, UnicodeError) as exc:
            raise TranslationRejected('azure_cache_invalid') from exc
        target, proof = validate_output(job['source'], job['item'], record['html'])
        self.prepared[job['key']] = (target, proof, True)
        return True

    def send(self, jobs):
        texts = [job['html'] for job in jobs]
        count = sum(_characters(value) for value in texts)
        if not jobs or len(jobs) > self.config.batch_items or count > self.config.batch_characters:
            raise TranslationRejected('azure_request_size_exceeded')
        for attempt in range(self.config.retries + 1):
            self.remaining()
            if self.requests >= self.config.max_requests:
                raise TranslationRejected('azure_request_budget_exhausted')
            reservation = self.quota.reserve(count)
            self.requests += 1
            trace = {'attempt': self.requests, 'textCount': len(texts),
                'reservedCharacters': count, 'quota': reservation, 'status': 'reserved'}
            self.attempts.append(trace)
            try:
                timeout = min(self.config.request_timeout, self.remaining())
                raw = self.request(texts, timeout)
                self.remaining()
                if not isinstance(raw, list) or len(raw) != len(jobs):
                    raise TranslationRejected('azure_response_count_mismatch')
                validated = []
                for job, row in zip(jobs, raw):
                    values = row.get('translations') if isinstance(row, dict) and 'error' not in row else None
                    if (not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict) or
                            values[0].get('to') != 'en' or not isinstance(values[0].get('text'), str)):
                        raise TranslationRejected('azure_response_invalid')
                    target, proof = validate_output(job['source'], job['item'], values[0]['text'])
                    validated.append((job, values[0]['text'], target, proof))
                # Validate the entire response before exposing any of it.
                for job, html, target, proof in validated:
                    _write_private(self.directory / 'responses' / (job['key'] + '.json'),
                        {'identity': job['identity'], 'html': html, 'reservation': reservation})
                    self.prepared[job['key']] = (target, proof, False)
                trace['status'] = 'validated'
                return
            except AzureFailure as exc:
                trace['status'] = 'http_' + str(exc.status)
                if exc.status not in {429, 500, 502, 503, 504} or attempt == self.config.retries:
                    raise TranslationRejected('azure_http_' + str(exc.status)) from None
                pause = max(exc.retry_after, 1 << attempt)
                if pause >= self.remaining(): raise TranslationRejected('azure_time_budget_exhausted') from None
                self.sleep(pause)
            except Exception as exc:
                trace['status'] = getattr(exc, 'code', 'azure_request_failed')
                raise

    def prepare_batch(self, payload):
        pending = {}
        for top in payload.get('items', []):
            for item in _walk(top):
                values = [item[field]['fr'] for field in ('title', 'summary')]
                for section in item['analysis']['fr']:
                    values.extend([section['heading'], *section['paragraphs']])
                for source in values:
                    if not source or self.deterministic(source, item) is not None: continue
                    job = self.job(source, item)
                    if job['key'] not in self.prepared and not self.cached(job): pending[job['key']] = job
        batch, count = [], 0
        for job in pending.values():
            size = _characters(job['html'])
            if size > self.config.batch_characters: raise TranslationRejected('azure_paragraph_too_large')
            if batch and (count + size > self.config.batch_characters or len(batch) >= self.config.batch_items):
                self.send(batch)
                batch, count = [], 0
            batch.append(job)
            count += size
        if batch: self.send(batch)

    def text(self, source, item):
        if not isinstance(source, str): raise TranslationRejected('azure_source_invalid')
        if not source: return source
        result = self.deterministic(source, item)
        if result is not None: return result
        job = self.job(source, item)
        if job['key'] not in self.prepared and not self.cached(job): self.send([job])
        target, proof, cached = self.prepared[job['key']]
        self.records.append({'provider': 'azure', 'model': 'azure-translator-v3-general', 'source': source,
            'target': target, 'cacheKey': job['key'], 'cached': cached, 'proof': proof})
        return target


def create_translator_from_env(cache_dir, max_seconds=180):
    try:
        config = AzureConfig(key=os.environ.get('WINTIPS_EDITORIAL_AZURE_KEY', ''),
            region=os.environ.get('WINTIPS_EDITORIAL_AZURE_REGION', ''),
            tier=os.environ.get('WINTIPS_EDITORIAL_AZURE_TIER', 'F0'),
            max_seconds=min(float(max_seconds), 180),
            daily_characters=int(os.environ.get('WINTIPS_EDITORIAL_AZURE_DAILY_CHARACTERS', '100000')),
            monthly_characters=int(os.environ.get('WINTIPS_EDITORIAL_AZURE_MONTHLY_CHARACTERS', '1800000')))
    except (ValueError, TypeError):
        raise TranslationRejected('azure_limits_invalid') from None
    quota = Path(os.environ.get('WINTIPS_EDITORIAL_AZURE_QUOTA_DIR', '/var/lib/wintips-editorial-worker/azure-quota'))
    if not quota.is_absolute():
        raise TranslationRejected('azure_absolute_quota_directory_required')
    return AzureTranslator(config, cache_dir=cache_dir, quota_dir=quota)
