"""Publisher index failures never hide independently verified event links."""
from datetime import datetime, timezone
from decimal import Decimal
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
