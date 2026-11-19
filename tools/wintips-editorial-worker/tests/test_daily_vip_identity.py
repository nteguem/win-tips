"""Identity boundaries for author recommendations and separate odds pages."""
import unittest

from editorial_worker.daily_vip_identity import (
    participant_aliases, recommendation_fixture_matches, resolve_participant, same_participants,
)


def teams(home, away):
    return {'home': {'name': home}, 'away': {'name': away}}


class DailyVipIdentityTests(unittest.TestCase):
    def test_observed_nba_nicknames_are_exact_and_sport_scoped(self):
        for full, short in [('Toronto Raptors', 'Raptors'), ('Dallas Mavericks', 'Mavericks'),
                            ('Detroit Pistons', 'Pistons')]:
            expected = teams(full, 'Boston Celtics')
            with self.subTest(full=full):
                self.assertTrue(same_participants(teams(short, 'Celtics'), expected, 'basketball'))
                self.assertEqual(resolve_participant(short, expected, 'basketball'), 'home')
                self.assertFalse(same_participants(teams(short, 'Celtics'), expected, 'football'))
                for other in [short + ' U21', short + ' B', full.split()[0]]:
                    self.assertIsNone(resolve_participant(other, expected, 'basketball'))

    def test_observed_botafogo_and_grenoble_names_keep_the_proven_fixture(self):
        self.assertTrue(recommendation_fixture_matches('Corinthians - Botafogo RJ',
                        teams('Corinthians', 'Botafogo'), 'football'))
        self.assertFalse(recommendation_fixture_matches('Corinthians - Botafogo SP',
                         teams('Corinthians', 'Botafogo'), 'football'))
        self.assertTrue(recommendation_fixture_matches('Grenoble - Provence Rugby',
                        teams('Grenoble Rugby', 'Provence Rugby'), 'rugby'))
        self.assertFalse(recommendation_fixture_matches('Grenoble - Provence Rugby',
                         teams('Grenoble Rugby', 'Provence Rugby'), 'football'))

    def test_observed_womens_editorial_names_resolve_only_in_the_proven_fixture(self):
        paris = teams('Paris FC F', 'HB Koege F')
        barca = teams('Barcelone F', 'Servette FC Chênois F')
        self.assertTrue(recommendation_fixture_matches('Paris FC - Koge', paris, 'football'))
        self.assertTrue(recommendation_fixture_matches('FC Barcelone - Servette FC', barca, 'football'))
        self.assertEqual(resolve_participant('Koge', paris, 'football'), 'away')
        self.assertEqual(resolve_participant('Servette FC', barca, 'football'), 'away')
        self.assertTrue(same_participants(teams('Paris FC Women', 'Koge F'), paris, 'football'))
        self.assertTrue(same_participants(teams('FC Barcelone F', 'Servette FC F'), barca, 'football'))
        self.assertFalse(same_participants(teams('Paris FC', 'Koge'), paris, 'football'))
        self.assertFalse(same_participants(teams('FC Barcelone', 'Servette FC'), barca, 'football'))
        self.assertFalse(same_participants(teams('Paris FC F', 'Koge F'), paris, 'basketball'))

    def test_womens_only_aliases_do_not_merge_unmarked_clubs_youth_or_reserves(self):
        for full, short in [('HB Koege', 'Koge'), ('Servette FC Chênois', 'Servette FC')]:
            with self.subTest(full=full):
                self.assertFalse(same_participants(teams(full, 'Chelsea'), teams(short, 'Chelsea'), 'football'))
                for suffix in [' U21 F', ' II F', ' B F', ' Réserves F']:
                    expected = teams(full + suffix, 'Paris FC F')
                    self.assertIsNone(resolve_participant(short, expected, 'football'))
                    self.assertFalse(recommendation_fixture_matches(short + ' - Paris FC', expected, 'football'))

    def test_explicit_nba_aliases_preserve_event_order(self):
        expected = teams('Los Angeles Clippers', 'Boston Celtics')
        self.assertTrue(same_participants(teams('LA Clippers', 'Celtics'), expected, 'basketball'))
        self.assertFalse(same_participants(teams('Boston Celtics', 'Clippers'), expected, 'basketball'))
        self.assertEqual(resolve_participant('Clippers', expected, 'basketball'), 'home')
        self.assertEqual(resolve_participant('Celtics', expected, 'basketball'), 'away')

    def test_similar_city_and_different_nba_team_do_not_match(self):
        expected = teams('LA Clippers', 'Boston Celtics')
        for other in ('LA Lakers', 'Los Angeles', 'Los Angeles Clippers U21', 'Clippers reserve'):
            with self.subTest(other=other):
                self.assertIsNone(resolve_participant(other, expected, 'basketball'))
        self.assertFalse(same_participants(teams('Lakers', 'Celtics'), expected, 'basketball'))

    def test_club_suffix_changes_are_catalogue_scoped(self):
        self.assertIn('besiktas', participant_aliases('Beşiktaş JK', 'football'))
        self.assertIn('besiktas jk', participant_aliases('Besiktas', 'football'))
        self.assertIn('besiktasjk', participant_aliases('Beşiktaş JK', 'football'))
        self.assertNotEqual(participant_aliases('Unknown FC', 'football'), participant_aliases('Unknown', 'football'))
        self.assertFalse(same_participants(teams('Besiktas', 'Chelsea'), teams('Besiktas JK', 'Chelsea'), 'tennis'))

    def test_no_inferred_historical_alias(self):
        self.assertFalse(same_participants(teams('BK Häcken', 'Chelsea F'),
                                           teams('KS Goeteborg', 'Chelsea F'), 'football'))

    def test_typography_accents_nonbreaking_space_and_dashes_are_not_identity_changes(self):
        self.assertTrue(same_participants(teams('Bosnie-Herzégovine', 'Côte d’Ivoire'),
                                          teams('Bosnie Herzegovine', "Cote d'Ivoire"), 'football'))
        expected = teams('Paris Saint-Germain', 'Real Madrid')
        for raw in ('Paris Saint-Germain — Real\u00a0Madrid', 'Paris SG-Real Madrid',
                    'PSG vs. Real Madrid', 'Paris SG contre Real Madrid'):
            with self.subTest(raw=raw):
                self.assertTrue(recommendation_fixture_matches(raw, expected, 'football'))

    def test_whole_name_matching_rejects_substrings_and_unrelated_prose(self):
        expected = teams('Real Madrid', 'Chelsea')
        for raw in ('Madrid', 'Real', 'Real Madrid gagne', 'le Real Madrid', 'Chelsea et Real Madrid'):
            with self.subTest(raw=raw):
                self.assertIsNone(resolve_participant(raw, expected, 'football'))
        for raw in ('Real Madrid Chelsea', 'Real Madrid - Chelsea ce soir',
                    'Avant Real Madrid - Chelsea', 'Chelsea - Real Madrid'):
            with self.subTest(raw=raw):
                self.assertFalse(recommendation_fixture_matches(raw, expected, 'football'))

    def test_womens_marker_omission_only_within_source_proven_fixture(self):
        expected = teams('Real Madrid F', 'Chelsea F')
        self.assertEqual(resolve_participant('Real Madrid', expected, 'football'), 'home')
        self.assertEqual(resolve_participant('Chelsea FC', expected, 'football'), 'away')
        self.assertTrue(recommendation_fixture_matches('Real Madrid - Chelsea', expected, 'football'))
        self.assertFalse(same_participants(teams('Real Madrid', 'Chelsea'), expected, 'football'))
        self.assertFalse(participant_aliases('Real Madrid', 'football') & participant_aliases('Real Madrid F', 'football'))

    def test_explicit_gender_markers_are_equivalent_but_not_mens_clubs(self):
        expected = teams('Chelsea F', 'Paris SG F')
        self.assertTrue(same_participants(teams('Chelsea Women', 'PSG Féminines'), expected, 'football'))
        self.assertTrue(recommendation_fixture_matches('Chelsea - Paris Saint-Germain', expected, 'football'))
        self.assertEqual(resolve_participant('Paris SG F', expected, 'football'), 'away')
        self.assertIsNone(resolve_participant('Chelsea F', teams('Chelsea', 'PSG'), 'football'))

    def test_explicit_gender_never_changes_an_unmarked_source_fixture(self):
        expected = teams('Real Madrid', 'Chelsea')
        self.assertFalse(recommendation_fixture_matches('Real Madrid F - Chelsea F', expected, 'football'))
        self.assertIsNone(resolve_participant('Real Madrid Women', expected, 'football'))

    def test_ambiguous_omitted_gender_is_rejected(self):
        expected = teams('Real Madrid F', 'Real Madrid')
        self.assertIsNone(resolve_participant('Real Madrid', expected, 'football'))
        self.assertEqual(resolve_participant('Real Madrid F', expected, 'football'), 'home')
        self.assertFalse(recommendation_fixture_matches('Real Madrid - Real Madrid', expected, 'football'))

    def test_reserve_youth_and_suffixes_never_disappear(self):
        for qualified in ('Chelsea U21', 'Chelsea B', 'Chelsea II', 'Chelsea Réserves', 'Chelsea U19 F'):
            with self.subTest(qualified=qualified):
                expected = teams(qualified, 'Paris SG F')
                self.assertIsNone(resolve_participant('Chelsea', expected, 'football'))
                self.assertFalse(same_participants(teams('Chelsea', 'PSG F'), expected, 'football'))

    def test_aliases_are_sport_scoped(self):
        self.assertEqual(participant_aliases('Clippers', 'football'), {'clippers'})
        self.assertFalse(same_participants(teams('Clippers', 'Celtics'),
                                           teams('LA Clippers', 'Boston Celtics'), 'football'))
        self.assertEqual(resolve_participant('Lakers', teams('LA Lakers', 'Celtics'), {'key': 'basketball'}), 'home')

    def test_invalid_missing_and_duplicate_participants_are_rejected(self):
        for malformed in (None, '', {}, {'home': {'name': 'Chelsea'}}, ['Chelsea'], ['Chelsea', None]):
            with self.subTest(malformed=malformed):
                self.assertFalse(same_participants(malformed, teams('Chelsea', 'PSG'), 'football'))
                self.assertIsNone(resolve_participant('Chelsea', malformed, 'football'))
                self.assertFalse(recommendation_fixture_matches('Chelsea - PSG', malformed, 'football'))
        self.assertFalse(same_participants(teams('Celtics', 'Boston Celtics'),
                                           teams('Celtics', 'Boston Celtics'), 'basketball'))
        self.assertIsNone(resolve_participant('Celtics', teams('Celtics', 'Boston Celtics'), 'basketball'))

    def test_two_item_sequences_are_supported_without_reordering(self):
        self.assertTrue(same_participants(['Besiktas JK', 'PSG'], ['Besiktas', 'Paris SG'], 'football'))
        self.assertFalse(same_participants(['PSG', 'Besiktas JK'], ['Besiktas', 'Paris SG'], 'football'))


if __name__ == '__main__':
    unittest.main()
