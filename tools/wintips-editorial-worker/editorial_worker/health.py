"""Read-only monitoring of the hourly worker. No network, model or API calls."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
from .calendar import edition_day, paris_timezone


def inspect(output, *, now=None, max_age_seconds=10800, require_publish=True):
    now = now or datetime.now(timezone.utc)
    path = Path(output) / 'last-run.json'
    try:
        if path.stat().st_size > 4_000_000:
            raise ValueError('oversized_report')
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
        blocked = report.get('blocked') is True or any(row.get('status') in {'source_incomplete', 'source_blocked', 'translation_blocked', 'import_blocked'} for row in report.get('sources', []))
        deliveries = [report.get('notificationDrain', {})] + [row.get('apiResult', {}).get('notifications', {}) for row in report.get('sources', [])]
        review = any(group.get('status') == 'review_required' for delivery in deliveries for group in delivery.get('groups', []))
        blocked = blocked or any(delivery.get('pending') for delivery in deliveries)
        return {'healthy': not blocked and not review, 'reason': 'review_required' if review else 'source_or_delivery_blocked' if blocked else 'ok',
            'editionDate': report.get('editionDate'), 'currentEditionDate': edition_day(now).isoformat(),
            'ageSeconds': round(age), 'mode': report.get('mode'),
            'sourceStatuses': {row.get('source'): row.get('status') for row in report.get('sources', [])}}
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return {'healthy': False, 'reason': 'worker_report_unavailable'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='/var/lib/wintips-editorial-worker')
    parser.add_argument('--allow-preview', action='store_true', help='Explicitly inspect an unarmed preview rather than publication readiness')
    args = parser.parse_args(argv)
    result = inspect(args.output, require_publish=not args.allow_preview)
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result['healthy'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
