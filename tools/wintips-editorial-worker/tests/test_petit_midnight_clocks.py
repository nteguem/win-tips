"""Dated Petit clock handoff and next-day contract; no network/model/push.

Set RDJ_TEST_HUB_CODE_ROOT to the canonical checkout's tools/rdj-source-hub
to also run the real shared parser against the synthetic 24h30 source.
"""
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from types import ModuleType
import unittest
from unittest.mock import patch

from editorial_worker import content_hub, sources as s

DAY = '2026-10-30'
NOW = datetime(2026, 10, 30, 10, tzinfo=timezone.utc)
JOURNAL = s.HOST + '/paris-sportifs/le-petit-journal/74999-le-petit-journal-du-parieur-vendredi-30-octobre-2026.html'


def page(identity='6014934', sport='Basket', competition='NBA', day=31, clock='24h30'):
    return s.rdj.FetchedPage(s.HOST + '/pronostic/toronto-orlando-' + identity + '.html',
        '<html><head><meta property="og:image" content="https://img.ruedesjoueurs.com/test.webp"></head><body>'
        '<h1>Pronostic Toronto - Orlando du ' + str(day) + ' octobre 2026</h1>'
        '<nav class="breadcrumb"><a>' + sport + '</a></nav><h2 class="header">' + competition + '</h2>'
        '<div class="fichematch"><div class="equipe"><strong>Toronto</strong><img src="https://img.ruedesjoueurs.com/img/11-1.png"></div>'
        '<div class="equipe"><strong>Orlando</strong><img src="https://img.ruedesjoueurs.com/img/12-1.png"></div>'
        '<p class="m_title">' + str(day) + ' octobre 2026 ' + clock + '</p></div>'
        '<section><h2>L’état de forme</h2><p>Premier paragraphe de la fixture synthétique avec score 2-1 et négation ne perd pas.</p>'
        '<p>Second paragraphe conservé intégralement pour vérifier que seule la représentation horaire change.</p></section></body></html>')


def fixture(sport='basketball', competition='NBA'):
    return {'id': '6014934', 'home': 'Toronto', 'away': 'Orlando', 'sport': sport, 'competition': competition,
        'source_url': page().url, 'journal_source_url': JOURNAL, 'pick_fr': 'Victoire Toronto', 'odds': 1.7,
        'kickoff_utc': '2026-10-31T00:30:00+00:00',
        'kickoff_local': {'journal': '2026-10-31T00:30:00', 'detail': '2026-10-31T00:30:00'},
        'provenance': {'kickoff_normalization': {'method': 'rdj_24h_corroborated_v1', 'source_url': page().url,
            'raw': '31 octobre 2026 24h30', 'reference': '2026-10-31T00:30:00',
            'normalized': '2026-10-31T00:30:00', 'candidates': ['2026-10-31T00:30:00', '2026-11-01T00:30:00']}}}


class Fetcher:
    def __init__(self, value): self.value = value
    def html(self, url):
        if url != self.value.url: raise AssertionError('unexpected network-like request')
        return self.value


