from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from editorial_worker.health import inspect


class HealthTests(unittest.TestCase):
    now = datetime(2026, 10, 23, 8, tzinfo=timezone.utc)
    def check(self, report):
        report = {'editionDate': '2026-10-23', 'mode': 'publish', **report}
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'last-run.json').write_text(json.dumps(report), 'utf-8')
            return inspect(directory, now=self.now)

    def test_missing_source_is_healthy_and_never_requests_publication(self):
        result = self.check({'completedAtUtc': '2026-10-23T07:45:00Z', 'editionDate': '2026-10-23', 'sources': [{'source': 'rdj_petit_journal', 'status': 'source_absent'}]})
        self.assertTrue(result['healthy'])

    def test_translation_blocked_is_visible_to_monitoring(self):
        result = self.check({'completedAtUtc': '2026-10-23T07:45:00Z', 'sources': [{'source': 'test', 'status': 'translation_blocked'}]})
        self.assertFalse(result['healthy'])

    def test_stale_report_is_not_healthy(self):
        self.assertEqual(self.check({'completedAtUtc': '2026-10-22T07:45:00Z'})['reason'], 'worker_report_stale')

    def test_ambiguous_delivery_requires_review(self):
        self.assertEqual(self.check({'completedAtUtc': '2026-10-23T07:45:00Z', 'notificationDrain': {'groups': [{'status': 'review_required'}]}})['reason'], 'review_required')

    def test_preview_does_not_masquerade_as_armed_publication(self):
        self.assertEqual(self.check({'completedAtUtc': '2026-10-23T07:45:00Z', 'mode': 'dry_run'})['reason'], 'publication_not_armed')

    def test_recent_report_for_previous_edition_is_not_sufficient(self):
        self.assertEqual(self.check({'completedAtUtc': '2026-10-23T07:45:00Z', 'editionDate': '2026-10-22'})['reason'], 'edition_not_current')

    def test_ambiguous_import_delivery_is_visible_even_before_later_drain(self):
        self.assertEqual(self.check({'completedAtUtc': '2026-10-23T07:45:00Z', 'sources': [{'apiResult': {'notifications': {'groups': [{'status': 'review_required'}]}}}]})['reason'], 'review_required')

    def test_remaining_retry_backlog_is_visible(self):
        self.assertFalse(self.check({'completedAtUtc': '2026-10-23T07:45:00Z', 'notificationDrain': {'pending': 3}})['healthy'])
