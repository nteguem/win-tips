"""Dry-run by default; authenticated import requires an explicit --publish."""
from __future__ import annotations

import argparse
from contextlib import contextmanager, ExitStack
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import Request, HTTPRedirectHandler, ProxyHandler, build_opener

from .http import PublicFetcher
from .sources import SOURCES, MATCH_PATH, RACE_PATH, COMBI_PATH, collect, eligible, iso, source_url, ticket_fingerprint
from .calendar import edition_day, EDITION_TIMEZONE


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", "utf-8")
    temporary.replace(path)


def ticket_reservations(configured, edition):
    """Protected server state, never a local last-run guess or an input payload."""
    state = configured.get('ticketState') if configured else None
    if not isinstance(state, dict) or state.get('ready') is not True or state.get('editionDate') != edition or state.get('version') != 'rdj-ticket-v1':
        raise ValueError('authoritative_ticket_reservations_unavailable')
    def entry(value):
        if not isinstance(value, dict) or not re.fullmatch(r'[a-f0-9]{64}', value.get('fingerprint', '')) or not re.fullmatch(r'\d+', value.get('sourceId', '')):
            raise ValueError('authoritative_ticket_reservations_invalid')
        url = source_url(value.get('sourceUrl', ''))
        match = COMBI_PATH.fullmatch(urlsplit(url).path)
        if match is None or match['id'] != value['sourceId']:
            raise ValueError('authoritative_ticket_reservations_invalid')
        return {key: value[key] for key in ('fingerprint', 'sourceId', 'sourceUrl')}
    duo = entry(state['duo']) if state.get('duo') is not None else None
    if not isinstance(state.get('goals'), list) or len(state['goals']) > 50:
        raise ValueError('authoritative_ticket_reservations_invalid')
    goals = [entry(row) for row in state['goals']]
    if duo and any(row['fingerprint'] == duo['fingerprint'] for row in goals):
        raise ValueError('authoritative_ticket_reservations_conflict')
    return duo, {row['fingerprint'] for row in goals}


@contextmanager
def single_run(directory):
    path = Path(directory)
    path.mkdir(parents=True, exist_ok=True)
    with (path / "worker.lock").open("a+b") as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            if not handle.read(1):
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("api_redirect_forbidden")


class ApiHttpError(ValueError):
    """Only a status and a known short machine code may leave the HTTP layer."""
    def __init__(self, status, api_code=None):
        self.code = 'api_http_' + str(status)
        self.http_diagnostic = {'status': status}
        if api_code is not None:
            self.http_diagnostic['apiCode'] = api_code
        super().__init__(self.code)


def api_http_error(error):
    status = error.code if type(error.code) is int and 100 <= error.code <= 599 else 500
    code = None
    try:
        raw = error.read(16_385)
        if len(raw) <= 16_384:
            body = json.loads(raw)
            candidate = body.get('error', {}).get('code') if isinstance(body, dict) and isinstance(body.get('error'), dict) else None
            known = {'VALIDATION_ERROR', 'AUTH_TOKEN_MISSING', 'AUTH_INVALID_TOKEN', 'FORBIDDEN',
                'NOT_FOUND', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR', 'SUBSCRIPTION_REQUIRED', 'RESOURCE_LOCKED'}
            if isinstance(candidate, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,48}', candidate) and candidate in known:
                code = candidate
            elif type(candidate) is int and candidate in {400, 401, 403, 404, 409, 422, 429, 500, 503, 11000}:
                code = candidate
    except Exception:
        pass
    finally:
        error.close()
    return ApiHttpError(status, code)


class ApiClient:
    def __init__(self, base, token):
        u = urlsplit(base)
        allowed = u.scheme == "https" or (u.scheme == "http" and u.hostname in {"127.0.0.1", "localhost", "::1"})
        if not allowed or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ("", "/"):
            raise ValueError("api_requires_https_or_loopback_origin")
        if not token or any(c.isspace() for c in token):
            raise ValueError("worker_token_required")
        self.base, self.token = base.rstrip("/"), token
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, route, payload=None):
        if route not in {"/api/internal/editorial/config", "/api/internal/editorial/import", "/api/internal/editorial/notifications/drain"}:
            raise ValueError("unsupported_worker_route")
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode()
        request = Request(self.base + route, data=data, method="GET" if payload is None else "POST",
                          headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json",
                                   "Accept": "application/json", "User-Agent": "WinTipsEditorialWorker/0.1"})
        try:
            with self.opener.open(request, timeout=140 if route.endswith('/notifications/drain') else 140 if payload is not None else 40) as response:
                raw = response.read(4_000_001)
                if len(raw) > 4_000_000:
                    raise ValueError("api_response_too_large")
                result = json.loads(raw)
        except HTTPError as error:
            raise api_http_error(error) from None
        if result.get("success") is not True or not isinstance(result.get("data"), dict):
            raise ValueError("worker_api_rejected")
        return result["data"]


