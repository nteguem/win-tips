"""Archived source defects only; no network, translation or publication."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from editorial_worker.vendor import rdj_collector as rdj
import test_petit_link_resolution as replay

FIXTURE = Path(__file__).parent / 'fixtures/source-quality-20261024.json'


class SourceCanonicalizationTests(unittest.TestCase):
    def setUp(self):
        self.case = json.loads(FIXTURE.read_bytes())['cases']['lexical']

    def test_real_source_typo_only_changes_uns_and_keeps_raw_and_every_numeral(self):
        raw = self.case['rawParagraphs']; before = deepcopy(raw)
        canonical, audit = rdj._canonical_analysis(raw, self.case['sourceUrl'], '<raw-html-retained>')
        self.assertEqual(raw, before)
        self.assertEqual(canonical, [paragraph.replace('uns seul point', 'un seul point') for paragraph in raw])
        self.assertEqual(audit['rawParagraphs'], raw)
        self.assertEqual(audit['canonicalParagraphs'], canonical)
        self.assertEqual(audit['rawAnalysisSha256'], hashlib.sha256('\n\n'.join(raw).encode()).hexdigest())
        self.assertEqual(audit['canonicalAnalysisSha256'], hashlib.sha256('\n\n'.join(canonical).encode()).hexdigest())
        self.assertEqual(re.findall(r'\d+', '\n'.join(raw)), re.findall(r'\d+', '\n'.join(canonical)))
        self.assertEqual(len(audit['changes']), 1)
        edit = audit['changes'][0]
        self.assertEqual(edit['rule'], 'uns_seul_point_v1')
        self.assertEqual(raw[edit['paragraphIndex']][edit['offset']:edit['offset'] + len(edit['before'])], 'uns seul point')

    def test_closed_lexical_bounds_do_not_rewrite_other_typos_names_units_or_numbers(self):
        for value in ('uns seul points', 'uns seul pointage', 'uns seul point-depart', 'uns seul but',
                'uns deux points', 'UNS seul point', 'Uns Seul Point', 'bruns seul point',
                'les uns et les autres', '3 seuls points', 'un seul point', 'uns  seul point'):
            with self.subTest(value=value):
                canonical, audit = rdj._canonical_analysis([value], 'https://unused.invalid', value)
                self.assertEqual(canonical, [value]); self.assertIsNone(audit)

    def test_multiple_edits_offsets_are_explicit_unicode_and_replay_is_idempotent(self):
        raw = ['\u00c9quipe avec uns seul point, puis uns seul point.']
        canonical, audit = rdj._canonical_analysis(raw, 'https://unused.invalid', 'unchanged HTML')
        self.assertEqual(len(audit['changes']), 2)
        self.assertEqual(audit['rawHtmlSha256'], hashlib.sha256(b'unchanged HTML').hexdigest())
        for edit in audit['changes']:
            self.assertEqual(raw[0][edit['offset']:edit['offset'] + len(edit['before'])], edit['before'])
            self.assertEqual(canonical[0][edit['canonicalOffset']:edit['canonicalOffset'] + len(edit['after'])], edit['after'])
        self.assertEqual(rdj._canonical_analysis(canonical, 'https://unused.invalid', 'unchanged HTML'), (canonical, None))

    def test_real_ambiguous_score_and_all_other_numbers_are_never_corrected(self):
        case = json.loads(FIXTURE.read_bytes())['cases']['numeric']
        original = deepcopy(case['rawParagraphs'])
        canonical, audit = rdj._canonical_analysis(original, case['sourceUrl'], 'literal (0-1)3 Ce qui')
        self.assertEqual(canonical, original); self.assertIsNone(audit)
        self.assertTrue(any('(0-1)3 Ce qui' in value for value in canonical))
        for value in ('(0-1) 3 points', '(0-1)3e match', 'Chapitre 3 : score (0-1).', '(0-1)<sup>3</sup> Ce qui'):
            self.assertEqual(rdj._canonical_analysis([value], 'https://unused.invalid', value), ([value], None))

    def test_detail_propagates_source_audit_without_changing_match_facts(self):
        helper = replay.PredictionResolutionTests(); helper.setUp()
        html = helper.pages[replay.GOOD]
        before = html
        detail = rdj._detail(rdj.FetchedPage(replay.GOOD, html))
        self.assertEqual(html, before)
        self.assertEqual((detail['home'], detail['away'], detail['competition']), ('Saint-\u00c9tienne', 'Nantes', 'Ligue 2'))
        self.assertEqual(detail['participant_logos'], ['9853', '9830'])
        audit = detail['source_canonicalization_audit']
        self.assertEqual(audit['rawHtmlSha256'], hashlib.sha256(html.encode()).hexdigest())
        self.assertTrue(any('uns seul point' in value for value in audit['rawParagraphs']))
        self.assertTrue(any('un seul point' in value for value in detail['analysis_paragraphs']))
        self.assertEqual(detail['analysis_fr'], '\n\n'.join(audit['canonicalParagraphs']))

    def test_journal_packet_keeps_audit_in_provenance_and_same_choices_prices_clocks(self):
        helper = replay.PredictionResolutionTests(); helper.setUp()
        source_pages = deepcopy(helper.pages)
        result = helper.collect()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(helper.pages, source_pages)
        self.assertEqual([row['id'] for row in result['fixtures']], ['5795487', '5803298'])
        self.assertEqual([row['odds'] for row in result['fixtures']], [1.66, 1.64])
        self.assertEqual([row['kickoff_utc'] for row in result['fixtures']],
            ['2026-10-24T16:30:00+00:00', '2026-10-24T18:45:00+00:00'])
        self.assertNotIn('source_canonicalization', result['fixtures'][0]['provenance'])
        self.assertEqual(result['fixtures'][1]['provenance']['source_canonicalization']['canonicalParagraphs'],
            result['fixtures'][1]['provenance']['analysis_paragraphs_fr'])


if __name__ == '__main__': unittest.main()
