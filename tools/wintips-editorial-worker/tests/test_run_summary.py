"""Operational status must distinguish partial delivery from any publication."""
from contextlib import redirect_stdout
import io
import json
import unittest
from unittest.mock import patch

from editorial_worker import runner


class RunSummaryTests(unittest.TestCase):
    def vip_report(self, *, failed=12, discovered=17, code='daily_vip_recommendation_identity_conflict', **changes):
        row = {'source': 'wintips_daily_vip', 'status': 'no_eligible_combination',
               'itemCount': 0, 'imported': False,
               'dailyVipAudit': {'discoveredCount': discovered, 'verifiedCandidateCount': 2},
               'issues': [{'url': f'https://www.sportytrader.com/pronostics/event-{index}-123456/',
                           'code': code} for index in range(failed)], **changes}
        return {'mode': 'publish', 'sources': [row]}

    def test_vip_parser_failure_cannot_be_a_complete_successful_check(self):
        result = runner.run_summary(self.vip_report())
        self.assertEqual(result, {'status': 'blocked', 'blocked': True,
                                 'publishedSources': [], 'failedSources': ['wintips_daily_vip']})

    def test_unusable_vip_candidates_with_broken_structure_are_visible(self):
        result = runner.run_summary(self.vip_report(status='candidates_unusable'))
        self.assertTrue(result['blocked'])

    def test_vip_fetch_failures_are_not_a_complete_successful_check(self):
        for code in ('daily_vip_source_http_503', 'daily_vip_source_http_429',
                     'daily_vip_candidate_unavailable', 'daily_vip_source_stale',
                     'unsupported_content_type'):
            with self.subTest(code=code):
                result = runner.run_summary(self.vip_report(failed=17, code=code))
                self.assertEqual(result, {'status': 'blocked', 'blocked': True,
                    'publishedSources': [], 'failedSources': ['wintips_daily_vip']})

    def test_mixed_vip_fetch_and_parsing_failures_remain_visible(self):
        report = self.vip_report(failed=10)
        for issue in report['sources'][0]['issues'][6:]:
            issue['code'] = 'daily_vip_source_http_503'
        self.assertTrue(runner.run_summary(report)['blocked'])

    def test_missing_pages_or_a_minority_of_fetch_failures_remain_a_normal_wait(self):
        self.assertFalse(runner.run_summary(self.vip_report(code='daily_vip_source_http_404'))['blocked'])
        self.assertFalse(runner.run_summary(self.vip_report(failed=8, code='daily_vip_source_http_503'))['blocked'])

    def test_vip_without_a_matching_priced_combination_remains_a_normal_wait(self):
        for code in ('daily_vip_exact_market_price_unavailable', 'daily_vip_recommended_market_unsupported',
                     'daily_vip_event_started_or_too_close', 'daily_vip_wrong_edition',
                     'daily_vip_sport_unsupported', 'daily_vip_supported_bookmaker_missing'):
            with self.subTest(code=code):
                result = runner.run_summary(self.vip_report(code=code))
                self.assertEqual(result['status'], 'complete')
                self.assertFalse(result['blocked'])

    def test_vip_is_not_degraded_by_a_minority_of_rejected_pages(self):
        self.assertFalse(runner.run_summary(self.vip_report(failed=8))['blocked'])
        self.assertFalse(runner.run_summary(self.vip_report(failed=1, discovered=2))['blocked'])

    def test_repeated_errors_for_one_page_do_not_inflate_failure_rate(self):
        report = self.vip_report(failed=1)
        report['sources'][0]['issues'] *= 30
        self.assertFalse(runner.run_summary(report)['blocked'])

    def test_vip_published_or_ready_coupon_is_not_hidden_by_other_source_rejections(self):
        for changes in ({'status': 'ready', 'itemCount': 1, 'imported': True},
                        {'status': 'published_snapshot_preserved', 'publishedSnapshot': {'verified': True}}):
            with self.subTest(changes=changes):
                result = runner.run_summary(self.vip_report(**changes))
                self.assertFalse(result['blocked'])
                self.assertEqual(result['publishedSources'], ['wintips_daily_vip'])

    def test_no_structural_failure_is_inferred_without_a_valid_discovery_count(self):
        for count in (None, 0, True, '17'):
            with self.subTest(count=count):
                self.assertFalse(runner.run_summary(self.vip_report(discovered=count))['blocked'])

    def test_cli_reports_vip_parsing_failure_without_triggering_collection_or_delivery(self):
        report = {'editionDate': '2026-11-25', 'published': False, 'notificationsSent': False,
                  'publicRequests': 23, **self.vip_report()}
        report.update(runner.run_summary(report))
        output = io.StringIO()
        with patch.object(runner, 'run', return_value=report), redirect_stdout(output):
            code = runner.main([])
        summary = json.loads(output.getvalue().splitlines()[0])
        self.assertEqual(code, 2)
        self.assertTrue(summary['blocked'])
        self.assertEqual(summary['failedSources'], ['wintips_daily_vip'])
        self.assertFalse(summary['notificationsSent'])

    def test_dated_source_without_editorial_text_is_a_visible_failure(self):
        result = runner.run_summary({'mode': 'publish', 'sources': [
            {'source': 'rdj_turf_quinte', 'status': 'source_empty', 'itemCount': 0, 'imported': False}]})
        self.assertTrue(result['blocked'])
        self.assertEqual(result['failedSources'], ['rdj_turf_quinte'])

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
