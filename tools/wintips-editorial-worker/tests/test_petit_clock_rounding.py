"""Identity-bound rounding handoff; no HTTP, account, model or publication."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from editorial_worker import sources as s
from test_petit_midnight_clocks import Fetcher, page

DAY = '2026-10-30'
NOW = datetime(2026, 10, 30, 10, tzinfo=timezone.utc)
JOURNAL = s.HOST + '/paris-sportifs/le-petit-journal/74999-le-petit-journal-du-parieur-vendredi-30-octobre-2026.html'


def ready(next_day=True):
    edition = DAY if next_day else '2026-10-31'
    journal_url = JOURNAL if next_day else JOURNAL.replace('30-octobre', '31-octobre')
    now = NOW if next_day else datetime(2026, 10, 31, tzinfo=timezone.utc)
    value = page(clock='00h35')
    with patch.dict(os.environ, {}, clear=True):
        detail = s.rdj._detail(value)
    resolution = {'method': 'rdj_detail_clock_rounding_v1', 'source_url': value.url,
        'assumed_timezone': 'UTC', 'timezone_assumed': True,
        'source_clocks': {'journal': '2026-10-31T00:30:00', 'detail': '2026-10-31T00:35:00'},
        'delta_seconds': 300, 'limit_seconds': 300, 'journal_rounding_minutes': 15, 'preferred_clock': 'detail',
        'identity_checks': {'ordered_participants': True, 'competition': True, 'calendar_date': True}}
    fixture = {'id': '6014934', 'home': 'Toronto', 'away': 'Orlando', 'sport': 'basketball', 'competition': 'NBA',
        'source_url': value.url, 'journal_source_url': journal_url, 'pick_fr': 'Victoire Toronto', 'odds': 1.7,
        'kickoff_utc': '2026-10-31T00:35:00+00:00', 'kickoff_local': dict(resolution['source_clocks']),
        'provenance': {'kickoff_resolution': resolution, 'participant_logo_ids': detail['participant_logos']}}
    with patch.dict(os.environ, {}, clear=True), \
            patch.object(s.rdj, 'collect_edition', return_value={'status': 'ready', 'fixtures': [fixture]}):
        result = s.collect_petit(edition, Fetcher(value), now=now,
            resolver=lambda *_: (_ for _ in ()).throw(AssertionError('no external schedule')))
    if result['status'] != 'ready':
        raise AssertionError(result)
    return result['items'][0], fixture, detail, value, now


def proof_of(item):
    return item.get('clockReconciliation') or item['scheduleProof']['clockReconciliation']


def preflight(item, now):
    root = Path(__file__).resolve().parents[3]
    process = subprocess.run(['node', '-e',
        "let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>console.log(JSON.stringify(require('./tools/wintips-editorial-worker/validate-api-payload.cjs').validate(Buffer.concat(b),new Date(process.argv[1])))))",
        now.isoformat()], input=json.dumps({'source': 'rdj_petit_journal', 'editionDate': item['editionDate'], 'items': [item]}),
        cwd=root, text=True, capture_output=True, timeout=20, check=True)
    return json.loads(process.stdout)


class PetitClockRoundingTests(unittest.TestCase):
    def test_same_and_following_day_propagate_original_clocks_and_keep_the_precise_detail_utc(self):
        for next_day in (False, True):
            with self.subTest(next_day=next_day):
                item, fixture, detail, value, now = ready(next_day)
                proof = proof_of(item)
                self.assertEqual(item['startsAtUtc'], '2026-10-31T00:35:00Z')
                self.assertEqual(proof['journalClock'], fixture['kickoff_local']['journal'])
                self.assertEqual(proof['detailClock'], fixture['kickoff_local']['detail'])
                self.assertEqual(proof['method'], 'rdj_detail_clock_rounding_v1')
                self.assertEqual(proof['participantLogoIds'], detail['participant_logos'])
                self.assertEqual(proof['matchedParticipants'], ['Toronto', 'Orlando'])
                self.assertEqual(item['selection']['label']['fr'], 'Victoire Toronto')
                self.assertEqual(item['selection']['odds'], 1.7)
                self.assertEqual(len(item['analysis']['fr'][0]['paragraphs']), 2)
                self.assertTrue(s.eligible(item, item['editionDate'], now))
                self.assertTrue(preflight(item, now)['passed'])

    def test_reconciliation_never_uses_false_or_unbound_canonical_metadata(self):
        original, fixture, detail, value, now = ready()
        mutations = [
            lambda f: f.update(id='9999'),
            lambda f: f.update(source_url=value.url.replace('6014934', '9999')),
            lambda f: f.update(home='Another club'),
            lambda f: f.update(sport='football'),
            lambda f: f.update(competition='Another league'),
            lambda f: f['provenance']['participant_logo_ids'].reverse(),
            lambda f: f['provenance']['kickoff_resolution'].update(limit_seconds=600),
            lambda f: f['provenance']['kickoff_resolution'].update(journal_rounding_minutes=30),
            lambda f: f['provenance']['kickoff_resolution'].update(delta_seconds=240),
            lambda f: f['provenance']['kickoff_resolution'].update(source_url=value.url + '?unbound=1'),
            lambda f: f['provenance']['kickoff_resolution']['identity_checks'].update(competition=False),
            lambda f: f['provenance']['kickoff_resolution']['source_clocks'].update(journal='2026-10-31T00:45:00'),
        ]
        for mutate in mutations:
            changed = deepcopy(fixture)
            mutate(changed)
            with self.subTest(fixture=changed), self.assertRaises(s.ParseError):
                s.match_item(detail, value, 'rdj_petit_journal', DAY, resolver=None,
                    pick=changed['pick_fr'], odds=changed['odds'], kickoff=s.iso(changed['kickoff_utc']), journal_fixture=changed)

    def test_malformed_reconciliation_does_not_make_eligibility_tolerant(self):
        for next_day in (False, True):
            original, _, _, _, now = ready(next_day)
            for field, bad in [('method', 'free_tolerance'), ('sourceId', '9999'),
                    ('sourceUrl', JOURNAL + '?ignored=1'), ('detailSourceUrl', s.HOST + '/pronostic/wrong-9999.html'),
                    ('matchedParticipants', ['Orlando', 'Toronto']), ('participantLogoIds', ['12', '11']),
                    ('sport', 'football'), ('competition', 'WNBA'), ('limitSeconds', 3600),
                    ('journalRoundingMinutes', 30), ('deltaSeconds', 0), ('timezoneAssumed', False),
                    ('assumedTimezone', 'Europe/Paris'), ('preferredClock', 'journal'),
                    ('journalClock', '2026-10-31T00:31:00'), ('detailClock', '2026-10-31T00:36:00'),
                    ('journalClock', '2026-10-31T00:30:00+00:00'), ('detailClock', '2026-10-31T00:35:00+00:00'),
                    ('startsAtUtc', '2026-10-31T01:35:00Z')]:
                changed = deepcopy(original)
                proof_of(changed)[field] = bad
                with self.subTest(next_day=next_day, field=field, bad=bad):
                    self.assertFalse(s.eligible(changed, changed['editionDate'], now))

    def test_unequal_following_day_clocks_without_explicit_proof_stay_blocked(self):
        item, _, _, _, now = ready()
        item['scheduleProof'].pop('clockReconciliation')
        self.assertFalse(s.eligible(item, DAY, now))
        self.assertFalse(preflight(item, now)['passed'])

    def test_submillisecond_clocks_and_conflicting_top_level_proofs_stay_invalid(self):
        for next_day in (False, True):
            original, _, _, _, now = ready(next_day)
            for field in ('journalClock', 'detailClock', 'startsAtUtc'):
                changed = deepcopy(original)
                value = proof_of(changed)[field]
                proof_of(changed)[field] = value.replace('Z', '.000001Z') if value.endswith('Z') else value + '.000001'
                with self.subTest(next_day=next_day, field=field):
                    self.assertFalse(s.eligible(changed, changed['editionDate'], now))
                    self.assertFalse(preflight(changed, now)['passed'])
        item, _, _, _, now = ready()
        item['clockReconciliation'] = deepcopy(item['scheduleProof']['clockReconciliation'])
        self.assertFalse(s.eligible(item, item['editionDate'], now))
        self.assertFalse(preflight(item, now)['passed'])

    @unittest.skipUnless(os.environ.get('RDJ_TEST_HUB_CODE_ROOT'), 'canonical hub checkout explicitly required')
    def test_archived_nov7_html_through_changed_canonical_hub_adapter_and_real_js_validator(self):
        code = Path(os.environ['RDJ_TEST_HUB_CODE_ROOT']).resolve()
        fixture = code.parent / 'journal-parieur-worker/journal_worker/tests/fixtures/rdj-petit-20261107-excerpt.json'
        pages = json.loads(fixture.read_text('utf-8'))['pages']
        journal = next(url for url in pages if '/le-petit-journal/' in url)
        pages[s.SOURCES['rdj_petit_journal']] = '<a href="' + journal + '">Petit Journal 7 novembre 2026</a>'
        class Offline:
            def html(self, url):
                if url not in pages:
                    raise AssertionError('Unexpected source fetch: ' + url)
                return s.rdj.FetchedPage(url, pages[url])
        now = datetime(2026, 11, 7, 4, tzinfo=timezone.utc)
        with TemporaryDirectory() as storage, patch.dict(os.environ,
                {'RDJ_CONTENT_HUB_DIR': storage, 'RDJ_HUB_CODE_ROOT': str(code)}):
            result = s.collect_petit('2026-11-07', Offline(), now=now,
                resolver=lambda *_: self.fail('No provider is needed for identity-bound detail clocks'))
        self.assertEqual(result['status'], 'ready', result['issues'])
        self.assertEqual([item['sourceId'] for item in result['items']], ['6571309', '5802987'])
        tennis, psg = result['items']
        self.assertEqual(tennis['competition']['name'], 'Chennai Open')
        self.assertEqual(psg['startsAtUtc'], '2026-11-07T21:05:00Z')
        self.assertEqual(psg['clockReconciliation']['journalClock'], '2026-11-07T21:00:00')
        self.assertEqual(psg['clockReconciliation']['detailClock'], '2026-11-07T21:05:00')
        self.assertEqual(psg['selection']['label']['fr'], 'PSG -2,5')
        self.assertEqual(psg['selection']['odds'], 1.72)
        for item in result['items']:
            self.assertTrue(preflight(item, now)['passed'])


if __name__ == '__main__':
    unittest.main()
