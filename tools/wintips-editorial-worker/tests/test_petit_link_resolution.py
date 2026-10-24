"""Archived 24 October bad-link recovery. No HTTP, model or publishing API."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from editorial_worker.vendor import rdj_collector as rdj

FIXTURE = Path(__file__).parent / 'fixtures/rdj-petit-20261024-excerpt.json'
DAY = '2026-10-24'
NOW = datetime(2026, 10, 24, 8, tzinfo=timezone.utc)
BAD = 'https://www.ruedesjoueurs.com/pronostic/nancy-laval-5803295.html'
GOOD = 'https://www.ruedesjoueurs.com/pronostic/saint-etienne-nantes-5803298.html'
OTHER = 'https://www.ruedesjoueurs.com/pronostic/saint-etienne-nantes-9999999.html'
LEAGUE = 'https://www.ruedesjoueurs.com/pronostics/ligue-2-937874.html'


class PredictionResolutionTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads(FIXTURE.read_text('utf-8'))
        self.pages = deepcopy(self.data['pages'])
        self.journal = next(url for url in self.pages if '/le-petit-journal/' in url)
        # Only the index wrapper is synthetic; every journal/detail fact is
        # from the separately hashed archived HTML excerpts.
        self.pages[rdj.INDEX_URL] = '<a href="' + self.journal + '">Petit Journal 24 octobre 2026</a>'
        self.calls = []

    def fetch(self, url):
        self.calls.append(url)
        return self.pages.get(url, rdj.FetchedPage(url, '', 404))

    def resolver(self, fixture, edition):
        self.assertEqual(edition, DAY)
        proof = deepcopy(self.data['kickoffProofs'].get(fixture['id'], self.data['kickoffProofs']['5803298']))
        self.assertIn('kickoff_local', fixture)
        return proof

    def collect(self):
        with patch.object(rdj, 'fetch_page', side_effect=AssertionError('network forbidden')):
            return rdj.collect_edition(DAY, self.fetch, kickoff_resolver=self.resolver, now=NOW)

    def blocked(self, code=None):
        result = self.collect()
        self.assertEqual(result['status'], 'source_incomplete')
        self.assertEqual(result['fixtures'], [])
        if code:
            self.assertIn(code, {issue['code'] for issue in result['issues']})
        return result

    def test_real_24_bad_link_resolves_unique_ordered_logos_date_league_and_schedule(self):
        result = self.collect()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual([f['id'] for f in result['fixtures']], ['5795487', '5803298'])
        self.assertEqual([(f['pick_fr'], f['odds']) for f in result['fixtures']],
                         [('Victoire Chelsea', 1.66), ('Victoire Saint-Etienne', 1.64)])
        self.assertEqual([f['kickoff_utc'] for f in result['fixtures']],
                         ['2026-10-24T16:30:00+00:00', '2026-10-24T18:45:00+00:00'])
        fixed = result['fixtures'][1]
        self.assertEqual((fixed['home'], fixed['away'], fixed['competition']), ('Saint-Étienne', 'Nantes', 'Ligue 2'))
        self.assertEqual(fixed['provenance']['prediction_link_resolution']['original_source_url'], BAD)
        self.assertEqual(fixed['provenance']['prediction_link_resolution']['original_error'], 'participant_mismatch')
        self.assertEqual(fixed['provenance']['prediction_link_resolution']['candidate_count'], 1)
        self.assertEqual(fixed['analysis_fr'], rdj._detail(rdj.FetchedPage(GOOD, self.pages[GOOD]))['analysis_fr'])
        self.assertEqual(len(self.calls), 5)

    def test_good_original_links_need_no_discovery_or_additional_requests(self):
        self.pages[self.journal] = self.pages[self.journal].replace('/pronostic/nancy-laval-5803295.html', GOOD)
        result = self.collect()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(len(self.calls), 4)
        self.assertNotIn('prediction_link_resolution', result['fixtures'][1]['provenance'])

    def test_no_logo_bound_candidate_keeps_the_original_rejection(self):
        self.pages[BAD] = self.pages[BAD].replace(GOOD, '/not-an-event')
        self.blocked('participant_mismatch')
        self.assertNotIn(GOOD, self.calls)

    def test_a_plain_unbound_link_is_not_enough_to_replace_a_card(self):
        self.pages[BAD] = re.sub(r'<aside>.*?</aside>', '<aside><a href="' + GOOD + '">Saint-Etienne Nantes</a></aside>', self.pages[BAD], flags=re.S)
        self.blocked('participant_mismatch')

    def test_replacement_must_keep_ordered_participants_competition_sport_and_time(self):
        original = rdj._detail
        changes = [{'participant_logos': ['9830', '9853']}, {'home': 'Lyon'}, {'competition': 'Ligue 1'},
                   {'sport': 'basketball'}, {'kickoff': datetime(2026, 10, 25, 20, 45)},
                   {'kickoff': datetime(2026, 10, 24, 19, 45)}]
        for changed in changes:
            with self.subTest(changed=changed):
                def mutated(page):
                    detail = original(page)
                    return {**detail, **changed} if page.url == GOOD else detail
                with patch.object(rdj, '_detail', side_effect=mutated):
                    self.blocked('participant_mismatch')

    def test_two_fully_matching_articles_are_ambiguous(self):
        body = self.pages[BAD]
        end = body.rindex('</aside>')
        links = body[body.rindex('<aside>') + 7:end]
        self.pages[BAD] = body[:end] + links.replace(GOOD, OTHER) + body[end:]
        self.pages[OTHER] = self.pages[GOOD]
        self.blocked('prediction_resolution_ambiguous')

    def test_unavailable_logo_bound_candidate_cannot_be_silently_dropped(self):
        self.pages.pop(GOOD)
        self.blocked('prediction_resolution_incomplete')

    def test_exact_named_league_index_is_bounded_fallback(self):
        body = self.pages[BAD]
        link_start = body.rindex('<aside>') + len('<aside>')
        link_end = body.rindex('</aside>')
        links = body[link_start:link_end]
        self.pages[BAD] = body[:link_start] + '<a href="' + LEAGUE + '">Ligue 2</a>' + body[link_end:]
        self.pages[LEAGUE] = '<main>' + links + '</main>'
        result = self.collect()
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(self.calls.count(LEAGUE), 1)
        self.assertLessEqual(len(self.calls), 6)

    def test_nine_logo_bound_candidates_hit_limit_before_any_candidate_request(self):
        body = self.pages[BAD]
        start, end = body.rindex('<aside>'), body.rindex('</aside>')
        links = body[start + 7:end]
        many = ''.join(links.replace(GOOD, GOOD.replace('5803298', str(9000000 + index))) for index in range(9))
        self.pages[BAD] = body[:start] + '<aside>' + many + '</aside></body></html>'
        self.blocked('prediction_resolution_limit')
        self.assertFalse(any('900000' in url for url in self.calls))

    def test_excerpt_provenance_hashes_match_exact_utf8(self):
        for source in self.data['sources']:
            self.assertEqual(hashlib.sha256(self.data['pages'][source['sourceUrl']].encode()).hexdigest(), source['excerptUtf8Sha256'])
            self.assertRegex(source['rawUtf8Sha256'], r'^[0-9a-f]{64}$')
        nancy = next(source for source in self.data['sources'] if source['sourceUrl'] == BAD)
        self.assertTrue(nancy['retrievedAtUtc'].startswith('2026-10-23'))

    def test_wintips_typed_adapter_keeps_journal_market_and_complete_french_analysis(self):
        from editorial_worker import sources
        owner = self

        class Offline:
            def html(self, url):
                value = owner.fetch(url)
                return rdj.FetchedPage(url, value) if isinstance(value, str) else value

        result = sources.collect_petit(DAY, Offline(), now=NOW, resolver=self.resolver)
        self.assertEqual(result['status'], 'ready', result['issues'])
        self.assertEqual([item['sourceId'] for item in result['items']], ['5795487', '5803298'])
        self.assertEqual([item['selection']['odds'] for item in result['items']], [1.66, 1.64])
        self.assertEqual(result['items'][1]['teams']['home']['name'], 'Saint-Étienne')
        self.assertEqual(result['items'][1]['sourceUrl'], self.journal)
        expected = rdj._detail(rdj.FetchedPage(GOOD, self.pages[GOOD]))['analysis_paragraphs']
        self.assertEqual(result['items'][1]['analysis']['fr'][0]['paragraphs'], expected)
        self.assertNotIn('en', result['items'][1]['analysis'])


if __name__ == '__main__':
    unittest.main()
