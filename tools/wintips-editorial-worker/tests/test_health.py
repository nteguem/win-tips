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


class ScopedHealthTests(unittest.TestCase):
    now = datetime(2026, 10, 23, 8, tzinfo=timezone.utc)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name)

    def write(self, scope, *, statuses=None, **changes):
        defaults = {'free': {'rdj_petit_journal': 'ready', 'rdj_turf_quinte': 'ready'},
                    'vip': {'wintips_daily_vip': 'ready'}}
        statuses = defaults[scope] if statuses is None else statuses
        report = {'editionDate': '2026-10-23', 'completedAtUtc': '2026-10-23T07:45:00Z',
                  'mode': 'publish', 'reportScope': scope, 'selectedSources': list(statuses),
                  'sources': [{'source': key, 'status': value} for key, value in statuses.items()],
                  **changes}
        Path(self.output, 'last-run-' + scope + '.json').write_text(json.dumps(report), 'utf-8')
        return report

    def inspect(self, **changes):
        return inspect(self.output, now=self.now, **changes)

    def test_free_and_vip_reports_are_both_required_and_exposed(self):
        self.write('free')
        self.write('vip')
        result = self.inspect()
        self.assertTrue(result['healthy'])
        self.assertEqual(set(result['reports']), {'free', 'vip'})
        self.assertEqual(set(result['sourceStatuses']),
                         {'rdj_petit_journal', 'rdj_turf_quinte', 'wintips_daily_vip'})

    def test_healthy_vip_never_hides_failed_quinte_even_when_legacy_looks_healthy(self):
        self.write('free', statuses={'rdj_petit_journal': 'ready', 'rdj_turf_quinte': 'source_incomplete'})
        vip = self.write('vip', completedAtUtc='2026-10-23T07:59:00Z')
        Path(self.output, 'last-run.json').write_text(json.dumps(vip), 'utf-8')
        result = self.inspect()
        self.assertFalse(result['healthy'])
        self.assertEqual(result['reason'], 'free_source_or_delivery_blocked')
        self.assertTrue(result['reports']['vip']['healthy'])
        self.assertEqual(result['sourceStatuses']['rdj_turf_quinte'], 'source_incomplete')

    def test_stale_free_is_not_hidden_by_recent_vip(self):
        self.write('free', completedAtUtc='2026-10-22T07:45:00Z')
        self.write('vip')
        self.assertEqual(self.inspect()['reason'], 'free_worker_report_stale')

    def test_empty_article_for_identified_edition_is_an_alert_while_absence_is_normal(self):
        self.write('free', statuses={'rdj_petit_journal': 'source_absent', 'rdj_turf_quinte': 'source_empty'})
        self.write('vip')
        self.assertEqual(self.inspect()['reason'], 'free_source_or_delivery_blocked')
        self.write('free', statuses={'rdj_petit_journal': 'source_absent', 'rdj_turf_quinte': 'source_absent'})
        self.assertTrue(self.inspect()['healthy'])

    def test_missing_free_is_not_replaced_with_legacy_or_vip_report(self):
        vip = self.write('vip')
        Path(self.output, 'last-run.json').write_text(json.dumps(vip), 'utf-8')
        self.assertEqual(self.inspect()['reason'], 'free_worker_report_unavailable')

    def test_free_success_does_not_hide_missing_vip_report(self):
        self.write('free')
        self.assertEqual(self.inspect()['reason'], 'vip_worker_report_unavailable')
        self.assertTrue(self.inspect(scope='free')['healthy'])

    def test_legacy_vip_only_file_cannot_claim_free_health(self):
        report = self.write('vip')
        Path(self.output, 'last-run-vip.json').unlink()
        Path(self.output, 'last-run.json').write_text(json.dumps(report), 'utf-8')
        self.assertEqual(self.inspect()['reason'], 'free_worker_report_missing')
        self.assertEqual(self.inspect(scope='free')['reason'], 'free_worker_report_missing')
        self.assertTrue(self.inspect(scope='vip')['healthy'])

    def test_explicit_vip_check_does_not_accept_legacy_free_report(self):
        report = self.write('free')
        Path(self.output, 'last-run-free.json').unlink()
        Path(self.output, 'last-run.json').write_text(json.dumps(report), 'utf-8')
        self.assertEqual(self.inspect(scope='vip')['reason'], 'vip_worker_report_missing')

    def test_missing_active_quinte_row_is_visible(self):
        self.write('free', statuses={'rdj_petit_journal': 'ready'},
                   selectedSources=['rdj_petit_journal', 'rdj_turf_quinte'])
        result = self.inspect(scope='free')
        self.assertFalse(result['healthy'])
        self.assertEqual(result['reports']['free']['missingSources'], ['rdj_turf_quinte'])

    def test_explicitly_inactive_server_source_is_not_a_false_failure(self):
        self.write('free', statuses={'rdj_petit_journal': 'source_absent'})
        self.assertTrue(self.inspect(scope='free')['healthy'])

    def test_all_sources_disabled_in_server_config_is_explicit_and_not_a_failure(self):
        self.write('free', statuses={})
        self.assertTrue(self.inspect(scope='free')['healthy'])

    def test_scoped_report_without_selected_sources_requires_default_coverage(self):
        self.write('free', statuses={'rdj_petit_journal': 'ready'}, selectedSources=None)
        result = self.inspect(scope='free')
        self.assertEqual(result['reports']['free']['missingSources'], ['rdj_turf_quinte'])

    def test_vip_only_report_cannot_be_relabelled_free(self):
        self.write('free', statuses={'wintips_daily_vip': 'ready'})
        self.assertEqual(self.inspect(scope='free')['reason'], 'free_worker_source_coverage_incomplete')

    def test_file_scope_mismatch_is_not_healthy(self):
        self.write('free', reportScope='vip')
        self.assertEqual(self.inspect(scope='free')['reason'], 'free_worker_report_scope_mismatch')

    def test_duplicate_rows_and_malformed_selection_are_rejected(self):
        cases = ({'selectedSources': 'rdj_turf_quinte'},
                 {'selectedSources': ['rdj_turf_quinte', 'rdj_turf_quinte']},
                 {'sources': [{'source': 'rdj_turf_quinte', 'status': 'ready'}] * 2})
        for changes in cases:
            with self.subTest(changes=changes):
                self.write('free', **changes)
                self.assertEqual(self.inspect(scope='free')['reason'], 'free_worker_source_coverage_invalid')

    def test_pending_free_delivery_remains_visible_alongside_successful_vip(self):
        self.write('free', notificationDrain={'pending': 1})
        self.write('vip')
        self.assertEqual(self.inspect()['reason'], 'free_source_or_delivery_blocked')

    def test_vip_delivery_review_does_not_hide_behind_free_success(self):
        self.write('free')
        self.write('vip', notificationDrain={'groups': [{'status': 'review_required'}]})
        self.assertEqual(self.inspect()['reason'], 'vip_review_required')

    def test_preview_scope_is_only_accepted_when_explicitly_requested(self):
        self.write('free', mode='dry_run')
        self.assertEqual(self.inspect(scope='free')['reason'], 'free_publication_not_armed')
        self.assertTrue(self.inspect(scope='free', require_publish=False)['healthy'])

    def test_midnight_grace_remains_valid_for_each_worker(self):
        self.write('free', completedAtUtc='2026-10-23T22:10:00Z')
        self.write('vip', completedAtUtc='2026-10-23T22:10:00Z')
        result = inspect(self.output, now=datetime(2026, 10, 23, 22, 15, tzinfo=timezone.utc))
        self.assertTrue(result['healthy'])

    def test_invalid_scope_is_not_silently_treated_as_all(self):
        with self.assertRaisesRegex(ValueError, 'unknown_health_scope'):
            self.inspect(scope='other')
