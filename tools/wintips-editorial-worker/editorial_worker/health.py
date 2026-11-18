"""Read-only monitoring of FREE and VIP workers. No network, model or API calls."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
from .calendar import edition_day, paris_timezone


VIP_SOURCE = 'wintips_daily_vip'
FREE_SOURCES = {'rdj_petit_journal', 'rdj_turf_quinte'}


def _inspect_report(path, *, now, max_age_seconds, require_publish, scope=None):
    try:
        if path.is_symlink() or path.stat().st_size > 4_000_000:
            raise ValueError('invalid_report_file')
        report = json.loads(path.read_text('utf-8'))
        completed = datetime.fromisoformat(report['completedAtUtc'].replace('Z', '+00:00'))
        if completed.tzinfo is None:
            raise ValueError('clock_without_timezone')
        age = (now - completed).total_seconds()
        if age < -60 or age > max_age_seconds:
            return {'healthy': False, 'reason': 'worker_report_stale', 'ageSeconds': round(age)}
        if require_publish and report.get('mode') != 'publish':
            return {'healthy': False, 'reason': 'publication_not_armed'}
        current_day = edition_day(now)
        local_clock = now.astimezone(paris_timezone())
        midnight_grace = (local_clock.hour == 0 or (local_clock.hour == 1 and local_clock.minute < 30)) and report.get('editionDate') == current_day.fromordinal(current_day.toordinal() - 1).isoformat()
        if report.get('editionDate') != current_day.isoformat() and not midnight_grace:
            return {'healthy': False, 'reason': 'edition_not_current'}
        rows = report.get('sources', [])
        source_keys = [row.get('source') for row in rows]
        source_statuses = {row.get('source'): row.get('status') for row in rows}
        if scope:
            if report.get('reportScope') != scope:
                return {'healthy': False, 'reason': 'worker_report_scope_mismatch'}
            if any(not isinstance(key, str) or not key for key in source_keys) or len(set(source_keys)) != len(source_keys):
                return {'healthy': False, 'reason': 'worker_source_coverage_invalid'}
            # selectedSources is the active server configuration, after CLI
            # selection. Inactive sources must not create false alerts.
            selected = report.get('selectedSources')
            if selected is not None:
                if (not isinstance(selected, list) or
                        any(not isinstance(key, str) or not key for key in selected) or
                        len(set(selected)) != len(selected)):
                    return {'healthy': False, 'reason': 'worker_source_coverage_invalid'}
                expected = set(selected)
                missing = expected - set(source_keys)
                unexpected = set(source_keys) - expected
            else:
                expected = {VIP_SOURCE} if scope == 'vip' else FREE_SOURCES
                missing = expected - set(source_keys)
                unexpected = set()
            wrong_scope = ((scope == 'vip' and any(key != VIP_SOURCE for key in expected)) or
                           (scope == 'free' and expected == {VIP_SOURCE}))
            if missing or unexpected or wrong_scope:
                return {'healthy': False, 'reason': 'worker_source_coverage_incomplete',
                        'missingSources': sorted(missing), 'unexpectedSources': sorted(unexpected),
                        'sourceStatuses': source_statuses}
        blocked = report.get('blocked') is True or any(row.get('status') in {'source_empty', 'source_incomplete', 'source_blocked', 'translation_blocked', 'import_blocked'} for row in rows)
        deliveries = [report.get('notificationDrain', {})] + [row.get('apiResult', {}).get('notifications', {}) for row in rows]
        review = any(group.get('status') == 'review_required' for delivery in deliveries for group in delivery.get('groups', []))
        blocked = blocked or any(delivery.get('pending') for delivery in deliveries)
        return {'healthy': not blocked and not review, 'reason': 'review_required' if review else 'source_or_delivery_blocked' if blocked else 'ok',
            'editionDate': report.get('editionDate'), 'currentEditionDate': current_day.isoformat(),
            'ageSeconds': round(age), 'mode': report.get('mode'), 'sourceStatuses': source_statuses}
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return {'healthy': False, 'reason': 'worker_report_unavailable'}


def inspect(output, *, now=None, max_age_seconds=10800, require_publish=True, scope='all'):
    if scope not in {'all', 'free', 'vip'}:
        raise ValueError('unknown_health_scope')
    now = now or datetime.now(timezone.utc)
    output = Path(output)
    paths = {key: output / ('last-run-' + key + '.json') for key in ('free', 'vip')}
    kwargs = {'now': now, 'max_age_seconds': max_age_seconds, 'require_publish': require_publish}
    # Once either separated report exists, never fall back to a legacy file or
    # to the most recent service: a healthy VIP cannot hide a failed FREE run.
    if any(path.exists() or path.is_symlink() for path in paths.values()):
        scopes = ('free', 'vip') if scope == 'all' else (scope,)
        results = {key: _inspect_report(paths[key], scope=key, **kwargs) for key in scopes}
        failures = [key for key in scopes if not results[key]['healthy']]
        return {'healthy': not failures,
                'reason': failures[0] + '_' + results[failures[0]]['reason'] if failures else 'ok',
                'scope': scope, 'reports': results,
                'sourceStatuses': {source: status for result in results.values()
                                   for source, status in result.get('sourceStatuses', {}).items()}}
    # Backwards compatibility before the first scoped run. Refuse the exact
    # historical collision (a last-run containing VIP only) for FREE/all.
    legacy = _inspect_report(output / 'last-run.json', **kwargs)
    keys = set(legacy.get('sourceStatuses', {})) - {None}
    if keys == {VIP_SOURCE} and scope != 'vip':
        return {**legacy, 'healthy': False, 'reason': 'free_worker_report_missing', 'scope': scope}
    if scope == 'vip' and keys != {VIP_SOURCE}:
        return {**legacy, 'healthy': False, 'reason': 'vip_worker_report_missing', 'scope': scope}
    return {**legacy, 'scope': scope}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='/var/lib/wintips-editorial-worker')
    parser.add_argument('--scope', choices=('all', 'free', 'vip'), default='all',
                        help='Inspect both publication services, or explicitly one service')
    parser.add_argument('--allow-preview', action='store_true', help='Explicitly inspect an unarmed preview rather than publication readiness')
    args = parser.parse_args(argv)
    result = inspect(args.output, require_publish=not args.allow_preview, scope=args.scope)
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result['healthy'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
