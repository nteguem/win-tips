"""Offline UTC-policy regressions using the fixture clocks observed 3 Nov.

Participant names, IDs, dates and event clocks below were inspected on the
dated RDJ pages. HTML is reduced to the supported structure and all analysis
prose is deliberately synthetic. No live HTTP, Gemini, sending or importing.
"""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from editorial_worker import sources as s


DAY = '2026-11-03'
NOW = datetime(2026, 11, 3, 12, tzinfo=timezone.utc)
CASES = (
    ('6106316', 'bodoe-glimt-lille', 'Bodø Glimt', 'Lille', '21:00'),
    ('6106266', 'atletico-madrid-bayern-munich', 'Atlético Madrid', 'Bayern Munich', '21:00'),
    ('6106291', 'manchester-united-roma', 'Manchester United', 'Roma', '21:00'),
    ('6106306', 'feyenoord-inter', 'Feyenoord', 'Inter', '21:00'),
    ('6106341', 'galatasaray-vfb-stuttgart', 'Galatasaray', 'VfB Stuttgart', '18:45'),
    ('6106335', 'shakhtar-donetsk-sporting-cp', 'Shakhtar Donetsk', 'Sporting CP', '18:45'),
    ('6106408', 'lask-slovan-bratislava', 'LASK', 'Slovan Bratislava', '21:00'),
)


def page(row=CASES[1], day=3, clock=None, offset=None, sport='football', competition='Ligue des Champions'):
    identity, slug, home, away, observed_clock = row
    display = clock or observed_clock
    url = s.HOST + '/pronostic/' + slug + '-' + identity + '.html'
    raw_time = f'mardi {day:02d} novembre 2026 à {display}' if day == 3 else f'{day:02d} novembre 2026 à {display}'
    event = f'<time datetime="2026-11-{day:02d}T{display}:00{offset}">{raw_time}</time>' if offset is not None else raw_time
    return s.rdj.FetchedPage(url,
        '<html><head><meta property="og:image" content="https://img.ruedesjoueurs.com/test.webp"></head><body>'
        f'<h1>Pronostic {home} - {away} du {day:02d} novembre 2026</h1>'
        f'<nav class="breadcrumb"><a>{"Basket" if sport == "basketball" else "Football"}</a></nav>'
        f'<h2 class="header">{competition}</h2><div class="fichematch">'
        f'<div class="equipe"><strong>{home}</strong><img src="https://img.ruedesjoueurs.com/img/11-1.png"></div>'
        f'<div class="equipe"><strong>{away}</strong><img src="https://img.ruedesjoueurs.com/img/12-1.png"></div>'
        f'<p class="m_title">{event}</p></div>'
        '<section><h2>L’état de forme</h2><p>Paragraphe synthétique de test, conservé pour vérifier la transmission intégrale du contenu.</p>'
        '<p>Second paragraphe synthétique, sans faits sportifs inventés et sans modification du pronostic.</p></section>'
        '<div class="table bloc"><h2>Pronostic de nos experts</h2>'
        f'<p class="grey line-height-1">Sélection synthétique pour {home}</p>'
        '<div class="box1n2 active">1</div><div class="box1n2">N</div><div class="box1n2">2</div></div>'
        '</body></html>')


class Offline:
    def __init__(self, values=None):
        rows = values or [page(row) for row in CASES]
        self.pages = {value.url: value for value in rows}
        self.pages[s.SOURCES['rdj_football_analysis']] = s.rdj.FetchedPage(s.SOURCES['rdj_football_analysis'],
            ''.join('<a href="' + value.url + '">Lire l’analyse</a>' for value in rows))
        self.provider_calls = []

    def html(self, url):
        if url not in self.pages:
            raise AssertionError('Unplanned HTTP is forbidden')
        return self.pages[url]

    def json(self, url):
        self.provider_calls.append(url)
        return []  # The observed UEFA season response is empty.


class AnalysisDefaultUtcTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {'RDJ_CONTENT_HUB_DIR': ''})
        environment.start()
        self.addCleanup(environment.stop)

    def test_observed_seven_football_clocks_are_eligible_with_an_empty_uefa_provider(self):
        offline = Offline()
        result = s.collect_football(DAY, offline, now=NOW, resolver=s.VerifiedKickoffs(fetch_json=offline.json), limit=7)
        self.assertEqual(result['status'], 'ready', result['issues'])
        self.assertEqual(result['issues'], [])
        self.assertEqual([item['sourceId'] for item in result['items']], [row[0] for row in CASES])
        self.assertEqual([item['startsAtUtc'] for item in result['items']], [DAY + 'T' + row[4] + ':00Z' for row in CASES])
        self.assertEqual(offline.provider_calls, [])
        self.assertTrue(all(len(item['analysis']['fr'][0]['paragraphs']) == 2 for item in result['items']))

    def test_same_day_clock_never_calls_a_provider_or_changes_the_input(self):
        value = page()
        detail = s.rdj._detail(value)
        before = detail['kickoff']
        result = s.match_item(detail, value, 'rdj_football_analysis', DAY,
            resolver=lambda *_: self.fail('Same-day source clock needs no schedule lookup'))
        self.assertEqual(result['startsAtUtc'], DAY + 'T21:00:00Z')
        self.assertEqual(detail['kickoff'], before)
        self.assertIsNone(detail['kickoff'].tzinfo)

    def test_explicit_source_offset_has_priority_over_the_utc_default(self):
        for offset, expected in [('+01:00', '20:00'), ('+02:00', '19:00'), ('Z', '21:00')]:
            value = page(offset=offset)
            detail = s.rdj._detail(value)
            with self.subTest(offset=offset):
                result = s.match_item(detail, value, 'rdj_football_analysis', DAY,
                    resolver=lambda *_: self.fail('An explicit offset is already authoritative'))
                self.assertEqual(result['startsAtUtc'], DAY + 'T' + expected + ':00Z')

    def test_football_import_keeps_the_configured_limit_and_exclusions(self):
        result = s.collect_football(DAY, Offline(), now=NOW,
            resolver=lambda *_: self.fail('No provider lookup expected'), limit=3, exclude_ids={'6106316'})
        self.assertEqual(result['status'], 'ready')
        self.assertEqual([item['sourceId'] for item in result['items']], [row[0] for row in CASES[1:4]])

    def test_actual_api_contract_accepts_the_three_typed_football_items(self):
        result = s.collect_football(DAY, Offline(), now=NOW, resolver=lambda *_: None, limit=3)
        root = Path(__file__).resolve().parents[3]
        process = subprocess.run(['node', '-e',
            "let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>console.log(JSON.stringify(require('./tools/wintips-editorial-worker/validate-api-payload.cjs').validate(Buffer.concat(b),new Date(process.argv[1])))))",
            NOW.isoformat()], input=json.dumps({'source': 'rdj_football_analysis', 'editionDate': DAY, 'items': result['items']}),
            cwd=root, text=True, capture_output=True, timeout=20, check=True)
        preflight = json.loads(process.stdout)
        self.assertTrue(preflight['passed'], preflight)
        self.assertEqual(preflight['itemCount'], 3)

    def test_default_utc_preserves_publication_cutoff_and_source_date_limits(self):
        value = page()
        item = s.match_item(s.rdj._detail(value), value, 'rdj_football_analysis', DAY, resolver=lambda *_: None)
        kickoff = datetime(2026, 11, 3, 21, tzinfo=timezone.utc)
        self.assertTrue(s.eligible(item, DAY, kickoff - timedelta(minutes=30)))
        self.assertFalse(s.eligible(item, DAY, kickoff - timedelta(minutes=29, seconds=59)))
        self.assertFalse(s.eligible(item, DAY, kickoff))
        self.assertFalse(s.eligible(item, '2026-11-04', NOW))
        for day in (2, 4, 5):
            result = s.collect_football(DAY, Offline([page(day=day)]), now=NOW,
                resolver=lambda *_: self.fail('Out-of-edition dates must not reach the provider'))
            with self.subTest(day=day):
                self.assertEqual(result['status'], 'source_absent')
                self.assertEqual(result['items'], [])

    def test_naive_zero_hour_is_a_real_midnight_clock_and_still_subject_to_cutoff(self):
        value = page(clock='00:00')
        item = s.match_item(s.rdj._detail(value), value, 'rdj_football_analysis', DAY,
            resolver=lambda *_: self.fail('Midnight must not be treated as a missing clock'))
        self.assertEqual(item['startsAtUtc'], DAY + 'T00:00:00Z')
        self.assertFalse(s.eligible(item, DAY, NOW))

    def test_nba_following_night_still_requires_its_independent_schedule(self):
        value = page(day=4, clock='00:30', sport='basketball', competition='NBA')
        detail = s.rdj._detail(value)
        for resolver in (None, lambda *_: None):
            with self.subTest(resolver=resolver), self.assertRaises(ValueError):
                s.match_item(detail, value, 'rdj_multisport_analysis', DAY, resolver=resolver, pick='Victoire test', odds=1.7)
        proof = {'method': 'official_schedule', 'source_id': '12345',
            'source_url': 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json',
            'kickoff_utc': '2026-11-04T00:30:00Z'}
        calls = []
        def valid_schedule(*args):
            calls.append(args)
            return proof
        item = s.match_item(detail, value, 'rdj_multisport_analysis', DAY, resolver=valid_schedule, pick='Victoire test', odds=1.7)
        self.assertGreaterEqual(len(calls), 1)
        self.assertEqual(item['editionConvention'], 'nba_following_night')
        self.assertTrue(s.eligible(item, DAY, NOW))

    def test_utc_default_cannot_grant_next_day_membership_to_non_nba_sources(self):
        value = page(day=4, clock='01:30')
        item = s.match_item(s.rdj._detail(value), value, 'rdj_football_analysis', DAY, resolver=lambda *_: None)
        self.assertFalse(s.eligible(item, DAY, NOW))


if __name__ == '__main__':
    unittest.main()
