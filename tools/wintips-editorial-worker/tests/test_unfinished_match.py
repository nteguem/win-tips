import json
from pathlib import Path
import unittest

from editorial_worker.translation import _fixture, _prompt, validate_english_sentence
from editorial_worker.vendor import rdj_translation as guard


FIXTURE = Path(__file__).parent / 'fixtures/first-timer-football-20261024.json'


class UnfinishedMatchTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads(FIXTURE.read_bytes().decode('utf-8'))
        self.item = {'sport': {'key': 'football'}, 'editionDate': '2026-10-24',
                     'teams': {'home': {'name': 'Rayo Vallecano'}, 'away': {'name': 'Elche'}}}

    def check(self, source, target, expected=True):
        _, proof = validate_english_sentence(source, target, self.item)
        self.assertEqual(proof['passed'], expected, proof)
        return proof

    def stopped(self):
        return next(row for row in self.fixture['responses'] if row['nativeFile'].endswith('94f072e64af60b08f4f17631321152e1ada64cb212d096845711cecb3a9bf891.json'))

    def test_all_six_exact_native_source_target_pairs_keep_the_canonical_name_rule(self):
        self.assertEqual(len(self.fixture['responses']), 6)
        self.assertEqual(self.fixture['frenchPayloadSha256'], 'ad72e79cd56157bed333fd387523dc950f455a3e5ded10499efb8928b523fbb5')
        for row in self.fixture['responses']:
            self.assertEqual(len(row['nativeSha256']), 64)
            self.assertNotIn('Ã', row['source'])
            self.check(row['source'], row['target'], row['expectedPassedAfterFix'])
        home = next(row for row in self.fixture['responses'] if 'Butarque' in row['source'])
        self.assertIn('à domicile', home['source'])
        self.assertIn('rénovations', home['source'])

    def test_noncompletion_is_a_named_match_event_with_causal_incidents(self):
        row = self.stopped()
        proof = self.check(row['source'], row['target'])
        anchor = next(a for a in proof['anchors'] if a['kind'] == 'unfinished_match')
        self.assertEqual(anchor['source'], 'ne pas aller à son terme')
        self.assertEqual(anchor['unfinished_match_scope']['opponent'], 'Athletic Bilbao')
        self.assertEqual(anchor['unfinished_match_scope']['sourceCause'], 'suite aux incidents')
        for cause in ('because of incidents', 'following incidents'):
            self.check(row['source'], row['target'].replace('due to incidents', cause))

    def test_completion_or_negated_interruption_cannot_replace_unfinished_event(self):
        row = self.stopped()
        for wrong in ('ended', 'finished', 'completed', 'ended normally', 'finished normally',
                      'was completed normally', 'was not cut short', 'did not get cut short',
                      'was never cut short', 'was not abandoned'):
            self.check(row['source'], row['target'].replace('was cut short', wrong), False)
        self.check(row['source'], row['target'].replace('due to incidents', 'due to incidents but completed normally'), False)
        for appended in (' The match was completed normally.', ' The match finished normally.', ' It ended normally.'):
            self.check(row['source'], row['target'] + appended, False)

    def test_cut_short_on_fans_coach_or_another_match_does_not_satisfy_named_match(self):
        row = self.stopped()
        for wrong in ('its match against Athletic Bilbao finished, while its supporters were cut short',
                      'its supporters against Athletic Bilbao were cut short',
                      'its coach against Athletic Bilbao was cut short',
                      'its match against Athletic Bilbao ended before another match was cut short'):
            self.check(row['source'], row['target'].replace('its match against Athletic Bilbao was cut short', wrong), False)
        self.check(row['source'], row['target'].replace('Athletic Bilbao', 'Osasuna'), False)
        self.check(row['source'], row['target'].replace('due to incidents', 'despite incidents'), False)
        self.check(row['source'], row['target'].replace('due to incidents', 'due to renovations'), False)
        self.check(row['source'], row['target'].replace('involving the fans', 'unrelated to the fans'), False)
        self.check(row['source'], row['target'].replace('involving the fans', 'involving the referee'), False)
        for inserted in ('they denied that ', 'they alleged that ', 'they reported falsely that '):
            self.check(row['source'], row['target'].replace('before its match', 'before ' + inserted + 'its match'), False)
        for preface in ('It was alleged that ', 'It was falsely reported that ', 'It was untrue that '):
            self.check(row['source'], preface + row['target'], False)

    def test_source_scope_requires_a_match_a_named_opponent_and_incident_causation(self):
        row = self.stopped()
        for changed in (row['source'].replace("match contre l'Athletic Bilbao", "stage contre l'Athletic Bilbao"),
                        row['source'].replace("match contre l'Athletic Bilbao", "match contre l'Athletic Bilbao et les supporters"),
                        row['source'].replace('suite aux incidents', 'sans incidents'),
                        row['source'].replace('suite aux incidents', 'suite aux travaux')):
            _, anchors = guard._protect(changed, _fixture(self.item))
            self.assertFalse(any(a['kind'] == 'unfinished_match' for a in anchors))
        changed = row['source'].replace('ne pas aller à son terme', 'aller à son terme')
        _, anchors = guard._protect(changed, _fixture(self.item))
        self.assertFalse(any(a['kind'] == 'unfinished_match' for a in anchors))

    def test_other_source_negations_remain_mandatory(self):
        source = "Le match contre l'Athletic Bilbao ne pas aller à son terme suite aux incidents, sans perdre de temps."
        good = 'The match against Athletic Bilbao was cut short due to incidents, without losing time.'
        self.check(source, good)
        self.check(source, good.replace('without losing time', 'losing time'), False)
        ordinary = 'Le match ne se termine pas.'
        self.check(ordinary, 'The match does not end.')
        self.check(ordinary, 'The match ends.', False)

    def test_home_matches_equivalence_is_bound_to_the_source_match_noun_and_number(self):
        row = next(row for row in self.fixture['responses'] if 'Butarque' in row['source'])
        good = 'Rayo Vallecano was playing its home matches at Butarque while Vallecas underwent urgent renovations.'
        self.check(row['source'], good)
        for noun in ('games', 'fixtures'):
            self.check(row['source'], good.replace('matches', noun))
        for bad in (good.replace('home matches', 'away matches'), good.replace('home matches', 'home match'),
                    good.replace('Butarque', 'Madrid'), good.replace('Rayo Vallecano', 'Elche')):
            self.check(row['source'], bad, False)
        self.check('Son match à domicile compte.', 'Its home match counts.')
        self.check('Son match à domicile compte.', 'Its home matches count.', False)
        self.check('Ils gagnent à domicile.', 'They win home matches.', False)

    def test_prompt_preserves_french_bytes_and_names_without_rewriting_source(self):
        row = self.stopped()
        masked, anchors = guard._protect(row['source'], _fixture(self.item))
        self.assertEqual(_prompt(masked, anchors).rpartition('\n\n\n')[2], row['source'])
        self.assertTrue(any(a['kind'] == 'name' and a['source'] == 'Barcelone' for a in anchors))


if __name__ == '__main__':
    unittest.main()
