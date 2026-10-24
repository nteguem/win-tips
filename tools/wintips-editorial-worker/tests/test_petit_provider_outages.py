"""ESPN adjacent-day outages are distinct from a missing edition-day proof."""
from copy import deepcopy
import unittest

from editorial_worker.vendor.timing import OfficialKickoffs

BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.2/scoreboard?dates='
DAY = '2026-10-23'
FIXTURE = {'home': 'Nancy', 'away': 'Laval', 'sport': 'football', 'competition': 'Ligue 2'}


def document(two_ids=False):
    row = {'id': '401876713', 'date': DAY + 'T18:00Z', 'startDate': DAY + 'T18:00Z', 'timeValid': True,
           'status': {'type': {'state': 'pre', 'name': 'STATUS_SCHEDULED'}},
           'competitors': [{'type': 'team', 'homeAway': side, 'team': {'id': side, 'displayName': name}}
                           for side, name in [('home', 'AS Nancy Lorraine'), ('away', 'Stade Laval')]]}
    rows = [row, {**deepcopy(row), 'id': 'different-event'}] if two_ids else [row]
    return {'leagues': [{'slug': 'fra.2'}], 'events': [{'competitions': rows}]}


class ProviderOutageTests(unittest.TestCase):
    def test_unavailable_or_malformed_neighbors_keep_exact_current_day_proof(self):
        for failure in (TimeoutError('offline'), {'invalid': []}):
            with self.subTest(failure=type(failure).__name__):
                calls = []

                def fetch(url):
                    calls.append(url)
                    if url == BASE + '20261023':
                        return document()
                    if isinstance(failure, Exception):
                        raise failure
                    return failure

                resolver = OfficialKickoffs(fetch)
                for _ in range(2):
                    proof = resolver(FIXTURE, DAY)
                    self.assertEqual(proof['source_id'], '401876713')
                    self.assertEqual(proof['kickoff_utc'], '2026-10-23T18:00:00Z')
                self.assertEqual(len(calls), 3)

    def test_failed_edition_day_does_not_use_a_neighbor_as_complete_coverage(self):
        calls = []

        def fetch(url):
            calls.append(url)
            if url == BASE + '20261023':
                raise TimeoutError('offline')
            return document()

        resolver = OfficialKickoffs(fetch)
        self.assertIsNone(resolver(FIXTURE, DAY))
        self.assertIsNone(resolver(FIXTURE, DAY))
        self.assertEqual(calls.count(BASE + '20261023'), 1)

    def test_a_neighbor_outage_never_suppresses_observed_ambiguity(self):
        def fetch(url):
            if url.endswith('20261022'):
                raise TimeoutError('offline')
            return document(two_ids=True)

        self.assertIsNone(OfficialKickoffs(fetch)(FIXTURE, DAY))


if __name__ == '__main__':
    unittest.main()
