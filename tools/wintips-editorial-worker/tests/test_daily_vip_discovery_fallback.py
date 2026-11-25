"""Publisher index failures never hide independently verified event links."""
from datetime import datetime, timezone
from decimal import Decimal
import time
import unittest
from unittest.mock import patch

from editorial_worker import daily_vip as d


NOW = datetime(2026, 11, 19, 9, tzinfo=timezone.utc)
LINK = 'https://www.sportytrader.com/pronostics/first-fixture-388053/'


class Fetcher:
    def __init__(self, primary, fallback):
        self.rows = {d.INDEX_URL: primary, d.SOURCE_URL: fallback}
        self.calls = []

    def get(self, url):
        self.calls.append(url)
        status, body = self.rows[url]
        return {'status': status, 'body': body, 'saved': NOW.timestamp(), 'final_url': url}


class DiscoveryFallbackTests(unittest.TestCase):
    def pool_fetcher(self, primary, fallback, *, maximum=40, fallback_status=200):
        class PoolFetcher:
            max_requests = maximum
            max_seconds = 240
            timeout = 20

            def __init__(self):
                self.requests, self.calls, self.started = 0, [], time.monotonic()

            def get(self, url):
                if self.requests >= self.max_requests:
                    raise AssertionError('The optional fallback must respect the global request budget')
                self.requests += 1
                self.calls.append(url)
                status, body = 200, ''
                if url in {d.INDEX_URL, d.SOURCE_URL}:
                    links = primary if url == d.INDEX_URL else fallback
                    body = ''.join('<a href="' + link + '">Fixture</a>' for link in links)
                    if url == d.SOURCE_URL:
                        status = fallback_status
                return {'status': status, 'body': body, 'saved': NOW.timestamp(), 'final_url': url}
        return PoolFetcher()

    def pool_prediction(self, entry, url, *args):
        identity = d.PREDICTION_PATH.fullmatch(d.urlsplit(url).path)[1]
        return {'sourceId': 'sp' + identity, 'sourceUrl': url, 'editionDate': '2026-11-19',
                'teams': {'home': {'name': 'Home ' + identity}, 'away': {'name': 'Away ' + identity}},
                'sport': {'key': 'football', 'name': 'Football'}, 'competition': {},
                'startsAtUtc': '2026-11-19T17:00:00Z',
                'pick': {'betType': 'match_winner', 'side': '1',
                         'label': {'fr': 'Victoire domicile', 'en': 'Home to win'},
                         'raw': 'Victoire domicile'},
                'oddsUrl': url.replace('/pronostics/', '/cotes/')}

    def run_pool(self, fetcher, quotes=None, *, reject_all=False):
        quotes = quotes or {}
        def prices(entry, detail, *args):
            return {'Unibet': Decimal(quotes.get(detail['sourceUrl'], '2'))}, d.utc_text(NOW)
        with patch.object(d, 'prediction', side_effect=d.DailyVipError(
                'daily_vip_recommendation_identity_conflict') if reject_all else self.pool_prediction), \
                patch.object(d, 'prices', side_effect=prices):
            return d.collect('2026-11-19', fetcher, now=NOW)

    def test_partial_daily_index_is_completed_once_without_reloading_shared_events(self):
        second = LINK.replace('388053', '388054')
        fetcher = self.pool_fetcher([LINK], [LINK, second, second])
        result = self.run_pool(fetcher, {LINK: '1.6'})
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['items'][0]['selection']['totalOdds'], 3.2)
        self.assertEqual(fetcher.calls.count(LINK), 1)
        self.assertEqual(fetcher.calls.count(second), 1)
        self.assertEqual(fetcher.calls.count(d.SOURCE_URL), 1)
        audit = result['dailyVipAudit']
        self.assertEqual(audit['discoveryUrls'], [d.INDEX_URL, d.SOURCE_URL])
        self.assertEqual((audit['discoveredCount'], audit['attemptedCandidateCount'],
                          audit['verifiedCandidateCount']), (2, 2, 2))

    def test_valid_primary_coupon_does_not_fetch_a_second_index(self):
        second = LINK.replace('388053', '388054')
        fetcher = self.pool_fetcher([LINK, second], [])
        result = self.run_pool(fetcher, {LINK: '1.6'})
        self.assertEqual(result['status'], 'ready')
        self.assertNotIn(d.SOURCE_URL, fetcher.calls)
        self.assertEqual(result['dailyVipAudit']['discoveryUrls'], [d.INDEX_URL])

    def test_general_index_failure_preserves_independently_verified_candidates(self):
        fetcher = self.pool_fetcher([LINK], [], fallback_status=503)
        result = self.run_pool(fetcher)
        self.assertEqual(result['status'], 'no_eligible_combination')
        self.assertEqual(result['dailyVipAudit']['verifiedCandidateCount'], 1)
        self.assertEqual(result['issues'], [{'url': d.SOURCE_URL, 'code': 'daily_vip_source_http_503'}])

    def test_failed_optional_index_does_not_discard_deferred_primary_events(self):
        second, third = LINK.replace('388053', '388054'), LINK.replace('388053', '388055')
        fetcher = self.pool_fetcher([LINK, second, third], [], maximum=8, fallback_status=503)
        result = self.run_pool(fetcher, {LINK: '1.2', second: '1.2', third: '2.6'})
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['items'][0]['selection']['totalOdds'], 3.12)
        self.assertEqual(fetcher.calls[-2:], [third, third.replace('/pronostics/', '/cotes/')])
        self.assertEqual(fetcher.requests, 8)

    def test_insufficient_remaining_budget_does_not_start_optional_index_or_refuse_a_get(self):
        fetcher = self.pool_fetcher([LINK], [], maximum=4)
        result = self.run_pool(fetcher)
        self.assertEqual(result['status'], 'no_eligible_combination')
        self.assertEqual(fetcher.requests, 3)
        self.assertNotIn(d.SOURCE_URL, fetcher.calls)
        self.assertEqual(result['issues'], [])

    def test_optional_index_is_skipped_when_time_cannot_cover_index_and_event_pair(self):
        fetcher = self.pool_fetcher([LINK], [])
        fetcher.started -= 190
        result = self.run_pool(fetcher)
        self.assertEqual(result['dailyVipAudit']['verifiedCandidateCount'], 1)
        self.assertNotIn(d.SOURCE_URL, fetcher.calls)

    def test_reserved_requests_let_a_full_daily_pool_try_a_new_general_event(self):
        primary = [LINK.replace('388053', str(388053 + index)) for index in range(24)]
        extra = LINK.replace('388053', '399999')
        # Put the new event first in the general index's bounded discovery set.
        fetcher = self.pool_fetcher(primary, [extra] + primary)
        result = self.run_pool(fetcher)
        self.assertIn(extra, fetcher.calls)
        self.assertEqual(fetcher.requests, 40)
        self.assertEqual(result['dailyVipAudit']['attemptedCandidateCount'], 19)
        self.assertLessEqual(result['dailyVipAudit']['attemptedCandidateCount'], d.MAX_CANDIDATES)

    def test_global_attempt_cap_applies_across_both_indexes_even_when_parsing_fails_early(self):
        primary = [LINK.replace('388053', str(388053 + index)) for index in range(24)]
        fallback = [LINK.replace('388053', str(399000 + index)) for index in range(24)]
        fetcher = self.pool_fetcher(primary, fallback)
        result = self.run_pool(fetcher, reject_all=True)
        audit = result['dailyVipAudit']
        self.assertEqual(audit['discoveredCount'], 48)
        self.assertEqual(audit['attemptedCandidateCount'], 24)
        self.assertEqual(audit['verifiedCandidateCount'], 0)
        self.assertEqual(fetcher.requests, 26)
        self.assertEqual(result['status'], 'candidates_unusable')

    def test_a_general_index_already_used_for_discovery_is_never_requested_twice(self):
        fetcher = self.pool_fetcher([], [LINK])
        result = self.run_pool(fetcher)
        self.assertEqual(result['status'], 'no_eligible_combination')
        self.assertEqual(fetcher.calls.count(d.SOURCE_URL), 1)
        self.assertEqual(result['dailyVipAudit']['discoveryUrls'], [d.INDEX_URL, d.SOURCE_URL])

    def test_remaining_request_budget_preserves_a_verified_combination(self):
        urls = [LINK, LINK.replace('388053', '388054'), LINK.replace('388053', '388055')]
        class LimitedFetcher:
            max_requests = 4
            requests = 0
            def get(self, url):
                self.requests += 1
                if self.requests > self.max_requests:
                    raise AssertionError('An optional next candidate must not exhaust the budget')
                return url
        def prediction(url, *args):
            index = urls.index(url)
            return {'sourceId': 'sp' + str(388053 + index), 'sourceUrl': url,
                'editionDate': '2026-11-19',
                'teams': {'home': {'name': 'Home ' + str(index)}, 'away': {'name': 'Away ' + str(index)}},
                'sport': {'key': 'tennis' if index == 0 else 'football', 'name': 'Tennis' if index == 0 else 'Football'}, 'competition': {},
                'startsAtUtc': '2026-11-19T17:00:00Z',
                'pick': {'betType': 'correct_score' if index == 0 else 'match_winner',
                    'label': {'fr': 'Victoire en 2 sets' if index == 0 else 'Victoire domicile',
                              'en': 'Home to win in straight sets' if index == 0 else 'Home to win'},
                    'raw': 'Victoire en 2 sets' if index == 0 else 'Victoire domicile'},
                'oddsUrl': url.replace('/pronostics/', '/cotes/')}
        quotes = iter([Decimal('1.5'), Decimal('2.1')])
        with patch.object(d, 'discover_candidates', return_value=(urls, d.INDEX_URL, [])), \
                patch.object(d, 'prediction', side_effect=prediction), \
                patch.object(d, 'prices', side_effect=lambda *args: ({'Unibet': next(quotes)}, d.utc_text(NOW))):
            result = d.collect('2026-11-19', LimitedFetcher(), now=NOW)
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['items'][0]['selection']['totalOdds'], 3.15)
        self.assertEqual(len(result['items'][0]['legs']), 2)
        self.assertEqual(result['issues'], [{'code': 'daily_vip_discovery_budget_reached'}])
        self.assertEqual(result['items'][0]['legs'][0]['selection']['betType'], 'correct_score')
        result['items'][0]['legs'][0]['sport']['key'] = 'football'
        with self.assertRaisesRegex(d.DailyVipError, 'market_sport_conflict'):
            d.validate(result['items'][0], '2026-11-19', NOW)

    def test_valid_daily_index_does_not_add_requests(self):
        fetcher = Fetcher((200, '<a href="' + LINK + '">Fixture</a>'), (500, ''))
        links, url, issues = d.discover_candidates(fetcher, lambda: NOW)
        self.assertEqual(links, [LINK])
        self.assertEqual(url, d.INDEX_URL)
        self.assertEqual(issues, [])
        self.assertEqual(fetcher.calls, [d.INDEX_URL])

    def test_daily_http_failure_or_empty_index_uses_the_same_publishers_general_index(self):
        for primary in ((503, ''), (200, '<p>Not yet updated</p>')):
            fetcher = Fetcher(primary, (200, '<a href="' + LINK + '">Fixture</a>'))
            links, url, _ = d.discover_candidates(fetcher, lambda: NOW)
            self.assertEqual(links, [LINK])
            self.assertEqual(url, d.SOURCE_URL)
            self.assertEqual(fetcher.calls, [d.INDEX_URL, d.SOURCE_URL])

    def test_two_verified_empty_indexes_are_absence_not_a_fabricated_coupon(self):
        self.assertEqual(d.discover_candidates(Fetcher((200, ''), (200, '')), lambda: NOW)[0], [])

    def test_two_http_failures_are_not_misreported_as_publisher_absence(self):
        with self.assertRaisesRegex(d.DailyVipError, 'discovery_unavailable'):
            d.discover_candidates(Fetcher((503, ''), (404, '')), lambda: NOW)

    def test_extra_candidates_stay_bounded_and_sports_are_interleaved(self):
        groups = []
        for sport in ('football', 'tennis', 'basketball'):
            links = ''.join('<a href="https://www.sportytrader.com/pronostics/'
                + sport + '-fixture-' + str(100000 + index) + '/">Event</a>' for index in range(30))
            groups.append('<div class="pronostics-wrapper">' + links + '</div>')
        links = d.discovery(d.html.Document(''.join(groups)).root)
        self.assertEqual(len(links), 24)
        self.assertTrue(all(sport in links[index] for index, sport in enumerate(('football','tennis','basketball'))))


if __name__ == '__main__':
    unittest.main()
