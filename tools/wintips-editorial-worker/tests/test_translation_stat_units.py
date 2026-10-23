import unittest
from editorial_worker.translation import validate_english_sentence, _fixture, _prompt, LocalTranslator, CascadeTranslator, TranslationConfig, TranslationRejected
from editorial_worker.vendor import rdj_translation as guard


class StatisticGrammarTests(unittest.TestCase):
    def item(self,sport='basketball'):
        return {'sport':{'key':sport},'editionDate':'2026-10-23',
            'teams':{'home':{'name':'San Antonio Spurs'},'away':{'name':'New York Knicks'}}}

    def check(self,source,target,expected=True,sport='basketball'):
        _,record=validate_english_sentence(source,target,self.item(sport))
        self.assertEqual(record['passed'],expected,record)

    def test_two_sides_is_both_not_optional_two_goals(self):
        source='On pourrait voir des buts des deux côtés.'
        for target in ['We could see goals from both sides.','We could see goals at both ends.','We could see goals from the two sides.']:
            self.check(source,target,sport='football')
        for target in ['We could see two goals.','We will see goals from both sides.','We could see goals from one side.']:
            self.check(source,target,False,sport='football')
        self.check('Deux buts pourraient arriver.','Both goals could arrive.',False,sport='football')

    def test_decimal_percentage_only_changes_typography(self):
        source='Battus de 43 points (135-92), ils ont réussi 4 tirs sur 36 (11,1 %).'
        target='Beaten by 43 points (135-92), they made 4 shots out of 36 (11.1%).'
        self.check(source,target)
        for bad in [target.replace('11.1%','11.2%'),target.replace('11.1%','111%'),target.replace('11.1%','11.1'),
                    target.replace('Beaten by','Scoring'),target.replace('43 points','44 points'),target.replace('11.1%','-11.1%')]:
            self.check(source,bad,False)

    def test_one_adjacent_result_score_can_use_english_score_order(self):
        for noun,english in [('victoire','win'),('défaite','defeat')]:
            source='Après une '+noun+' 4-1 en finale.'
            target='After a 4-1 '+english+' in the final.'
            self.check(source,target)
            self.check(source,target.replace('4-1','1-4'),False)
            self.check(source,target.replace(english,'loss' if english=='win' else 'victory'),False)
            self.check(source,target.replace('a 4-1','two 4-1'),False)

    def test_final_adjective_is_bound_to_explicit_source_final_result(self):
        source='Après une victoire 4-1 en finale.'
        for target in ['After a 4-1 final win.','After a 4-1 final victory.','After a 4-1 victory in the final.']:
            self.check(source,target)
        for target in ['After a 4-1 win.','After a 1-4 final win.','After a 4-1 final defeat.','After a 4-1 friendly victory.']:
            self.check(source,target,False)
        self.check('Après une victoire 4-1.','After a 4-1 final win.',False)

    def test_returning_former_player_is_not_an_old_man(self):
        source='Pour passer un nouveau cap cette année, Toronto a fait revenir un ancien.'
        good='To take another step forward this year, Toronto brought back a former player.'
        self.check(source,good)
        self.check(source,good.replace('a former player','an old man'),False)
        self.check(source,good.replace('take another step forward','move on this year\'s course'),False)

    def test_slight_advantage_is_translated_and_keeps_its_strength(self):
        self.check('Léger avantage Raptors face aux Bulls.','Slight advantage Raptors against Bulls.')
        self.check('Léger avantage Raptors face aux Bulls.','Léger advantage Raptors against Bulls.',False)
        self.check('Léger avantage Raptors face aux Bulls.','Huge advantage Raptors against Bulls.',False)
        for adjective in ['Petit','Léger','Faible']:
            self.check(adjective+' avantage Clermont sur la forme.','Slight advantage Clermont on form.',sport='football')
            self.check(adjective+' avantage Clermont sur la forme.',adjective+' advantage Clermont on form.',False,sport='football')
        named=self.item();named['teams']['home']['name']='Léger'
        _,proof=validate_english_sentence('Léger a gagné.','Léger won.',named)
        self.assertTrue(proof['passed'],proof)
        self.assertTrue(any(a['kind']=='name' and a['source']=='Léger' for a in proof['anchors']))
        named['teams']['home']['name']='Petit'
        _,proof=validate_english_sentence('Petit a gagné.','Petit won.',named)
        self.assertTrue(proof['passed'],proof)
        self.assertTrue(any(a['kind']=='name' and a['source']=='Petit' for a in proof['anchors']))

    def test_sporting_appearance_and_player_turnover_are_not_literal_release_or_march(self):
        self.check('Cette première sortie compte.','This first outing counts.')
        self.check('Cette première sortie compte.','This first release counts.',False)
        self.check('Chicago a vu défiler les joueurs.','Chicago has seen players come and go.')
        self.check('Chicago a vu défiler les joueurs.','Chicago has seen players march.',False)

    def test_start_of_period_is_not_before_the_period(self):
        source='Ils menaient de 3 points à l’entame du 4e quart-temps.'
        self.check(source,'They led by 3 points at the start of the 4th quarter.')
        self.check(source,'They led by 3 points before the start of the 4th quarter.',False)

    def test_compound_then_counts_one_step_and_never_replaces_a_missing_step(self):
        source='Ils ont ensuite dominé Laval (3-2) puis en allant faire tomber Guingamp (1-2).'
        good='They then dominated Laval (3-2) and then went on to beat Guingamp (1-2).'
        self.check(source,good,sport='football')
        self.check(source,'They then went on to dominate Laval (3-2) and beat Guingamp (1-2).',False,sport='football')
        self.check(source,good.replace('Laval (3-2)','Guingamp (1-2)').replace('beat Guingamp (1-2).','beat Laval (3-2).'),False,sport='football')
        self.check(source,good+' Then.',False,sport='football')
        followup='Ils ont ensuite su enchaîner en dominant Laval (3-2) puis en allant faire tomber Guingamp (1-2).'
        self.check(followup,'They then managed to follow up by dominating Laval (3-2) and then went on to beat Guingamp (1-2).',sport='football')
        self.check(followup,'They then managed to build on their lead by dominating Laval (3-2) and then went on to beat Guingamp (1-2).',False,sport='football')

    def test_prior_to_is_before_and_never_after(self):
        source='Avant la pause, ils ont gagné.'
        self.check(source,'Prior to the break, they won.',sport='football')
        self.check(source,'After the break, they won.',False,sport='football')

    def test_explicit_delay_and_destination_form_one_fact_not_global_actor_reordering(self):
        source='Il est revenu 6 ans plus tard à Toronto.'
        for target in ['He returned 6 years later to Toronto.','He returned to Toronto six years later.']:
            self.check(source,target)
        for target in ['He returned to Toronto six years earlier.','He returned to Toronto seven years later.','He returned to Boston six years later.','He returned to Toronto six months later.']:
            self.check(source,target,False)
        self.check('Clippers avant un retour 6 ans plus tard à Toronto.','Toronto before a return to Clippers six years later.',False)

    def test_individual_nationality_cannot_assign_player_points_to_a_national_team(self):
        source='Avec 12 points au compteur, le Français n’a clairement pas été à la hauteur.'
        good='With 12 points on the board, the French player clearly has not been up to the mark.'
        self.check(source,good)
        self.check(source,good.replace('the French player','the Frenchman'))
        self.check(source,good.replace('the French player','the French team'),False)
        self.check('La Française a gagné.','The Frenchwoman won.')
        self.check('La Française a gagné.','The Frenchman won.',False)
        _,anchors=guard._protect('Ils apprennent le français.',_fixture(self.item()))
        self.assertFalse(any(a['target'] in {'the Frenchman','the Frenchwoman'} for a in anchors))

    def test_bottom_position_and_gap_to_first_safe_team_are_signed_facts(self):
        source='Gladbach ferme la marche au classement avec déjà 5 unités de débours sur le premier non relégable.'
        good='Gladbach is bottom of the table, already 5 points behind the first team outside the relegation zone.'
        self.check(source,good,sport='football')
        for bad in [good.replace('is bottom of the table','leads the table'),good.replace('5 points behind','5 points ahead of'),
                    good.replace('first team','team'),good.replace('outside the relegation zone','not at risk of relegation'),good.replace('5 points','6 points')]:
            self.check(source,bad,False,sport='football')

    def test_season_opener_cannot_become_a_general_statement_this_season(self):
        source='Le Magic a manqué son entrée en matière cette saison.'
        self.check(source,'The Magic failed in their season opener.')
        self.check(source,'The Magic botched their season opener.')
        self.check(source,'The Magic had a successful season opener.',False)
        self.check(source,'The Magic failed to make a statement this season.',False)

    def test_nearest_participial_champion_actor_requires_attached_relative(self):
        source=('Champions de la conférence Ouest en titre en battant OKC, les San Antonio Spurs étaient les grands favoris '
            'de la finale, devant des New York Knicks largement sous-estimés, mais finalement sacrés champions après une victoire 4-1 en finale.')
        target=('Champions of the Western Conference in title by defeating OKC, the San Antonio Spurs were the favorites '
            'for the final, against New York Knicks, who were largely underestimated but ultimately crowned champions after a 4-1 win in the final.')
        self.check(source,target)
        self.check(source,target.replace('Knicks, who were','Knicks, but they were'),False)
        self.check(source,target.replace('Knicks, who were','Knicks. The Spurs were'),False)
        self.check(source,target.replace('who were largely underestimated but ultimately',
            'who were largely underestimated but the Spurs were'),False)
        self.check(source,target.replace('who were largely underestimated but ultimately',
            'who were largely underestimated but their opponents were'),False)
        self.check(source,target.replace('who were largely underestimated but ultimately',
            'who despite losing to the Spurs, who were'),False)
        self.check(source,target.replace('4-1','1-4'),False)
        masked,anchors=guard._protect(source,_fixture(self.item()))
        scopes=[a for a in anchors if a.get('relative_winner_scope')]
        self.assertEqual(scopes[0]['relative_winner_scope']['actor_name'],'New York Knicks')
        self.assertIn('who ... were crowned champions',_prompt(masked,anchors))

    def test_east_auxiliary_homograph_and_real_conference_remain_distinct(self):
        self.check('La franchise s’est renforcée à l’Est.','The franchise strengthened in the East.')
        self.check('La franchise s’est renforcée à l’Est.','The franchise strengthened in the West.',False)
        self.check('La franchise s’est renforcée.','The franchise strengthened.')

    def test_basketball_three_point_counts_preserve_attempts_makes_and_negation(self):
        source='Victor Wembanyama a réussi 1 tir sur 13 tentatives, dont aucun sur 4 à trois points.'
        target='Victor Wembanyama made 1 shot from 13 attempts, including none from 4 three-point attempts.'
        self.check(source,target)
        for bad in [target.replace('none','one'),target.replace('4 three-point','3 three-point'),
                    target.replace('three-point','two-point'),target.replace('4 three-point attempts','three-point attempts')]:
            self.check(source,bad,False)
        self.check('Ils ont affiché 4 tirs primés réussis sur 36 tentatives.','They displayed 4 successful three-pointers from 36 attempts.')
        self.check('Ils ont affiché 4 tirs primés réussis sur 36 tentatives.','They displayed 4 successful two-pointers from 36 attempts.',False)
        for verb,target in [('manqué','missed'),('tenté','attempted'),('réussi','made')]:
            self.check('Ils ont '+verb+' 4 tirs primés.','They '+target+' 4 three-point shots.')
        for source in ['Ils ont manqué 4 tirs primés.','Ils ont tenté 4 tirs primés.']:
            self.check(source,'They made 4 successful three-pointers.',False)
        self.check('Ils ont réussi 4 à trois points.','They made 4 three-point shots.')
        self.check('Ils ont réussi 4 à trois points.','They made 4 three-point attempts.',False)

    def test_named_basketball_possessor_is_one_relationship_not_free_name_order(self):
        self.check('Les Spurs recevaient le Thunder de SGA.','The Spurs were hosting the SGA Thunder.')
        self.check('Les Spurs recevaient le Thunder de SGA.','The Spurs were hosting SGA’s Thunder.')
        self.check('Les Spurs recevaient le Thunder de SGA.','The Thunder were hosting SGA’s Spurs.',False)
        self.check('Les Spurs recevaient le Thunder de SGA.','The Spurs were facing the SGA Thunder.',False)

    def test_competition_and_round_form_a_bounded_fact(self):
        self.check('En demi-finale de la conférence Ouest, les San Antonio Spurs ont gagné.',
            'In the Western Conference semi-finals, the San Antonio Spurs won.')
        self.check('En demi-finale de la conférence Ouest, les San Antonio Spurs ont gagné.',
            'In the Eastern Conference semi-finals, the San Antonio Spurs won.',False)

    def test_initial_elimination_year_reorders_only_inside_same_passive_event(self):
        source='Éliminés l’an dernier par les San Antonio Spurs en demi-finale de la conférence Ouest, les Minnesota Timberwolves ont senti qu’un cap devait être franchi.'
        target="Eliminated by the San Antonio Spurs in last year's Western Conference semi-final, the Minnesota Timberwolves felt that a hurdle needed to be overcome."
        self.check(source,target)
        for bad in [target.replace('last year','this year'),target.replace('San Antonio Spurs','Minnesota Timberwolves',1),
                    target.replace('Eliminated','Victorious'),target.replace('Western','Eastern'),target.replace('a hurdle needed to be overcome','a course had to be crossed')]:
            self.check(source,bad,False)

    def test_single_overnight_relation_keeps_both_explicit_weekdays(self):
        source='Les Houston Rockets ont joué dans la nuit de mercredi à jeudi.'
        for relation in ['on the night from Wednesday to Thursday','overnight Wednesday to Thursday','Wednesday night into Thursday']:
            self.check(source,'The Houston Rockets played '+relation+'.')
        for relation in ['on Wednesday and Thursday night','in the early hours of Thursday','on the night from Thursday to Friday']:
            self.check(source,'The Houston Rockets played '+relation+'.',False)

    def test_negated_delay_is_quick_action_not_an_absent_negative_result(self):
        source='Minnesota n’a pas tardé à afficher ses ambitions en s’imposant (131-106) face au Heat.'
        self.check(source,'Minnesota quickly showed its ambitions by winning (131-106) against the Heat.')
        self.check(source,'Minnesota quickly showed its ambitions by losing (131-106) against the Heat.',False)
        self.check('Les Houston Rockets ont 0 défaite.','The Houston Rockets have no defeats.')
        self.check('Les Houston Rockets ont 0 défaite.','The Houston Rockets have 1 defeat.',False)

    def test_relegation_zone_is_not_the_relegation_playoff(self):
        self.check('Cette formation est dans la zone rouge.','This team is in the relegation zone.',sport='football')
        self.check('Cette formation est dans la zone rouge.','This team is in the relegation play-off spot.',False,sport='football')
        self.check('Cette formation est dans la zone de relégation.','This team is in the relegation zone.',sport='football')
        self.check('Cette formation est dans la zone de relégation.','This team is in the relegation play-off spot.',False,sport='football')

    def test_completed_win_with_a_later_actual_defeat_is_concessive(self):
        source='S’ils avaient pu s’imposer contre Rodez (1-0), les Isérois ont ensuite été battus.'
        target='Although they had won against Rodez (1-0), the Isérois were then beaten.'
        self.check(source,target,sport='football')
        self.check(source,target.replace('Although they had won','If they had been able to win'),False,sport='football')
        hypothetical=source.replace('ont ensuite été battus','auraient ensuite été fêtés')
        _,anchors=guard._protect(hypothetical,_fixture(self.item('football')))
        self.assertFalse(any(a['target'].lower()=='although they had won' for a in anchors))

    def test_official_rodez_demonym_is_not_a_new_club_name(self):
        self.check('Les ruthénois ont gagné.','Rodez won.',sport='football')
        self.check('Les ruthénois ont gagné.','Rethoise won.',False,sport='football')

    def test_form_advantage_label_is_deterministic_and_bound_to_fixture_team(self):
        item=self.item('football')
        translator=LocalTranslator(request=lambda *args:self.fail('Known team form label must not use a model'))
        self.assertEqual(translator.text('Avantage San Antonio Spurs sur la forme',item),
            'San Antonio Spurs has the advantage in recent form')
        self.assertEqual(translator.text('Avantage San Antonio Spurs au niveau de la forme',item),
            'San Antonio Spurs has the advantage in recent form')
        self.assertEqual(translator.text('Petit avantage San Antonio Spurs sur la forme',item),
            'San Antonio Spurs has a slight advantage in recent form')
        # A different club cannot be silently substituted into this template.
        from editorial_worker.translation import _team_form_label
        self.assertIsNone(_team_form_label('Avantage Pau sur la forme',item))

    def test_directed_goal_or_point_margin_never_becomes_a_bare_score(self):
        source='Ils ont fini en menant de 3 buts.'
        for target in ['They finished leading by 3 goals.','They finished with a 3-goal lead.','They finished ahead by three goals.']:
            self.check(source,target,sport='football')
        for target in ['They finished with 3 goals.','They finished trailing by 3 goals.','They finished leading by 2 goals.']:
            self.check(source,target,False,sport='football')
        self.check('Menés de 3 points, ils ont perdu.','Trailing by 3 points, they lost.')
        self.check('Menés de 3 points, ils ont perdu.','Leading by 3 points, they lost.',False)

    def test_football_results_accounting_is_not_finance_and_additive_not_only_is_not_negation(self):
        source='Non seulement sur le plan comptable mais dans la production, les Bretons sont décevants.'
        good='Not only in terms of results but in terms of performances, the Bretons are disappointing.'
        self.check(source,good,sport='football')
        self.check(source,good.replace('in terms of results','financially'),False,sport='football')
        self.check(source,good.replace('in terms of performances','in factory production'),False,sport='football')

    def test_en_avant_is_a_club_not_a_temporal_preposition(self):
        self.check('En Avant a gagné.','En Avant won.',sport='football')
        self.check('En Avant a gagné.','Avant-Garde won.',False,sport='football')
        self.check('Avant le match, Nancy a gagné.','Before the match, Nancy won.',sport='football')

    def test_explicit_numeric_small_single_point_is_not_a_missing_margin(self):
        source='Ils ont un seul petit point d’avance.'
        self.check(source,'They have a small point advantage.',sport='football')
        self.check(source,'They have a narrow advantage.',False,sport='football')
        self.check(source,'They have two small points of advantage.',False,sport='football')

    def test_named_opponent_ground_is_away_not_an_unspecified_pitch(self):
        source='Ils ont perdu sur la pelouse du Celta Vigo (2-1).'
        self.check(source,'They lost away to Celta Vigo (2-1).',sport='football')
        self.check(source,"They lost on Celta Vigo's pitch (2-1).",sport='football')
        self.check(source,'They lost on the pitch against Celta Vigo (2-1).',False,sport='football')
        self.check(source,'They lost at home against Celta Vigo (2-1).',False,sport='football')
        source='Ipswich a perdu dans l’antre de Manchester City le week-end dernier (3-2).'
        self.check(source,'Ipswich lost away to Manchester City last weekend (3-2).',sport='football')
        self.check(source,'Ipswich lost away to Manchester City (3-2) last weekend.',sport='football')
        self.check(source,'Ipswich lost to Manchester City at their home ground last weekend (3-2).',sport='football')
        self.check(source,'Ipswich lost away to Manchester City last weekend (2-3).',False,sport='football')
        self.check('Ils ont gagné sur la pelouse d’Aston Villa.','They won away to Aston Villa.',sport='football')
        self.check('Ils ont gagné sur la pelouse d’Aston Villa.','They won against Aston Villa.',False,sport='football')

    def test_draw_and_hour_mark_are_not_zero_or_unspecified_time(self):
        source='À l’heure de jeu, Stuttgart a obtenu un nul à domicile (1-1).'
        good='On the hour mark, Stuttgart obtained a draw at home (1-1).'
        self.check(source,good,sport='football')
        self.check(source,good.replace('a draw','a zero'),False,sport='football')
        self.check(source,good.replace('On the hour mark','At the time of play'),False,sport='football')
        self.check(source,good.replace('On the hour mark','In the 70th minute'),False,sport='football')

    def test_point_gap_to_top_rank_preserves_behind_relation(self):
        source='Ils ont été relégués à 7 points déjà du top 4.'
        self.check(source,'They are 7 points behind the top 4.',sport='football')
        for target in ['They are 7 points in the top 4.','They are 7 points ahead of the top 4.','They are 4 points behind the top 7.']:
            self.check(source,target,False,sport='football')
        self.check('Ils ont été relégués à 1 point du top 4.','They are one point behind the top four.',sport='football')

    def test_added_written_count_is_rejected_and_same_count_relation_is_explicit(self):
        source='Après 6 journées et autant de défaites.'
        for target in ['After 6 matchdays and as many defeats.','After six matchdays and six defeats.']:
            self.check(source,target,sport='football')
        self.check(source,'After 6 matchdays and nine defeats.',False,sport='football')
        self.check('Ils ont perdu après 6 journées.','They lost after 6 matchdays and nine defeats.',False,sport='football')

    def test_parenthetical_result_score_without_article_keeps_result_direction(self):
        self.check('Paderborn (victoire 0-2).','Paderborn (a 0-2 win).',sport='football')
        self.check('Paderborn (victoire 0-2).','Paderborn (0-2 win).',sport='football')
        self.check('Paderborn (victoire 0-2).','Paderborn (a 2-0 win).',False,sport='football')
        self.check('Paderborn (victoire 0-2).','Paderborn (a 0-2 defeat).',False,sport='football')

    def test_cascade_segment_cap_counts_source_sentences_not_internal_engines(self):
        from test_translation import fixture,response
        calls=[]
        def fallback(*args):
            calls.append(args)
            return response('Brest won three matches.')
        translator=CascadeTranslator(TranslationConfig(max_segments=2,fallback_model=None),mt_model='opus-test',
            mt_request=lambda *args:response('Brest won four matches.'),request=fallback)
        source='Brest a gagné trois matchs.'
        for _ in range(2):self.assertEqual(translator.sentence(source,fixture()['items'][0]),'Brest won three matches.')
        self.assertEqual(len(calls),2)
        with self.assertRaisesRegex(TranslationRejected,'translation_segment_budget_exceeded'):
            translator.sentence(source,fixture()['items'][0])


if __name__=='__main__':unittest.main()
