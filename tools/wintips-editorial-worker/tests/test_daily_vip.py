"""Real SSR fragments + negative cases for the daily VIP adapter."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import shutil
import subprocess
import unittest
from unittest.mock import patch

from editorial_worker import daily_vip as d
from editorial_worker import runner
from editorial_worker.http import PublicFetcher, public_url, FetchError
from editorial_worker.vendor.rdj_collector import Document

NOW = datetime(2026, 11, 17, 11, 0, tzinfo=timezone.utc)
DAY = '2026-11-17'
FIXTURES = Path(__file__).parent / 'fixtures' / 'daily-vip'
ZVEREV = 'https://www.sportytrader.com/pronostics/alexander-zverev-ben-shelton-388169/'
DENMARK = 'https://www.sportytrader.com/pronostics/danemark-norvege-387882/'


def entry(name, url):
    return {'url': url, 'final_url': url, 'status': 200, 'saved': NOW.timestamp(),
            'body': (FIXTURES / (name + '.html')).read_text('utf-8')}


def candidate(name='denmark', url=DENMARK):
    detail = d.prediction(entry(name + '-prediction', url), url, DAY, NOW)
    prices, observed = d.prices(entry(name + '-odds', detail['oddsUrl']), detail, NOW)
    detail.update(prices=prices, observedAtUtc=observed)
    return detail


def test_coupon():
    # Synthetic third event is for pure arithmetic validation, not a published
    # prediction. Real source discovery is exercised separately below.
    first, second = candidate('zverev', ZVEREV), candidate()
    third = deepcopy(second)
    third.update(sourceId='sp999999', sourceUrl='https://www.sportytrader.com/pronostics/test-third-999999/',
                 oddsUrl='https://www.sportytrader.com/cotes/test-third-999999/',
                 teams={'home': {'name': 'Third home'}, 'away': {'name': 'Third away'}},
                 prices={'Unibet': Decimal('1.62')})
    return d.compose(d.choose([first, second, third]), DAY)


class DailyVipTests(unittest.TestCase):
    def test_real_editorial_recommendation_beats_conflicting_automatic_prediction(self):
        detail = candidate()
        # Its automatic table tips Norway at2.33, but its author recommends
        # over2.5. Exact UNDER_OVER_2_5 row is1.38 Unibet, neverNorway2.30.
        self.assertEqual(detail['pick']['betType'], 'over_under_goals')
        self.assertEqual(detail['pick']['side'], '+2.5')
        self.assertEqual(detail['prices']['Unibet'], Decimal('1.38'))
        self.assertEqual(detail['startsAtUtc'], '2026-11-17T19:45:00Z')
        self.assertTrue(detail['teams']['away']['logo'].startswith('https://static.sportytrader.com/'))

    def test_real_tennis_winner_has_named_bookmaker_not_automatic_best_price(self):
        detail = candidate('zverev', ZVEREV)
        self.assertEqual(detail['pick']['label']['en'], 'Alexander Zverev to win')
        self.assertEqual(detail['prices']['Unibet'], Decimal('1.40'))
        self.assertEqual(detail['prices']['PMU Play'], Decimal('1.45'))

    def test_competition_geography_is_proven_by_its_breadcrumb_not_its_teams(self):
        self.assertEqual(candidate()['competition'], {
            'name': 'Ligue des Nations', 'country': 'International', 'scope': 'international'})
        # Player portraits and German / US flags do not prove where a tournament
        # takes place. Its actual tournament name remains available by itself.
        self.assertEqual(candidate('zverev', ZVEREV)['competition'], {'name': 'ATP Finals'})
        source = entry('denmark-prediction', DENMARK)
        source['body'] = source['body'].replace('/football/europe/ligue-des-nations-81218/',
            '/football/france/ligue-1-4/').replace('Ligue des Nations', 'Ligue 1')
        domestic = d.prediction(source, DENMARK, DAY, NOW)
        self.assertEqual(domestic['competition'], {
            'name': 'Ligue 1', 'country': 'France', 'countryCode': 'FR', 'scope': 'national'})
        # These are deliberately Danish/Norwegian participants: the metadata
        # must come from the competition URL, not a home participant shortcut.
        self.assertEqual(domestic['teams']['home']['name'], 'Danemark')

    def test_international_scope_never_replaces_the_competition_name(self):
        for region, name in [('afrique', "Coupe d’Afrique des Nations"),
                             ('europe', 'Ligue des Nations'), ('international', 'Coupe du monde')]:
            source = entry('denmark-prediction', DENMARK)
            source['body'] = source['body'].replace('/football/europe/ligue-des-nations-81218/',
                f'/football/{region}/competition-81218/').replace('Ligue des Nations', name)
            detail = d.prediction(source, DENMARK, DAY, NOW)
            self.assertEqual(detail['competition'], {
                'name': name, 'country': 'International', 'scope': 'international'})

    def test_missing_unknown_or_untrusted_geography_does_not_block_a_proven_event(self):
        for path in ['/pronostics/football/unidentified/competition-81218/',
                     '/pronostics/football/competition-81218/',
                     '/pronostics/tennis/france/competition-81218/',
                     'https://evil.invalid/pronostics/football/france/competition-81218/']:
            source = entry('denmark-prediction', DENMARK)
            source['body'] = source['body'].replace(
                'https://www.sportytrader.com/pronostics/football/europe/ligue-des-nations-81218/',
                path if path.startswith('https:') else d.HOST + path)
            detail = d.prediction(source, DENMARK, DAY, NOW)
            self.assertEqual(detail['competition'], {'name': 'Ligue des Nations'})

    def test_competition_display_difference_does_not_remove_verified_event_prices(self):
        detail = candidate()
        source = entry('denmark-odds', detail['oddsUrl'])
        source['body'] = source['body'].replace('/football/europe/ligue-des-nations-81218/',
            '/football/france/ligue-des-nations-81218/')
        available, _ = d.prices(source, detail, NOW)
        self.assertEqual(available['Unibet'], Decimal('1.38'))
        self.assertEqual(detail['competition']['scope'], 'international')

    def test_country_flag_is_retained_when_the_source_has_no_team_crest(self):
        node = Document('<div><span class="font-semibold">Allemagne</span>'
            '<img src="https://static.sportytrader.com/icons/countries/20x20/germany_1.webp" alt="Allemagne"></div>').root.children[0]
        self.assertEqual(d.participant(node)['logo'], 'https://static.sportytrader.com/icons/countries/20x20/germany_1.webp')

    def test_discovery_deduplicates_bounded_canonical_match_links(self):
        root = Document('<a href="/pronostics/football/">Football</a><a href="' + ZVEREV + '">Z</a>'
                        '<a href="' + ZVEREV + '">Z again</a>'
                        '<a href="https://evil.test/pronostics/x-12/">bad</a>'
                        + ''.join(f'<a href="/pronostics/test-{n}/">x</a>' for n in range(30))).root
        links = d.discovery(root)
        self.assertEqual(links[0], ZVEREV)
        self.assertEqual(len(links), d.MAX_CANDIDATES)
        self.assertEqual(len(set(links)), len(links))

    def test_missing_author_conclusion_does_not_use_probability_table(self):
        source = entry('denmark-prediction', DENMARK)
        source['body'] = source['body'].replace('Notre pronostic', 'Une autre analyse')
        with self.assertRaisesRegex(d.DailyVipError, 'editorial_recommendation_missing'):
            d.prediction(source, DENMARK, DAY, NOW)

    def test_discovery_round_robins_sports_when_football_has_many_cards(self):
        def group(prefix, count):
            return '<div class="pronostics-wrapper">' + ''.join(
                f'<a href="/pronostics/{prefix}-{n}/">x</a>' for n in range(count)) + '</div>'
        root = Document(group('football', 30) + group('tennis', 3) + group('basket', 3)).root
        links = d.discovery(root)
        self.assertEqual(links[:3], [d.HOST + f'/pronostics/{sport}-0/' for sport in ('football', 'tennis', 'basket')])
        self.assertEqual(len(links), 16)

    def test_unsupported_conclusion_is_skipped_not_rewritten(self):
        source = entry('denmark-prediction', DENMARK)
        source['body'] = source['body'].replace('plus de 2,5 buts dans le match', 'un pari impossible à identifier')
        with self.assertRaisesRegex(d.DailyVipError, 'recommended_market_unsupported'):
            d.prediction(source, DENMARK, DAY, NOW)

    def test_wrong_line_and_wrong_period_cannot_supply_odds(self):
        detail = candidate()
        source = entry('denmark-odds', detail['oddsUrl'])
        source['body'] = source['body'].replace('data-panel-key="UNDER_OVER_2_5"', 'data-panel-key="UNDER_OVER_1H_2_5"')
        with self.assertRaisesRegex(d.DailyVipError, 'odds_line_missing'):
            d.prices(source, detail, NOW)

    def test_suspended_bookmaker_is_skipped_without_substituting_another_market(self):
        detail = candidate()
        source = entry('denmark-odds', detail['oddsUrl'])
        source['body'] = source['body'].replace('>1.38</span>', '>0</span>')
        available, observed = d.prices(source, detail, NOW)
        self.assertNotIn('Unibet', available)
        self.assertEqual(available['Winamax'], Decimal('1.35'))

    def test_odds_identity_participant_date_sport_must_match(self):
        detail = candidate()
        for before, after in [('Norvège', 'Suède'), ('20:45', '20:46'),
                              ('/cotes/football/', '/cotes/tennis/')]:
            source = entry('denmark-odds', detail['oddsUrl'])
            source['body'] = source['body'].replace(before, after)
            with self.subTest(after=after), self.assertRaisesRegex(d.DailyVipError, 'odds_event_identity_conflict'):
                d.prices(source, detail, NOW)

    def test_wrong_edition_started_event_stale_entry_and_redirect_are_rejected(self):
        source = entry('zverev-prediction', ZVEREV)
        with self.assertRaisesRegex(d.DailyVipError, 'wrong_edition'):
            d.prediction(source, ZVEREV, '2026-11-18', NOW)
        source['saved'] = datetime(2026, 11, 17, 19, 5, tzinfo=timezone.utc).timestamp()
        with self.assertRaisesRegex(d.DailyVipError, 'started_or_too_close'):
            d.prediction(source, ZVEREV, DAY, datetime.fromtimestamp(source['saved'], timezone.utc))
        source = entry('zverev-prediction', ZVEREV)
        source['saved'] -= 901
        with self.assertRaisesRegex(d.DailyVipError, 'source_stale'):
            d.prediction(source, ZVEREV, DAY, NOW)
        source = entry('zverev-prediction', ZVEREV)
        source['final_url'] = DENMARK
        with self.assertRaisesRegex(d.DailyVipError, 'source_redirected'):
            d.prediction(source, ZVEREV, DAY, NOW)

    def test_paris_summer_offset_and_dst_fold_are_handled_explicitly(self):
        source = entry('zverev-prediction', ZVEREV)
        source['body'] = source['body'].replace('17/11/2026', '17/07/2026')
        teams, kickoff = d.hero(Document(source['body']).root)
        self.assertEqual(d.utc_text(kickoff), '2026-07-17T18:30:00Z')
        source['body'] = source['body'].replace('17/07/2026', '25/10/2026').replace('20:30', '02:30')
        with self.assertRaisesRegex(d.DailyVipError, 'clock_dst_ambiguous'):
            d.hero(Document(source['body']).root)

    def test_common_bookmaker_decimal_total_and_no_correlated_legs(self):
        coupon = test_coupon()
        self.assertEqual(coupon['selection']['totalOdds'], 3.13)
        self.assertEqual(coupon['dailyVip']['bookmaker'], 'Unibet')
        d.validate(coupon, DAY, NOW)
        first, second = candidate('zverev', ZVEREV), candidate()
        second['prices'] = {'Other bookmaker': Decimal('2.3')}
        self.assertIsNone(d.choose([first, second]))
        same = deepcopy(first)
        same.update(sourceId='same-fixture-another-page', prices={'Unibet': Decimal('2.3')})
        self.assertIsNone(d.choose([first, same]))

    def test_no_forced_quota_or_silent_max_four_exception(self):
        first, second = candidate('zverev', ZVEREV), candidate()
        first['prices'] = {'Unibet': Decimal('1.5')}
        second['prices'] = {'Unibet': Decimal('2.5')}
        self.assertIsNone(d.choose([first, second]))
        with self.assertRaisesRegex(d.DailyVipError, 'exception_not_enabled'):
            d.choose([first, second], maximum=Decimal('4'))

    def test_improper_total_or_stale_payload_cannot_be_delivered(self):
        coupon = test_coupon()
        coupon['selection']['totalOdds'] = 3.50
        with self.assertRaisesRegex(d.DailyVipError, 'total_odds_invalid'):
            d.validate(coupon, DAY, NOW)
        with self.assertRaisesRegex(d.DailyVipError, 'source_stale'):
            d.validate(test_coupon(), DAY, NOW + timedelta(minutes=16))

    def test_snapshot_frozen_skips_all_source_gets_and_model_calls(self):
        class Client:
            def request(self, route, payload=None):
                self.assert_route = route
                return {'date': DAY, 'importEnabled': True, 'notificationsEnabled': False,
                        'sources': [{'key': d.SOURCE, 'categoryIds': ['a' * 24],
                            'dailyVipState': {'state': 'frozen', 'sourceId': 'daily-vip-' + DAY}}]}
        class Fetch:
            requests = 0
            records = []
            def get(self, url):
                raise AssertionError('Frozen coupon must not fetch')
        with TemporaryDirectory() as folder:
            args = SimpleNamespace(edition=DAY, minimum_lead_minutes=30, publish=True,
                source=[d.SOURCE], output=folder, api_base='https://api.wintips-expert.com', translate=False)
            with patch.object(runner, 'make_translator', side_effect=AssertionError('No model')):
                report = runner.run(args, fetcher=Fetch(), api_client=Client(), now=NOW)
        self.assertEqual(report['sources'][0]['status'], 'published_snapshot_preserved')
        self.assertFalse(report['blocked'])
        self.assertEqual(report['publishedSources'], [d.SOURCE])

    def test_actual_compose_output_passes_the_current_api_validator_bilingually(self):
        binary = shutil.which('node')
        self.assertIsNotNone(binary, 'Node is required for the actual API contract check')
        tool = Path(__file__).resolve().parents[1] / 'validate-api-payload.cjs'
        script = ('const fs=require("fs"),v=require(process.argv[1]);'
            'const r=v.validate(fs.readFileSync(0),new Date(process.argv[2]));'
            'console.log(JSON.stringify(r));process.exitCode=r.passed?0:1;')
        payload = {'source': d.SOURCE, 'editionDate': DAY, 'items': [test_coupon()]}
        done = subprocess.run([binary, '-e', script, str(tool), d.utc_text(NOW)],
            input=json.dumps(payload, ensure_ascii=False).encode('utf8'), capture_output=True, timeout=30)
        report = json.loads(done.stdout)
        self.assertEqual(done.returncode, 0, report)
        self.assertTrue(report['passed'], report)
        self.assertEqual(report['diagnostics'], [])

    def test_new_config_without_source_id_publishes_native_coupon_without_model(self):
        posted, routes, drains = [], [], []
        class Client:
            def request(self, route, payload=None):
                routes.append(route)
                if route.endswith('/config'):
                    return {'date': DAY, 'importEnabled': True, 'notificationsEnabled': True,
                        'sources': [{'key': d.SOURCE, 'categoryIds': ['a' * 24], 'dailyVipState': {'state': 'new'}}]}
                if route.endswith('/import'):
                    posted.append(payload)
                    return {'ignored': False, 'notificationsSent': 0}
                if route.endswith('/notifications/drain'):
                    drains.append(payload)
                    return {'sent': 2}
                raise AssertionError('Unexpected API route')
        fake_fetch = SimpleNamespace(requests=0, records=[])
        with TemporaryDirectory() as folder:
            args = SimpleNamespace(edition=DAY, minimum_lead_minutes=30, publish=True,
                source=[d.SOURCE], output=folder, api_base='https://api.wintips-expert.com', translate=False)
            collected = {'status': 'ready', 'items': [test_coupon()], 'issues': []}
            with patch.object(runner, 'collect', return_value=collected), \
                    patch.object(runner, 'make_translator', side_effect=AssertionError('No model')), \
                    patch.dict('os.environ', {'WINTIPS_EDITORIAL_MANAGE_MODEL': 'true', 'WINTIPS_EDITORIAL_TRANSLATOR': 'ollama'}):
                report = runner.run(args, fetcher=fake_fetch, api_client=Client(), now=NOW, clock=lambda: NOW,
                                    api_validator=lambda *args: {'passed': True})
        self.assertFalse(report['blocked'], report)
        self.assertEqual(len(posted), 1)
        self.assertEqual(routes, ['/api/internal/editorial/config', '/api/internal/editorial/import',
                                  '/api/internal/editorial/notifications/drain'])
        self.assertEqual(drains, [{'dryRun': False, 'source': d.SOURCE}])
        self.assertEqual(report['notificationsAccepted'], 2)
        self.assertTrue(report['notificationsSent'])
        self.assertEqual(posted[0]['items'][0]['selection']['totalOdds'], 3.13)
        self.assertEqual(report['sources'][0]['translationPolicy'], 'native-labels-no-prose-v1')

    def test_frozen_native_coupon_retries_failed_notifications_without_fetch_or_model(self):
        calls, attempts = [], []
        class Client:
            def request(self, route, payload=None):
                calls.append((route, payload))
                if route.endswith('/config'):
                    return {'date': DAY, 'importEnabled': True, 'notificationsEnabled': True,
                        'sources': [{'key': d.SOURCE, 'categoryIds': ['a' * 24],
                            'dailyVipState': {'state': 'frozen', 'sourceId': 'daily-vip-' + DAY}}]}
                if route.endswith('/notifications/drain'):
                    attempts.append(payload)
                    if len(attempts) == 1:
                        raise ValueError('delivery_temporarily_unavailable')
                    return {'sent': 2}
                raise AssertionError('Frozen coupon must not import again')
        fetch = SimpleNamespace(requests=0, records=[])
        with TemporaryDirectory() as folder:
            args = SimpleNamespace(edition=DAY, minimum_lead_minutes=30, publish=True,
                source=[d.SOURCE], output=folder, api_base='https://api.wintips-expert.com', translate=False)
            with patch.object(runner, 'collect', side_effect=AssertionError('No source fetch')), \
                    patch.object(runner, 'make_translator', side_effect=AssertionError('No model')), \
                    patch.dict('os.environ', {'WINTIPS_EDITORIAL_MANAGE_MODEL': 'true',
                                              'WINTIPS_EDITORIAL_TRANSLATOR': 'ollama'}):
                first = runner.run(args, fetcher=fetch, api_client=Client(), now=NOW)
                retry = runner.run(args, fetcher=fetch, api_client=Client(), now=NOW)
        self.assertTrue(first['blocked'])
        self.assertEqual(first['notificationDrain'], {
            'pending': True, 'reason': 'ValueError'})
        self.assertFalse(first['notificationsSent'])
        self.assertFalse(retry['blocked'])
        self.assertEqual(retry['publishedSources'], [d.SOURCE])
        self.assertEqual(retry['sources'][0]['status'], 'published_snapshot_preserved')
        self.assertTrue(retry['notificationsSent'])
        self.assertEqual(retry['notificationsAccepted'], 2)
        self.assertEqual(attempts, [{'dryRun': False, 'source': d.SOURCE}] * 2)
        self.assertEqual([route for route, _ in calls], [
            '/api/internal/editorial/config', '/api/internal/editorial/notifications/drain'] * 2)

    def test_native_notification_drain_requires_publish_and_enabled_notifications(self):
        for publish, enabled in [(False, True), (True, False)]:
            with self.subTest(publish=publish, enabled=enabled):
                calls = []
                class Client:
                    def request(self, route, payload=None):
                        calls.append(route)
                        if not route.endswith('/config'):
                            raise AssertionError('Notification delivery must remain disabled')
                        return {'date': DAY, 'importEnabled': True, 'notificationsEnabled': enabled,
                            'sources': [{'key': d.SOURCE, 'categoryIds': ['a' * 24],
                                'dailyVipState': {'state': 'frozen', 'sourceId': 'daily-vip-' + DAY}}]}
                with TemporaryDirectory() as folder:
                    args = SimpleNamespace(edition=DAY, minimum_lead_minutes=30, publish=publish,
                        source=[d.SOURCE], output=folder, api_base='https://api.wintips-expert.com', translate=False)
                    with patch.object(runner, 'collect', side_effect=AssertionError('No source fetch')), \
                            patch.object(runner, 'make_translator', side_effect=AssertionError('No model')):
                        report = runner.run(args, fetcher=SimpleNamespace(requests=0, records=[]),
                                            api_client=Client(), now=NOW)
                self.assertEqual(calls, ['/api/internal/editorial/config'])
                self.assertNotIn('notificationDrain', report)
                self.assertFalse(report['notificationsSent'])

    def test_explicit_mixed_source_run_advances_daily_clock_after_slow_rdj(self):
        elapsed, clocks = [0], []
        def collect(source, edition, fetcher, **kwargs):
            if source == 'rdj_football_analysis':
                elapsed[0] = 90
                return {'status': 'source_absent', 'items': [], 'issues': []}
            clocks.append(kwargs['now'])
            return {'status': 'ready', 'items': [test_coupon()], 'issues': []}
        with TemporaryDirectory() as folder:
            args = SimpleNamespace(edition=DAY, minimum_lead_minutes=30, publish=False,
                source=['rdj_football_analysis', d.SOURCE], output=folder, api_base=None, translate=False)
            with patch.object(runner, 'collect', side_effect=collect), \
                    patch.object(runner.time, 'monotonic', side_effect=lambda: elapsed[0]):
                report = runner.run(args, fetcher=SimpleNamespace(requests=0, records=[]), now=NOW)
        self.assertEqual(clocks, [NOW + timedelta(seconds=90)])
        self.assertFalse(report['blocked'], report)

    def test_only_sporty_source_host_allowed_and_cache_is_isolated_and_bounded(self):
        public_url(ZVEREV)
        with self.assertRaises(FetchError):
            public_url('https://www.sportytrader.com.evil.test/')
        with TemporaryDirectory() as folder:
            fetcher = PublicFetcher(folder)
            cache = fetcher._sporty_cache()
            old = cache / ('a' * 64 + '.json')
            old.write_text('{}')
            import os, time
            os.utime(old, (time.time() - 3 * 86400,) * 2)
            rdj = Path(folder) / ('b' * 64 + '.json')
            rdj.write_text('{}')
            fetcher._prune_sporty_cache(cache)
            self.assertFalse(old.exists())
            self.assertTrue(rdj.exists())


if __name__ == '__main__':
    unittest.main()