class PetitClockHandoffTests(unittest.TestCase):
    def test_detail_wrapper_preserves_reference_to_the_canonical_hub(self):
        module = ModuleType('rdj_hub.petit')
        received = []
        module.detail = lambda hub, value, clock_reference=None: received.append((hub, value, clock_reference)) or {'ok': True}
        reference = datetime(2026, 10, 31, 0, 30)
        shared = object()
        with patch.dict(os.environ, {'RDJ_CONTENT_HUB_DIR': 'enabled'}), patch.object(content_hub, 'open_hub', return_value=shared), \
                patch.dict('sys.modules', {'rdj_hub.petit': module}):
            value = page()
            self.assertEqual(s.rdj._detail(value, clock_reference=reference), {'ok': True})
        self.assertEqual(received, [(shared, value, reference)])

    def collect_ready(self, sport='basketball', competition='NBA'):
        current = fixture(sport, competition)
        value = page(sport='Tennis' if sport == 'tennis' else 'Basket', competition=competition, clock='00h30')
        original = s.rdj._detail
        references = []
        def reread(value, clock_reference=None):
            references.append(clock_reference)
            return original(value, clock_reference=clock_reference)
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(s.rdj, 'collect_edition', return_value={'status': 'ready', 'fixtures': [current]}), \
                patch.object(s.rdj, '_detail', side_effect=reread):
            result = s.collect_petit(DAY, Fetcher(value), now=NOW,
                resolver=lambda *_: (_ for _ in ()).throw(AssertionError('no external schedule needed')))
        return result, references

    def test_canonical_journal_reference_survives_the_typed_reread_and_nba_night(self):
        result, references = self.collect_ready()
        self.assertEqual(references, [datetime(2026, 10, 31, 0, 30)])
        self.assertEqual(result['status'], 'ready', result['issues'])
        item = result['items'][0]
        self.assertEqual(item['editionDate'], DAY)
        self.assertEqual(item['startsAtUtc'], '2026-10-31T00:30:00Z')
        self.assertEqual(item['editionConvention'], 'journal_following_day')
        self.assertEqual(item['scheduleProof']['normalization'], fixture()['provenance']['kickoff_normalization'])
        self.assertEqual(item['selection']['label']['fr'], 'Victoire Toronto')
        self.assertEqual(len(item['analysis']['fr'][0]['paragraphs']), 2)

    def test_tennis_next_day_card_uses_the_same_journal_contract_without_nba_bypass(self):
        result, _ = self.collect_ready('tennis', 'ATP')
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(result['items'][0]['sport']['key'], 'tennis')
        self.assertEqual(result['items'][0]['scheduleProof']['method'], 'rdj_journal_clock')

    def test_proof_is_bound_to_the_dated_source_identity_clocks_and_one_following_day(self):
        result, _ = self.collect_ready()
        original = result['items'][0]
        mutations = [
            lambda row: row.update(source='rdj_multisport_analysis'),
            lambda row: row['scheduleProof'].update(sourceUrl=JOURNAL.replace('30-octobre', '29-octobre')),
            lambda row: row['scheduleProof'].update(sourceId='9999'),
            lambda row: row['scheduleProof']['matchedParticipants'].reverse(),
            lambda row: row['scheduleProof'].update(journalClock='2026-10-31T00:31:00'),
            lambda row: row['scheduleProof'].update(detailClock='2026-10-31T24:30:00'),
            lambda row: row['scheduleProof']['normalization'].update(reference='2026-10-30T00:30:00'),
            lambda row: row['scheduleProof']['normalization'].update(raw='31 octobre 2026 24h59'),
            lambda row: row['scheduleProof']['normalization'].update(raw='30 octobre 2026 24h30'),
            lambda row: row.update(startsAtUtc='2026-11-01T00:30:00Z'),
        ]
        for mutate in mutations:
            changed = deepcopy(original)
            mutate(changed)
            self.assertFalse(s.eligible(changed, DAY, NOW), changed)
        # A journal can explicitly include a later next-day match, too.
        afternoon = deepcopy(original)
        afternoon['startsAtUtc'] = afternoon['scheduleProof']['startsAtUtc'] = '2026-10-31T14:30:00Z'
        afternoon['scheduleProof']['journalClock'] = afternoon['scheduleProof']['detailClock'] = '2026-10-31T14:30:00'
        afternoon['scheduleProof'].pop('normalization')
        self.assertTrue(s.eligible(afternoon, DAY, NOW))

    @unittest.skipUnless(os.environ.get('RDJ_TEST_HUB_CODE_ROOT'), 'canonical hub checkout explicitly required')
    def test_real_canonical_parser_handles_both_raw_24h_dates_then_rereads_without_provider(self):
        code = str(Path(os.environ['RDJ_TEST_HUB_CODE_ROOT']).resolve())
        for raw_day in (30, 31):
            with self.subTest(raw_day=raw_day), TemporaryDirectory() as storage, \
                    patch.dict(os.environ, {'RDJ_CONTENT_HUB_DIR': storage, 'RDJ_HUB_CODE_ROOT': code}):
                details = page(day=raw_day)
                rugby = page('5917759', 'Rugby', 'Pro D2', 30, '19h30')
                rugby = s.rdj.FetchedPage(rugby.url.replace('toronto-orlando', 'beziers-grenoble'),
                    rugby.html.replace('Toronto', 'Béziers').replace('Orlando', 'Grenoble')
                        .replace('/img/11-', '/img/21-').replace('/img/12-', '/img/22-'))
                rugby_card = '<article><p>Notre prono</p><h2>Pro D2</h2><div aria-label="Match">' \
                    '<img src="https://img.ruedesjoueurs.com/img/21-1.png"><img src="https://img.ruedesjoueurs.com/img/22-1.png">30 octobre 2026 19h30</div>' \
                    '<p>Cette analyse de rugby synthétique est conservée dans la même édition pour vérifier le lot complet et ses horaires.</p>' \
                    '<div><div>Victoire Béziers</div><div>@1.80</div></div><a href="' + rugby.url + '">Lire l’analyse complète</a></article>'
                journal = '<h1>Le Petit Journal du Parieur vendredi 30 octobre 2026</h1><div id="articleMainContent"><section id="tab-pronostics">' + rugby_card + '<article>' \
                    '<p>Notre prono</p><h2>NBA</h2><div aria-label="Match"><img src="https://img.ruedesjoueurs.com/img/11-1.png">' \
                    '<img src="https://img.ruedesjoueurs.com/img/12-1.png">31 octobre 2026 00h30</div>' \
                    '<p>Cette analyse de fixture synthétique comprend suffisamment de mots et ne représente aucun conseil de pari réel.</p>' \
                    '<div><div>Victoire Toronto</div><div>@1.70</div></div><a href="' + details.url + '">Lire l’analyse complète</a>' \
                    '</article></section></div>'
                pages = {s.SOURCES['rdj_petit_journal']: '<a href="' + JOURNAL + '">Petit Journal 30 octobre 2026</a>',
                    JOURNAL: journal, details.url: details.html, rugby.url: rugby.html}
                class Offline:
                    def html(self, url): return s.rdj.FetchedPage(url, pages[url])
                result = s.collect_petit(DAY, Offline(), now=NOW,
                    resolver=lambda *_: (_ for _ in ()).throw(AssertionError('provider must not run')))
                self.assertEqual(result['status'], 'ready', result['issues'])
                self.assertEqual([row['sourceId'] for row in result['items']], ['5917759', '6014934'])
                self.assertEqual([row['startsAtUtc'] for row in result['items']], ['2026-10-30T19:30:00Z', '2026-10-31T00:30:00Z'])
                self.assertEqual(result['items'][1]['scheduleProof']['normalization']['raw'], f'{raw_day} octobre 2026 24h30')
                # Complete typed lot must pass the real API import validator,
                # without bootstrap, Mongo, external translation or sending.
                root = Path(__file__).resolve().parents[3]
                process = subprocess.run(['node', '-e',
                    "let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>console.log(JSON.stringify(require('./tools/wintips-editorial-worker/validate-api-payload.cjs').validate(Buffer.concat(b),new Date(process.argv[1])))))",
                    NOW.isoformat()], input=json.dumps({'source': 'rdj_petit_journal', 'editionDate': DAY, 'items': result['items']}),
                    cwd=root, text=True, capture_output=True, timeout=20, check=True)
                preflight = json.loads(process.stdout)
                self.assertTrue(preflight['passed'], preflight)
                self.assertEqual(preflight['itemCount'], 2)


if __name__ == '__main__': unittest.main()
