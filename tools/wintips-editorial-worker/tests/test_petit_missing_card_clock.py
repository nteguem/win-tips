"""Missing card clocks retain the linked event's evidence through WinTips import."""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from editorial_worker import sources as s
from test_petit_midnight_clocks import DAY, NOW, Fetcher, fixture, page


class PetitMissingCardClockTests(unittest.TestCase):
    def ready(self, clock='2026-10-31T00:30:00', policy='rdj_detail_default_utc'):
        source = fixture()
        source['kickoff_local'] = {'journal': None, 'detail': clock}
        source['provenance'] = {
            'kickoff_card_fallback': {'reason': 'kickoff_missing', 'source_url': page().url,
                                      'source_date': '2026-10-31'},
            'kickoff_resolution': {'method': policy, 'source_url': page().url,
                                  'source_clocks': {'journal': None, 'detail': clock}}}
        detail = s.rdj._detail(page(clock='00h30'))
        detail['kickoff'] = s.datetime.fromisoformat(clock)
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(s.rdj, 'collect_edition', return_value={'status': 'ready', 'fixtures': [source]}), \
                patch.object(s.rdj, '_detail', return_value=detail):
            result = s.collect_petit(DAY, Fetcher(page(clock='00h30')), now=NOW,
                resolver=lambda *_: self.fail('No third-party schedule is needed'))
        self.assertEqual(result['status'], 'ready')
        return result['items'][0]

    def test_next_day_card_keeps_null_journal_clock_and_original_selection(self):
        item = self.ready()
        self.assertIsNone(item['scheduleProof']['journalClock'])
        self.assertEqual(item['scheduleProof']['detailClock'], '2026-10-31T00:30:00')
        self.assertEqual(item['scheduleProof']['cardClockFallback']['clockPolicy'], 'rdj_detail_default_utc')
        self.assertEqual(item['selection']['label']['fr'], 'Victoire Toronto')
        self.assertEqual(item['selection']['odds'], 1.7)
        self.assertEqual(len(item['analysis']['fr'][0]['paragraphs']), 2)
        self.assertTrue(s.eligible(item, DAY, NOW))

    def test_explicit_detail_offset_remains_authoritative(self):
        item = self.ready('2026-10-31T01:30:00+01:00', 'explicit_event_offset')
        self.assertEqual(item['startsAtUtc'], '2026-10-31T00:30:00Z')
        self.assertEqual(item['scheduleProof']['detailClock'], '2026-10-31T01:30:00+01:00')
        self.assertTrue(s.eligible(item, DAY, NOW))

    def test_fallback_cannot_relax_identity_date_or_clock_binding(self):
        original = self.ready()
        mutations = [
            lambda row: row['scheduleProof'].pop('cardClockFallback'),
            lambda row: row['scheduleProof'].pop('journalClock'),
            lambda row: row['scheduleProof']['cardClockFallback'].update(reason='kickoff_ambiguous'),
            lambda row: row['scheduleProof']['cardClockFallback'].update(sourceDate='2026-10-30'),
            lambda row: row['scheduleProof']['cardClockFallback'].update(sourceUrl=page('9999').url),
            lambda row: row['scheduleProof']['cardClockFallback'].update(sourceUrl='https://attacker.test/6014934.html'),
            lambda row: row['scheduleProof']['cardClockFallback'].update(clockPolicy='explicit_event_offset'),
            lambda row: row['scheduleProof']['cardClockFallback'].update(extra='unbound'),
            lambda row: row['scheduleProof'].update(detailClock='2026-10-31T01:30:00'),
            lambda row: row['scheduleProof'].update(journalClock='2026-10-31T00:30:00'),
            lambda row: row['scheduleProof'].update(normalization={'method': 'invented'}),
            lambda row: row.update(source='rdj_multisport_analysis'),
        ]
        for change in mutations:
            changed = deepcopy(original)
            change(changed)
            with self.subTest(changed=changed):
                self.assertFalse(s.eligible(changed, DAY, NOW))

    def test_real_api_validator_accepts_both_detail_policies_without_fabricated_card_clock(self):
        root = Path(__file__).resolve().parents[3]
        for clock, policy in [('2026-10-31T00:30:00', 'rdj_detail_default_utc'),
                              ('2026-10-31T01:30:00+01:00', 'explicit_event_offset')]:
            item = self.ready(clock, policy)
            process = subprocess.run(['node', '-e',
                "let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>console.log(JSON.stringify(require('./tools/wintips-editorial-worker/validate-api-payload.cjs').validate(Buffer.concat(b),new Date(process.argv[1])))))",
                NOW.isoformat()], input=json.dumps({'source': 'rdj_petit_journal', 'editionDate': DAY, 'items': [item]}),
                cwd=root, text=True, capture_output=True, timeout=20, check=True)
            result = json.loads(process.stdout)
            self.assertTrue(result['passed'], result)
            self.assertEqual(result['itemCount'], 1)

    def test_abbreviated_24h_normalization_keeps_zero_minutes_in_next_day_proof(self):
        item = self.ready()
        proof = item['scheduleProof']
        proof.pop('cardClockFallback')
        item['startsAtUtc'] = proof['startsAtUtc'] = '2026-10-31T00:00:00Z'
        proof['journalClock'] = proof['detailClock'] = '2026-10-31T00:00:00'
        proof['normalization'] = {'method': 'rdj_24h_corroborated_v1', 'source_url': page().url,
            'raw': '31 octobre 2026 24h', 'reference': proof['journalClock'], 'normalized': proof['detailClock'],
            'candidates': ['2026-10-31T00:00:00', '2026-11-01T00:00:00']}
        self.assertTrue(s.eligible(item, DAY, NOW))
        for raw in ('31 octobre 2026 24h0', '31 octobre 2026 24h60', '31 octobre 2026 24:'):
            proof['normalization']['raw'] = raw
            with self.subTest(raw=raw):
                self.assertFalse(s.eligible(item, DAY, NOW))


if __name__ == '__main__':
    unittest.main()
