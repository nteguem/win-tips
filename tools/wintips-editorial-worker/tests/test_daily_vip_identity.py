"""Identity boundaries for author recommendations and separate odds pages."""
import unittest

from editorial_worker.daily_vip_identity import (
    _NBA_ALIASES, participant_aliases, recommendation_fixture_matches, resolve_participant, same_participants,
)


def teams(home, away):
    return {'home': {'name': home}, 'away': {'name': away}}


class DailyVipIdentityTests(unittest.TestCase):
    def test_all_thirty_current_nba_franchises_have_distinct_sport_scoped_aliases(self):
        self.assertEqual(len(_NBA_ALIASES), 30)
        seen = set()
        for group in _NBA_ALIASES:
            full = group[0]
            expected = teams(full, 'Distinct opponent')
            full_aliases = participant_aliases(full, 'basketball')
            self.assertTrue(seen.isdisjoint(full_aliases), full)
            seen |= full_aliases
            for alias in group[1:]:
                with self.subTest(full=full, alias=alias):
                    self.assertTrue(same_participants(teams(alias, 'Distinct opponent'), expected, 'basketball'))
                    self.assertEqual(resolve_participant(alias, expected, 'basketball'), 'home')
                    self.assertIsNone(resolve_participant(alias, expected, 'football'))
                    for suffix in (' U21', ' B', ' II', ' Women', ' F', ' Réserves'):
                        self.assertIsNone(resolve_participant(alias + suffix, expected, 'basketball'))
                        self.assertIsNone(resolve_participant(alias, teams(full + suffix, 'Distinct opponent'), 'basketball'))

    def test_nba_french_names_nicknames_and_ambiguous_aliases(self):
        expected = teams('Philadelphie 76ers', 'Miami Heat')
        self.assertTrue(recommendation_fixture_matches('Philadelphie Sixers - Heat', expected, 'basketball'))
        self.assertTrue(same_participants(teams('Philadelphia 76ers', 'Heat'), expected, 'basketball'))
        self.assertEqual(resolve_participant('Sixers', expected, 'basketball'), 'home')
        self.assertIsNone(resolve_participant('Philadelphie', expected, 'basketball'))
        self.assertIsNone(resolve_participant('Sixers', teams('Philadelphia 76ers', 'Philadelphie Sixers'), 'basketball'))
        self.assertFalse(same_participants(teams('Sixers', 'Philadelphie 76ers'),
                                          teams('Philadelphia 76ers', 'Sixers'), 'basketball'))
        self.assertTrue(same_participants(teams('La Nouvelle-Orléans Pelicans', 'Knicks'),
                                         teams('New Orleans Pelicans', 'New York Knicks'), 'basketball'))
        for raw in ('Los Angeles', 'New York', 'Oklahoma City', 'Seattle SuperSonics', 'New Jersey Nets'):
            self.assertIsNone(resolve_participant(raw, teams('LA Clippers', 'Brooklyn Nets'), 'basketball'))

    def test_football_decorators_are_only_omitted_inside_the_proven_fixture(self):
        expected = teams('Millwall FC', 'VfB Stuttgart')
        self.assertEqual(resolve_participant('Millwall', expected, 'football'), 'home')
        self.assertEqual(resolve_participant('Stuttgart', expected, 'football'), 'away')
        self.assertTrue(recommendation_fixture_matches('Millwall - Stuttgart', expected, 'football'))
        self.assertFalse(same_participants(teams('Millwall', 'Stuttgart'), expected, 'football'))
        for decorator in ('FC', 'CF', 'FK', 'AFC', 'SC', 'AC', 'VfB'):
            for full in (decorator + ' Example United', 'Example United ' + decorator):
                with self.subTest(full=full):
                    self.assertEqual(resolve_participant('Example United', teams(full, 'Other City'), 'football'), 'home')
                    self.assertEqual(resolve_participant(full, teams('Example United', 'Other City'), 'football'), 'home')
                    self.assertIsNone(resolve_participant('Example United', teams(full, 'Other City'), 'basketball'))
                    self.assertFalse(same_participants(teams(full, 'Other City'),
                                                      teams('Example United', 'Other City'), 'football'))

    def test_football_decorators_never_remove_substantive_words_or_internal_tokens(self):
        expected = teams('Manchester United FC', 'Manchester City FC')
        for text in ('Manchester', 'Manchester Albion', 'United', 'City'):
            self.assertIsNone(resolve_participant(text, expected, 'football'))
        self.assertFalse(recommendation_fixture_matches('Manchester City - Manchester United', expected, 'football'))
        self.assertIsNone(resolve_participant('West Bromwich', teams('West Bromwich Albion', 'Other'), 'football'))
        self.assertIsNone(resolve_participant('Example United', teams('Example FC United', 'Other'), 'football'))
        self.assertIsNone(resolve_participant('Example', teams('FCExample', 'Other'), 'football'))
        self.assertIsNone(resolve_participant('Milan', teams('AC Milan', 'Milan FC'), 'football'))

    def test_football_decorator_omission_retains_explicit_class_qualifiers(self):
        for qualifier in ('U21', 'U19', 'B', 'II', 'Réserves', 'U21 F'):
            expected = teams('FC Example ' + qualifier, 'Other City')
            with self.subTest(qualifier=qualifier):
                self.assertIsNone(resolve_participant('Example', expected, 'football'))
                self.assertIsNone(resolve_participant('Example ' + qualifier, teams('FC Example', 'Other City'), 'football'))
                self.assertFalse(recommendation_fixture_matches('Example - Other City', expected, 'football'))
        self.assertIsNone(resolve_participant('Example F', teams('FC Example', 'Other'), 'football'))
        self.assertIsNone(resolve_participant('Example Women', teams('Example FC', 'Other'), 'football'))
        self.assertIsNone(resolve_participant('Example F', teams('Example F', 'FC Example F'), 'football'))
        self.assertEqual(resolve_participant('Example F', teams('FC Example F', 'Other'), 'football'), 'home')
        # Existing omission of an author's women's marker remains contextual.
        self.assertEqual(resolve_participant('Example', teams('FC Example F', 'Other'), 'football'), 'home')
        self.assertFalse(same_participants(teams('Example F', 'Other'), teams('FC Example F', 'Other'), 'football'))

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
