"""Operational status must distinguish partial delivery from any publication."""
from contextlib import redirect_stdout
import io
import json
import unittest
from unittest.mock import patch

from editorial_worker import runner


class RunSummaryTests(unittest.TestCase):
    def test_source_absence_and_closed_unpublished_window_are_completed_checks(self):
        report = {'mode': 'publish', 'published': False, 'sources': [
            {'source': 'rdj_petit_journal', 'status': 'source_absent', 'itemCount': 0},
            {'source': 'rdj_turf_quinte', 'status': 'outside_publication_window', 'itemCount': 0}]}
        self.assertEqual(runner.run_summary(report), {'status': 'complete', 'blocked': False,
            'publishedSources': [], 'failedSources': []})
        self.assertIs(report['published'], False)

    def test_confirmed_existing_publication_is_complete_without_import_or_notification(self):
        report = {'mode': 'publish', 'published': False, 'notificationsSent': False, 'sources': [
            {'source': 'rdj_petit_journal', 'status': 'outside_publication_window', 'itemCount': 0,
             'imported': False, 'publishedSourceWindow': {'inventoryMatched': True}}]}
        summary = runner.run_summary(report)
        self.assertEqual(summary['status'], 'complete')
        self.assertEqual(summary['publishedSources'], ['rdj_petit_journal'])
        self.assertIs(report['published'], False)
        self.assertIs(report['notificationsSent'], False)

    def test_prepared_content_never_masquerades_as_delivered_after_cleanup_failure(self):
        report = {'mode': 'publish', 'blocked': True, 'runtimeCleanupError': 'fixture', 'sources': [
            {'source': 'rdj_petit_journal', 'status': 'ready', 'itemCount': 2, 'imported': False}]}
        summary = runner.run_summary(report)
        self.assertEqual(summary['status'], 'blocked')
        self.assertEqual(summary['failedSources'], ['rdj_petit_journal'])
        self.assertEqual(summary['publishedSources'], [])

    def test_preview_readiness_is_complete_without_claiming_publication(self):
        summary = runner.run_summary({'mode': 'dry_run', 'sources': [
            {'source': 'rdj_petit_journal', 'status': 'ready', 'itemCount': 2, 'imported': False}]})
        self.assertEqual(summary, {'status': 'complete', 'blocked': False,
            'publishedSources': [], 'failedSources': []})

    def test_pending_notifications_remain_partial_after_successful_import(self):
        summary = runner.run_summary({'mode': 'publish', 'blocked': True, 'sources': [
            {'source': 'rdj_petit_journal', 'status': 'ready', 'itemCount': 2, 'imported': True}]})
        self.assertEqual(summary['status'], 'partial')
        self.assertEqual(summary['publishedSources'], ['rdj_petit_journal'])
        self.assertEqual(summary['failedSources'], [])

    def test_cli_exposes_partial_status_and_returns_failure_even_if_a_race_was_imported(self):
        report = {'editionDate': '2026-11-08', 'mode': 'publish', 'published': True,
                  'notificationsSent': False, 'publicRequests': 3, 'blocked': True,
                  'sources': [
                      {'source': 'rdj_petit_journal', 'status': 'source_incomplete', 'itemCount': 0, 'imported': False},
                      {'source': 'rdj_turf_quinte', 'status': 'ready', 'itemCount': 1, 'imported': True}]}
        report.update(runner.run_summary(report))
        output = io.StringIO()
        with patch.object(runner, 'run', return_value=report), redirect_stdout(output):
            code = runner.main([])
        summary = json.loads(output.getvalue().splitlines()[0])
        self.assertEqual(code, 2)
        self.assertEqual(summary['status'], 'partial')
        self.assertIs(summary['published'], True)
        self.assertIs(summary['blocked'], True)
        self.assertEqual(summary['failedSources'], ['rdj_petit_journal'])
        self.assertEqual(summary['publishedSources'], ['rdj_turf_quinte'])


if __name__ == '__main__':
    unittest.main()
