"""Source quality exclusions/storage only. No HTTP, model, API or provider."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from editorial_worker import sources, runner
from test_bilingual_runner import arguments
import test_petit_link_resolution as replay

NOW = datetime(2026, 10, 24, 8, tzinfo=timezone.utc)
FIXTURE = Path(__file__).parent / 'fixtures/source-quality-20261024.json'


class SourceQualityCollectionTests(unittest.TestCase):
    def raw(self): return json.loads(FIXTURE.read_bytes())['cases']['numeric']['rawParagraphs']

    def test_exact_archived_orphan_is_detected_but_not_rewritten(self):
        raw = self.raw(); original = deepcopy(raw)
        found = sources._ambiguous_numeric_typos(raw)
        self.assertEqual(raw, original)
        self.assertEqual(len(found), 1)
        hit = found[0]
        self.assertEqual(hit['excerpt'], '(0-1)3')
        self.assertEqual(raw[hit['paragraphIndex']][hit['offset']:hit['offset'] + len(hit['excerpt'])], hit['excerpt'])

    def test_real_scores_counts_chapter_ordinals_and_explicit_notes_are_preserved(self):
        for paragraph in ('score (0-1). Ce qui explique 3 points.', '(0-1) 3 points plus tard.',
                '(0-1)3e match', 'Chapitre 3 : score (0-1).', '(0-1), 3. Ce chapitre',
                'Il a gagn\u00e9 (3-0) puis (2-1).', 'Il a gagn\u00e9 (0-1).'):
            with self.subTest(paragraph=paragraph): self.assertEqual(sources._ambiguous_numeric_typos([paragraph]), [])
        html = '<div><h2>L\u2019\u00e9tat de forme</h2><p>Score (0-1)<sup>3</sup> Ce qui reste une note.</p></div>'
        _, paragraphs = sources.rdj._analysis(sources.rdj.Document(html).root)
        self.assertIn('3', paragraphs[0])
        self.assertEqual(sources._ambiguous_numeric_typos(paragraphs), [])

    def collect_case(self, *, only_bad=False):
        bad = 'https://www.ruedesjoueurs.com/pronostic/arsenal-everton-5795485.html'
        good = 'https://www.ruedesjoueurs.com/pronostic/chelsea-tottenham-5795487.html'
        urls = [bad] if only_bad else [bad, good]
        index = '<div>' + ''.join('<a href="' + url + '">Lire l\u2019analyse</a>' for url in urls) + '</div>'
        class Fetch:
            def html(self, url): return sources.rdj.FetchedPage(url, index if url == sources.SOURCES['rdj_football_analysis'] else '<unaltered-source>')
        details = {url: {'sport': 'football', 'kickoff': datetime(2026, 10, 24, 18, tzinfo=timezone.utc),
            'analysis_paragraphs': self.raw() if url == bad else ['Victoire (1-0). Ce qui fait 3 points.']} for url in urls}
        before = deepcopy(details)
        # Timing/identity/catalogue contracts have their own real fixture tests;
        # this mock isolates continuation and guarantees the bad row never
        # reaches match_item or any translator/publication path.
        calls = []
        def item(detail, page, *args, **kwargs):
            calls.append(page.url)
            return {'sourceId': '5795487', 'startsAtUtc': '2026-10-24T18:00:00Z', 'status': 'upcoming'}
        with patch.object(sources.rdj, '_detail', side_effect=lambda page: details[page.url]), \
                patch.object(sources, 'match_item', side_effect=item):
            result = sources.collect_football('2026-10-24', Fetch(), now=NOW, resolver=None, limit=1)
        self.assertEqual(details, before)
        return result, calls, bad, good

    def test_bad_article_skipped_next_candidate_used_without_aborting_source(self):
        result, calls, bad, good = self.collect_case()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(calls, [good])
        self.assertEqual(len(result['items']), 1)
        self.assertEqual(result['issues'][0]['code'], 'ambiguous_numeric_typo')
        self.assertEqual(result['issues'][0]['url'], bad)
        self.assertEqual(result['issues'][0]['locations'][0]['excerpt'], '(0-1)3')

    def test_only_bad_candidate_is_not_a_global_error_or_rewritten_article(self):
        result, calls, _, _ = self.collect_case(only_bad=True)
        self.assertEqual(result['items'], [])
        self.assertEqual(result['status'], 'source_absent')
        self.assertEqual(result['issues'][0]['code'], 'ambiguous_numeric_typo')
        self.assertEqual(calls, [])

    def real_petit(self):
        helper = replay.PredictionResolutionTests(); helper.setUp()
        class Fetch:
            requests = 0
            records = []
            def html(self, url):
                raw = helper.pages[url]
                return raw if isinstance(raw, sources.rdj.FetchedPage) else sources.rdj.FetchedPage(url, raw)
        before = deepcopy(helper.pages)
        result = sources.collect_petit('2026-10-24', Fetch(), now=NOW, resolver=helper.resolver)
        self.assertEqual(helper.pages, before)
        return result

    def test_real_petit_typed_items_keep_audit_outside_strict_api_payload(self):
        result = self.real_petit()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual([row['sourceId'] for row in result['items']], ['5795487', '5803298'])
        self.assertEqual([row['selection']['odds'] for row in result['items']], [1.66, 1.64])
        self.assertEqual(len(result['sourceCanonicalizationAudits']), 1)
        self.assertNotIn('source_canonicalization_audit', result['items'][1])
        self.assertIn('un seul point', result['items'][1]['analysis']['fr'][0]['paragraphs'][2])

    def test_runner_persists_private_bound_audit_without_payload_additions_or_api(self):
        result = self.real_petit(); before = deepcopy(result)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runner, 'collect', return_value=result), \
                patch.object(runner, 'make_translator', side_effect=AssertionError('no inference')), \
                patch.object(runner, 'ApiClient', side_effect=AssertionError('no API')):
            report = runner.run(arguments(directory, edition='2026-10-24', source=['rdj_petit_journal'], api_base=None),
                fetcher=object(), now=NOW, clock=lambda: NOW)
            row = report['sources'][0]
            path = Path(row['sourceNormalizationAuditFile'])
            self.assertTrue(path.is_file())
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), row['sourceNormalizationAuditSha256'])
            audit = json.loads(path.read_bytes())
            self.assertEqual(audit['audits'], result['sourceCanonicalizationAudits'])
            payload = json.loads(Path(row['payloadFile']).read_bytes())
            self.assertEqual(set(payload), {'source', 'editionDate', 'items'})
            self.assertEqual(payload['items'], result['items'])
            self.assertFalse(report['published']); self.assertFalse(report['notificationsSent'])
        self.assertEqual(result, before)


if __name__ == '__main__': unittest.main()