def validate_item(item, source, edition, now, lead):
    if item.get("source") != source or item.get("editionDate") != edition:
        raise ValueError("item_source_or_date_conflict")
    if not isinstance(item.get("sourceId"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", item["sourceId"]):
        raise ValueError("item_stable_source_id_required")
    path = urlsplit(source_url(item.get("sourceUrl"))).path
    patterns = {"rdj_petit_journal": r"/paris-sportifs/le-petit-journal/\d+[^/?#]+\.html",
                "rdj_football_analysis": MATCH_PATH,
                "rdj_multisport_analysis": MATCH_PATH,
                "rdj_turf_quinte": RACE_PATH, "rdj_football_combine": COMBI_PATH,
                "rdj_football_duo": COMBI_PATH, "rdj_football_goals": COMBI_PATH}
    if re.fullmatch(patterns[source], path) is None:
        raise ValueError("source_url_does_not_match_adapter")
    if not eligible(item, edition, now, lead) or item.get("status") != "upcoming":
        raise ValueError("item_outside_publication_window")
    if not item.get("title", {}).get("fr") or not item.get("analysis", {}).get("fr"):
        raise ValueError("item_french_content_required")
    if item.get("kind") == "combine":
        if not 2 <= len(item.get("legs", [])) <= 5 or not item.get("selection", {}).get("totalOdds"):
            raise ValueError("explicit_combine_content_required")
        for leg in item["legs"]:
            if not MATCH_PATH.fullmatch(urlsplit(source_url(leg.get("sourceUrl"))).path) or not eligible(leg, edition, now, lead):
                raise ValueError("combine_leg_unverified")
        if len({leg.get('sourceId') for leg in item['legs']}) != len(item['legs']):
            raise ValueError('duplicate_combine_fixture')
        if source in {'rdj_football_duo', 'rdj_football_goals'}:
            proof = item.get('curation', {})
            if proof.get('kind') != 'publisher_ticket' or proof.get('publisher') != 'RDJ' or proof.get('sourceUrl') != item['sourceUrl']:
                raise ValueError('publisher_ticket_provenance_required')
            if source == 'rdj_football_duo' and (len(item['legs']) != 2 or not 2 <= item['selection']['totalOdds'] <= 4):
                raise ValueError('duo_requires_two_legs_and_total_2_to_4')
            if source == 'rdj_football_goals':
                from .markets import GOAL_TYPES
                if not 2 <= len(item['legs']) <= 3 or any(leg.get('selection', {}).get('betType') not in GOAL_TYPES for leg in item['legs']):
                    raise ValueError('goals_requires_two_or_three_goal_markets')


def make_translator(args, output, resources):
    mode = os.environ.get('WINTIPS_EDITORIAL_TRANSLATOR', 'ollama')
    if mode == 'gemini':
        from .gemini_translation import create_translator_from_env
        return create_translator_from_env(cache_dir=output / 'translation-cache',
            max_seconds=min(getattr(args, 'translation_max_seconds', 1200), 600))
    if mode == 'azure':
        from .azure_translation import create_translator_from_env
        return create_translator_from_env(cache_dir=output / 'translation-cache',
            max_seconds=min(getattr(args, 'translation_max_seconds', 1200), 180))
    from .translation import LocalTranslator, TranslationConfig
    started = False
    def ensure_fallback_ready():
        nonlocal started
        if not started and os.environ.get('WINTIPS_EDITORIAL_MANAGE_MODEL') == 'true':
            from .model_runtime import managed_model
            resources.enter_context(managed_model(translation_seconds=getattr(args, 'translation_max_seconds', 1200)))
        started = True
    if mode == 'marian':
        from .mt_translation import create_translator_from_env
        return create_translator_from_env(cache_dir=output / 'translation-cache', max_seconds=getattr(args, 'translation_max_seconds', 1200), ensure_fallback_ready=ensure_fallback_ready)
    if mode != 'ollama':
        raise ValueError('unknown_local_translation_provider')
    ensure_fallback_ready()
    defaults = TranslationConfig()
    return LocalTranslator(TranslationConfig(
        endpoint=os.environ.get('WINTIPS_EDITORIAL_MODEL_ENDPOINT', defaults.endpoint),
        model=os.environ.get('WINTIPS_EDITORIAL_MODEL', defaults.model),
        fallback_model=os.environ.get('WINTIPS_EDITORIAL_FALLBACK_MODEL', defaults.fallback_model),
        max_seconds=getattr(args, 'translation_max_seconds', 1200),
    ), cache_dir=output / 'translation-cache')


def safe_reason(error):
    code = getattr(error, 'code', None)
    return code if isinstance(code, str) and re.fullmatch(r'[A-Za-z0-9_]{1,100}', code) else type(error).__name__


def translation_failure_audit(error, translator, payload, first_record=0, first_attempt=0):
    """Retain content/guard evidence; never serialize exception/provider messages.

    Audit artifacts belong to the private worker state, not the API payload.
    Bounds prevent a malformed external response from making reports unbounded.
    """
    def safe(value, depth=0):
        if depth > 12: return {'auditLimit': 'depth'}
        if isinstance(value, str): return value if len(value) <= 30_000 else value[:30_000] + '[audit truncated]'
        if value is None or type(value) in (bool, int): return value
        if type(value) is float: return value if value == value and abs(value) != float('inf') else None
        if isinstance(value, list): return [safe(row, depth + 1) for row in value[:500]]
        if isinstance(value, dict):
            return {str(key): safe(row, depth + 1) for key, row in list(value.items())[:500]
                if isinstance(key, str) and not re.search(r'api.?key|authorization|bearer|secret|password|credential|^token$', key, re.I)}
        return type(value).__name__
    details = safe(getattr(error, 'audit', {}))
    return {'status': 'rejected', 'reason': safe_reason(error),
        'source': payload.get('source'), 'editionDate': payload.get('editionDate'),
        'payloadSha256': hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
            separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest(),
        'provider': getattr(translator, 'provider', 'local'),
        'details': details, 'records': safe(getattr(translator, 'records', [])[first_record:]),
        'cloudAttempts': safe(getattr(translator, 'attempts', [])[first_attempt:]),
        'publicationAllowed': False}


def run(args, *, fetcher=None, now=None, api_client=None, translator=None, clock=None, api_validator=None):
    instant = now or datetime.now(timezone.utc)
    edition = args.edition or edition_day(instant).isoformat()
    if date.fromisoformat(edition).isoformat() != edition or args.minimum_lead_minutes < 30:
        raise ValueError("canonical_edition_and_minimum_30_minutes_required")
    if args.publish and edition != edition_day(instant).isoformat():
        raise ValueError("publication_requires_current_source_edition")
    selected = list(SOURCES) if not args.source else list(dict.fromkeys(args.source))
    if any(source not in SOURCES for source in selected):
        raise ValueError("unknown_source")
    # Free IDs must be known before VIP collection; the basic Duo owns its
    # composition before Goals, even when CLI/config sources arrive reversed.
    order = {key: index for index, key in enumerate(SOURCES)}
    selected.sort(key=lambda key: (0 if key == 'rdj_petit_journal' else 1 if key == 'rdj_football_duo' else 3 if key == 'rdj_football_goals' else 2, order[key]))
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    fetched = fetcher or PublicFetcher(output / "http-cache", max_requests=args.max_requests,
                                      max_seconds=args.max_seconds, ttl=args.cache_ttl_seconds)
    client = api_client
    configured = None
    if args.api_base:
        client = client or ApiClient(args.api_base, os.environ.get("WINTIPS_EDITORIAL_WORKER_TOKEN", ""))
        configured = client.request("/api/internal/editorial/config")
        if configured.get("date") != edition:
            raise ValueError("worker_config_date_conflict")
        active = {row["key"] for row in configured.get("sources", [])
                  if row.get("key") in SOURCES and row.get("categoryIds")}
        selected = [key for key in selected if key in active]
    if args.publish and (client is None or configured is None or configured.get("importEnabled") is not True):
        raise ValueError("explicit_api_configuration_and_enabled_import_required")
    bilingual = args.publish or getattr(args, 'translate', False)
    report = {"editionDate": edition, "editionTimezone": EDITION_TIMEZONE, "mode": "publish" if args.publish else "dry_run", "notificationsSent": False,
              'bilingualRequired': bilingual, 'notificationsAccepted': 0,
              "startedAtUtc": instant.isoformat(), "sources": [], "published": False}
    seen_free = set()
    prior = output / "editions" / edition / "rdj_petit_journal.json"
    if prior.is_file():
        try:
            saved = json.loads(prior.read_text("utf-8"))
            seen_free.update(row["sourceId"] for row in saved.get("items", [])
                             if row.get("editionDate") == edition and row.get("source") == "rdj_petit_journal")
        except (ValueError, KeyError, TypeError):
            pass
    with single_run(output), ExitStack() as resources:
        collected = []
        seen_duo_tickets = set()
        pinned_duo, seen_goal_tickets, ticket_state_error = None, set(), None
        if configured is not None and any(source in {'rdj_football_duo', 'rdj_football_goals'} for source in selected):
            try:
                pinned_duo, seen_goal_tickets = ticket_reservations(configured, edition)
                if pinned_duo:
                    seen_duo_tickets.add(pinned_duo['fingerprint'])
            except (ValueError, KeyError, TypeError) as exc:
                ticket_state_error = safe_reason(exc)
        # Finish the bounded public HTTP collection BEFORE model inference.
        # Translation time must not consume the fetcher's four-minute budget.
        for source in selected:
            try:
                extra = {}
                if source in {'rdj_football_duo', 'rdj_football_goals'}:
                    if ticket_state_error:
                        raise ValueError(ticket_state_error)
                    extra = {'exclude_ticket_fingerprints': seen_duo_tickets if source == 'rdj_football_goals' else seen_goal_tickets}
                    if source == 'rdj_football_duo' and pinned_duo:
                        extra['pinned_ticket'] = pinned_duo
                result = collect(source, edition, fetched, now=instant, lead=args.minimum_lead_minutes, exclude_ids=seen_free, **extra)
                payload = {"source": source, "editionDate": edition, "items": result["items"]}
                for item in payload["items"]:
                    validate_item(item, source, edition, instant, args.minimum_lead_minutes)
                if source == 'rdj_petit_journal':
                    seen_free.update(item['sourceId'] for item in result['items'])
                if source == 'rdj_football_duo':
                    seen_duo_tickets.update(ticket_fingerprint(item) for item in result['items'])
                file = output / 'editions' / edition / (source + ('.fr.json' if bilingual else '.json'))
                write_json(file, payload)
                row = {'source': source, 'status': result['status'], 'itemCount': len(result['items']),
                    'issues': list(result['issues']), 'payloadFile': str(file), 'imported': False}
                if result.get('sourceCanonicalizationAudits'):
                    from .azure_translation import _write_private
                    audit_file = output / 'normalization-audits' / edition / (source + '.json')
                    _write_private(audit_file, {'source': source, 'editionDate': edition,
                        'audits': result['sourceCanonicalizationAudits']})
                    row['sourceNormalizationAuditFile'] = str(audit_file)
                    row['sourceNormalizationAuditSha256'] = hashlib.sha256(audit_file.read_bytes()).hexdigest()
                if result['status'] == 'source_incomplete':
                    report['blocked'] = True
                collected.append((source, payload, row))
            except Exception as exc:
                row = {'source': source, 'status': 'source_blocked', 'itemCount': 0, 'issues': [safe_reason(exc)], 'imported': False}
                report['blocked'] = True
            report['sources'].append(row)
        prepared = []
        # Public HTTP surveillance remains light. If generation cannot finish
        # safely before BigWin, defer the complete delivery phase without waiting
        # for, acquiring, or keeping any shared model lock.
        if (bilingual and os.environ.get('WINTIPS_EDITORIAL_MANAGE_MODEL') == 'true' and
                os.environ.get('WINTIPS_EDITORIAL_TRANSLATOR', 'ollama') not in {'azure', 'gemini'}):
            from .model_runtime import RuntimeDeferred, require_admission
            try:
                require_admission(clock() if clock else datetime.now(timezone.utc), getattr(args, 'translation_max_seconds', 1200))
            except RuntimeDeferred as exc:
                report['deferred'] = {'reason': exc.code, **exc.window}
                report['blocked'] = True
        for source, payload, row in collected:
            if not payload['items']:
                continue
            if report.get('deferred'):
                row['status'] = 'deferred_shared_window'
                row['issues'].append(report['deferred']['reason'])
                continue
            first_record = len(getattr(translator, 'records', []))
            first_attempt = len(getattr(translator, 'attempts', []))
            try:
                if bilingual:
                    from .translation import translate_batch, require_bilingual
                    if translator is None:
                        translator = make_translator(args, output, resources)
                    payload, audit = translate_batch(payload, translator)
                    require_bilingual(payload)
                    final_file = output / 'editions' / edition / (source + '.json')
                    write_json(final_file, payload)
                    write_json(output / 'translation-audits' / edition / (source + '.json'), audit)
                    row['payloadFile'] = str(final_file)
                    row['bilingual'] = True
                prepared.append((source, payload, row))
            except Exception as exc:
                if os.environ.get('WINTIPS_EDITORIAL_TRANSLATOR', 'ollama') not in {'azure', 'gemini'}:
                    from .model_runtime import RuntimeDeferred
                    if isinstance(exc, RuntimeDeferred):
                        report['deferred'] = {'reason': exc.code, **exc.window}
                row['status'] = 'translation_blocked' if bilingual else 'source_blocked'
                row['issues'].append(safe_reason(exc))
                if bilingual:
                    failure_file = output / 'translation-audits' / edition / (source + '.failed.json')
                    try:
                        from .azure_translation import _write_private
                        _write_private(failure_file, translation_failure_audit(exc, translator, payload,
                            first_record, first_attempt))
                        row['translationFailureAuditFile'] = str(failure_file)
                    except Exception as audit_error:
                        row['translationFailureAuditError'] = safe_reason(audit_error)
                report['blocked'] = True
        # Do not keep model RAM/shared locks during database writes or FCM waits.
        try:
            resources.close()
        except Exception as exc:
            report['runtimeCleanupError'] = safe_reason(exc)
            report['blocked'] = True
        delivery_allowed = not report.get('deferred') and not report.get('runtimeCleanupError')
        if args.publish and delivery_allowed:
            for source, payload, row in prepared:
                try:
                    check_clock = clock() if clock else datetime.now(timezone.utc)
                    if edition_day(check_clock).isoformat() != edition:
                        raise ValueError('edition_changed_during_collection')
                    for item in payload['items']:
                        validate_item(item, source, edition, check_clock, args.minimum_lead_minutes)
                    from .api_preflight import validate_api_payload
                    row['apiPreflight'] = (api_validator or validate_api_payload)(payload, check_clock)
                    if row['apiPreflight'].get('passed') is not True:
                        raise ValueError('api_validator_rejected')
                    outcome = client.request('/api/internal/editorial/import', payload)
                    row['imported'] = not bool(outcome.get('ignored', False))
                    row['apiResult'] = outcome
                    report['published'] = report['published'] or not outcome.get('ignored', False)
                    report['notificationsAccepted'] += int(outcome.get('notificationsSent', 0))
                except Exception as exc:
                    row['status'] = 'import_blocked'
                    row['issues'].append(safe_reason(exc))
                    if hasattr(exc, 'audit'):
                        row['apiPreflight'] = exc.audit
                    if isinstance(exc, ApiHttpError):
                        row['apiHttpError'] = exc.http_diagnostic
                    report['blocked'] = True
        # Resume pending delivery even on a day/run with no new source item.
        # A preview never calls this POST route or any provider.
        if args.publish and delivery_allowed and configured.get('notificationsEnabled') is True:
            try:
                outcome = client.request('/api/internal/editorial/notifications/drain', {'dryRun': False})
                report['notificationDrain'] = outcome
                report['notificationsAccepted'] += int(outcome.get('sent', 0))
            except Exception as exc:
                report['notificationDrain'] = {'pending': True, 'reason': safe_reason(exc)}
                if isinstance(exc, ApiHttpError):
                    report['notificationDrain']['apiHttpError'] = exc.http_diagnostic
                report['blocked'] = True
        report['notificationsSent'] = report['notificationsAccepted'] > 0
        report["publicRequests"] = getattr(fetched, "requests", None)
        report["sourceEvidence"] = getattr(fetched, "records", [])
        report["completedAtUtc"] = datetime.now(timezone.utc).isoformat()
        write_json(output / "last-run.json", report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edition", help="YYYY-MM-DD; RDJ calendar day in Europe/Paris")
    parser.add_argument("--source", action="append", choices=list(SOURCES))
    parser.add_argument("--output", default="./var/editorial-worker")
    parser.add_argument("--api-base", default=os.environ.get("WINTIPS_EDITORIAL_API_BASE"))
    parser.add_argument('--translate', action='store_true', help='Generate and validate real English during a non-publishing preview')
    parser.add_argument('--translation-max-seconds', type=int, default=1200)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Default; no POST and no notifications")
    mode.add_argument("--publish", action="store_true", help="Explicit bilingual import; API notification policy applies")
    parser.add_argument("--minimum-lead-minutes", type=int, default=30)
    parser.add_argument("--max-requests", type=int, default=80)
    parser.add_argument("--max-seconds", type=int, default=240)
    parser.add_argument("--cache-ttl-seconds", type=int, default=600)
    args = parser.parse_args(argv)
    if not 1 <= args.max_requests <= 80 or not 10 <= args.max_seconds <= 600 or not 0 <= args.cache_ttl_seconds <= 3600 or not 30 <= args.translation_max_seconds <= 1800:
        parser.error("Request/time/cache budgets out of bounds")
    try:
        report = run(args)
        print(json.dumps({k: report[k] for k in ("editionDate", "mode", "published", "notificationsSent", "publicRequests")}, ensure_ascii=True))
        for row in report["sources"]:
            print(json.dumps({k: row[k] for k in ("source", "status", "itemCount", "imported")}, ensure_ascii=True))
        if report.get('deferred'):
            print(json.dumps({'status': 'deferred', **report['deferred']}, ensure_ascii=True))
        return 2 if report.get('blocked') else 0
    except Exception as exc:
        # Credentials and server response bodies are deliberately omitted.
        diagnostic = {'apiHttpError': exc.http_diagnostic} if isinstance(exc, ApiHttpError) else {}
        print(json.dumps({"status": "blocked", "errorType": type(exc).__name__,
                          "reason": str(exc)[:150], "notificationsSent": False, **diagnostic}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
