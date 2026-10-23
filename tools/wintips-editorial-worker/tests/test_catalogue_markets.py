from copy import deepcopy
from datetime import date
import unittest
import hashlib
import json
from pathlib import Path

from editorial_worker.markets import market, MarketError
from editorial_worker.translation import LocalTranslator, TranslationRejected, validate_english_sentence, _fixture, _relative_weekday_errors
from editorial_worker.verified import VerifiedKickoffs, VOLLEY_BASE
from editorial_worker.vendor import rdj_collector as rdj
from editorial_worker import sources as s, runner
from test_worker import page, Offline, fixture_clock


class MarketTests(unittest.TestCase):
    def test_actual_petit_journal_basket_player_and_handicap_labels(self):
        self.assertEqual(market('Wemby marque + de 24,5 pts', ['Oklahoma City Thunder', 'San Antonio Spurs'], 'basketball'), ('player_points', 'Wemby over 24.5 points'))
        self.assertEqual(market('Lakers +15', ['Lakers', 'Oklahoma City Thunder'], 'basketball'), ('points_handicap', 'Lakers +15 points'))
        self.assertEqual(market('McCollum 20 pts ou +', ['Washington', 'Atlanta'], 'basketball'), ('player_points', 'McCollum 20+ points'))

    def test_actual_rdj_volleyball_exact_sets_and_total(self):
        self.assertEqual(market('Victoire France 3-0', ['France', 'Roumanie'], 'volleyball'), ('exact_sets', 'France to win 3–0'))
        self.assertEqual(market('Plus de 3,5 sets', ['Argentine', 'France'], 'volleyball'), ('total_sets', 'Over 3.5 sets'))

    def test_basket_margin_and_team_total_are_different_market_types(self):
        self.assertEqual(market('Victoire Toronto Raptors de 11 points ou plus', ['Toronto Raptors', 'Chicago Bulls'], 'basketball')[0], 'winning_margin')
        self.assertEqual(market('Plus de 115,5 points pour Houston', ['Houston', 'Milwaukee'], 'basketball'), ('team_points', 'Houston over 115.5 points'))

    def test_units_actors_and_composite_labels_fail_closed(self):
        for label, teams, sport in [('Victoire PSG', ['Lille', 'Lyon'], 'football'), ('Plus de 3,5 sets', ['Lille', 'Lyon'], 'football'), ('Victoire France 2-0', ['France', 'Roumanie'], 'volleyball'), ('Victoire Houston & Durant marque 30 points ou plus', ['Houston', 'Milwaukee'], 'basketball')]:
            with self.subTest(label=label), self.assertRaises(MarketError):
                market(label, teams, sport)

    def test_market_translation_never_uses_model_or_infers_overtime(self):
        translator = LocalTranslator(request=lambda *a: self.fail('Markets cannot use a model'))
        item = {'kind': 'match', 'sport': {'key': 'volleyball'}, 'teams': {'home': {'name': 'France'}, 'away': {'name': 'Roumanie'}}, 'selection': {'betType': 'exact_sets'}}
        self.assertEqual(translator.market('Victoire France 3-0', item), 'France to win 3–0')
        item['selection']['betType'] = 'match_winner'
        with self.assertRaisesRegex(TranslationRejected, 'market_type_label_conflict'):
            translator.market('Victoire France 3-0', item)

    def test_customer_quinte_label_omits_publisher_but_keeps_source_identity(self):
        item=s.parse_turf(page('turf-2026-10-23'),'2026-10-23')
        self.assertEqual(item['selection']['label']['fr'],'Sélection Quinté+')
        translator=LocalTranslator(request=lambda *a:self.fail('Fixed customer labels cannot use inference'))
        self.assertEqual(translator.market(item['selection']['label']['fr'],item),'Quinté+ selection')
        self.assertIn('ruedesjoueurs.com',item['sourceUrl'])
        self.assertEqual(item['sourceId'],'2026-10-23-R1C4')

    def test_initial_opponent_preposition_is_semantic_not_a_proper_name(self):
        item={'sport':{'key':'football'},'teams':{'home':{'name':'Lille'},'away':{'name':'Lyon'}}}
        source='Contre Lille, Lyon pourrait disputer son 7ème match.'
        _,proof=validate_english_sentence(source,'Against Lille, Lyon could play their seventh match.',item)
        self.assertTrue(proof['passed'],proof)
        _,bad=validate_english_sentence(source,'Against Lyon, Lille could play their seventh match.',item)
        self.assertFalse(bad['passed'])

    def test_two_opponent_prepositions_preserve_both_results_and_order(self):
        item={'sport':{'key':'football'},'teams':{'home':{'name':'Lille'},'away':{'name':'Lyon'}}}
        source='Lille a gagné contre Lyon (2-1), puis à domicile face à Nice (2-1).'
        _,proof=validate_english_sentence(source,'Lille won against Lyon (2-1), then at home against Nice (2-1).',item)
        self.assertTrue(proof['passed'],proof)
        _,bad=validate_english_sentence(source,'Lille won against Nice (2-1), then at home against Lyon (2-1).',item)
        self.assertFalse(bad['passed'])

    def test_conference_and_attack_minded_sports_terms_are_not_names(self):
        item={'sport':{'key':'basketball'},'teams':{'home':{'name':'Milwaukee Bucks'},'away':{'name':'Chicago Bulls'}}}
        source='12ème de la conférence Est, Milwaukee a débuté sa saison par une défaite en déplacement chez les Washington Wizards.'
        _,proof=validate_english_sentence(source,'12th in the Eastern Conference, Milwaukee began its season with a defeat away against the Washington Wizards.',item)
        self.assertTrue(proof['passed'],proof)
        _,bad=validate_english_sentence(source,'12th in the Western Conference, Milwaukee began its season with a defeat away against the Washington Wizards.',item)
        self.assertFalse(bad['passed'])

    def test_function_words_are_not_fake_entities_but_explicit_fixture_names_stay_protected(self):
        from editorial_worker.vendor import rdj_translation as guard
        for word in ['On',"Aujourd'hui",'Heureusement','Plutôt','Toujours','Éliminés','Champions']:
            source=word+' Lille a gagné trois matchs.'
            _,anchors=guard._protect(source,{'home':'Lille','away':'Lyon','sport_key':'football'})
            self.assertFalse(any(a['kind']=='name' and a['source']==word for a in anchors))
            self.assertTrue(any(a['source']=='Lille' for a in anchors))
            self.assertTrue(any(a['source']=='trois' for a in anchors))
        _,anchors=guard._protect('Suite a gagné trois matchs.',{'home':'Suite','away':'Lyon','sport_key':'football'})
        self.assertTrue(any(a['kind']=='name' and a['source']=='Suite' for a in anchors))
        football={'sport':{'key':'football'},'teams':{'home':{'name':'Brest'},'away':{'name':'Nice'}}}
        source='Affiche intéressante vendredi entre deux équipes plutôt joueuses.'
        _,proof=validate_english_sentence(source,'An interesting fixture on Friday between two attack-minded teams.',football)
        self.assertTrue(proof['passed'],proof)
        _,bad=validate_english_sentence(source,'An interesting fixture on Friday between two strong teams.',football)
        self.assertFalse(bad['passed'])

    def test_stadium_at_and_grammatical_at_do_not_duplicate_a_fact_anchor(self):
        item={'sport':{'key':'football'},'teams':{'home':{'name':'Brest'},'away':{'name':'Nice'}}}
        source='Affiche intéressante ce vendredi soir du côté de Francis-Le-Blé entre deux équipes plutôt joueuses en ce début de saison.'
        target='Interesting fixture on Friday evening at Francis-Le-Blé between two attack-minded teams at the start of the season.'
        _,proof=validate_english_sentence(source,target,item)
        self.assertTrue(proof['passed'],proof)
        _,proof=validate_english_sentence(source,target.replace('at Francis-Le-Blé','in Francis-Le-Blé'),item)
        self.assertTrue(proof['passed'],proof)
        for bad in [target.replace('Francis-Le-Blé','Old Trafford'),target.replace('two attack-minded','three attack-minded'),
                    'Interesting fixture on Friday evening, with Francis-Le-Blé facing two attack-minded teams at the start of the season.',
                    'Interesting fixture on Friday evening against Francis-Le-Blé between two attack-minded teams at the start of the season.',
                    'Interesting fixture on Friday evening in Francis-Le-Blé playing two attack-minded teams at the start of the season.']:
            _,proof=validate_english_sentence(source,bad,item)
            self.assertFalse(proof['passed'])

    def test_basket_quarter_is_source_scoped_ordinal_not_fraction(self):
        item={'sport':{'key':'basketball'},'teams':{'home':{'name':'Milwaukee Bucks'},'away':{'name':'Chicago Bulls'}}}
        source='Les Bucks menaient de 3 points au début du 4e quart-temps.'
        for target in ['The Bucks led by 3 points at the start of the fourth quarter.','The Bucks led by 3 points at the start of the 4th quarter.']:
            _,proof=validate_english_sentence(source,target,item)
            self.assertTrue(proof['passed'],proof)
        for target in ['The Bucks led by 3 points at the start of the third quarter.','The Bucks led by 3 points at the start of the fifth quarter.','The Bucks led by 3 points at the start of the fourth and a quarter.','The Bucks led by 4 points at the start of the fourth quarter.']:
            _,proof=validate_english_sentence(source,target,item)
            self.assertFalse(proof['passed'],target)

    def test_basket_losing_composure_idiom_is_not_physical_pedals(self):
        item={'sport':{'key':'basketball'},'teams':{'home':{'name':'Milwaukee Bucks'},'away':{'name':'Chicago Bulls'}}}
        source="Les Bucks menaient de 3 points au début du 4e quart-temps avant de perdre totalement les pédales et concéder un +15 à la fin du 4e."
        correct='The Bucks led by 3 points at the start of the fourth quarter before completely losing their composure and conceding a +15 at the end of the fourth.'
        _,proof=validate_english_sentence(source,correct,item)
        self.assertTrue(proof['passed'],proof)
        for bad in [correct.replace('losing their composure','losing all the pedals'),correct.replace('+15','+16'),correct.replace('fourth','third',1)]:
            _,proof=validate_english_sentence(source,bad,item)
            self.assertFalse(proof['passed'],bad)

    def test_basket_conference_direction_and_playoff_game_are_terms_not_entities(self):
        item={'sport':{'key':'basketball'},'teams':{'home':{'name':'Houston Rockets'},'away':{'name':'Lakers'}}}
        source='Après les Play-offs, les Houston Rockets sont 3es à l’Ouest après le Game 7.'
        target='After the playoffs, the Houston Rockets are third in the West after Game 7.'
        _,proof=validate_english_sentence(source,target,item)
        self.assertTrue(proof['passed'],proof)
        for bad in [target.replace('West','East'),target.replace('7','6'),target.replace('third','fourth')]:
            _,proof=validate_english_sentence(source,bad,item)
            self.assertFalse(proof['passed'],bad)

    def test_club_good_form_is_not_body_shape(self):
        item={'sport':{'key':'football'},'teams':{'home':{'name':'Nancy'},'away':{'name':'Laval'}}}
        source='Nancy confirme sa belle forme ?'
        _,proof=validate_english_sentence(source,'Does Nancy confirm its good form?',item)
        self.assertTrue(proof['passed'],proof)
        _,bad=validate_english_sentence(source,'Nancy confirms her beautiful shape?',item)
        self.assertFalse(bad['passed'])

    def test_unbeaten_after_thrashing_is_not_second_win_or_stroking(self):
        item={'sport':{'key':'football'},'teams':{'home':{'name':'Brest'},'away':{'name':'Nice'}}}
        source='En évitant la défaite à Lille (1-1), les Ti-Zefs ont enchaîné un deuxième match sans défaite après avoir étrillé Angers (5-1) à la maison.'
        correct='By avoiding defeat against Lille (1-1), Ti-Zefs have followed up with a second consecutive match without defeat after thoroughly defeating Angers (5-1) at home.'
        _,proof=validate_english_sentence(source,correct,item)
        self.assertTrue(proof['passed'],proof)
        for bad in [correct.replace('match without defeat','win'),correct.replace('thoroughly defeating','stroking'),correct.replace('5-1','1-5')]:
            _,proof=validate_english_sentence(source,bad,item)
            self.assertFalse(proof['passed'],bad)

    def test_full_sport_season_is_one_exact_atom_and_roster_is_not_staff(self):
        item={'sport':{'key':'basketball'},'teams':{'home':{'name':'Washington Wizards'},'away':{'name':'Toronto Raptors'}}}
        source='Les Washington Wizards version 2026-2027 semblent disposer d’un effectif capable de rivaliser.'
        for target in ['The Washington Wizards version 2026-2027 seem to have a squad capable of competing.',
                       'The Washington Wizards, in their 2026–2027 iteration, appear to have a roster capable of competing.']:
            _,proof=validate_english_sentence(source,target,item)
            self.assertTrue(proof['passed'],proof)
        for target in ['The Washington Wizards version 2026-2028 seem to have a squad capable of competing.',
                       'The Washington Wizards version 2027-2026 seem to have a squad capable of competing.',
                       'The Washington Wizards version 2026-2027 seem to have a staff capable of competing.',
                       'The Washington Wizards version 2026-2027 definitely have a squad capable of competing.',
                       'The 2026-2027 Washington Wizards seem to have a squad capable of competing.']:
            _,proof=validate_english_sentence(source,target,item)
            self.assertFalse(proof['passed'],target)

    def test_two_sequential_results_keep_went_on_to_chronology(self):
        item={'sport':{'key':'football'},'teams':{'home':{'name':'Pau'},'away':{'name':'Grenoble'}}}
        source='Ils ont ensuite su enchaîner en dominant Laval (3-2) puis en allant faire tomber Guingamp à Roudourou (1-2) le week-end dernier.'
        target='They then proceeded to dominate Laval (3-2) and went on to beat Guingamp at Roudourou (1-2) last weekend.'
        _,proof=validate_english_sentence(source,target,item)
        self.assertTrue(proof['passed'],proof)
        for bad in [target.replace('beat Guingamp','lose to Guingamp'),target.replace('Laval (3-2)','Guingamp (3-2)').replace('beat Guingamp at','beat Laval at'),target.replace('(1-2)','(2-1)')]:
            _,proof=validate_english_sentence(source,bad,item)
            self.assertFalse(proof['passed'],bad)

    def test_nominal_fixture_is_not_verb_displaying_a_record(self):
        item={'sport':{'key':'football'},'teams':{'home':{'name':'Brest'},'away':{'name':'Nice'}}}
        source="Nice, avec ses 6 buts, n'affiche pas un bilan aussi flatteur mais les Aiglons ont tout de même marqué lors de 4 de leurs 5 derniers matchs."
        target='Nice, with its 6 goals, does not display such a flattering record, but the Aiglons have still scored in 4 of their 5 most recent fixtures.'
        _,proof=validate_english_sentence(source,target,item)
        self.assertTrue(proof['passed'],proof)
        for bad in [target.replace('6 goals','7 goals'),target.replace('does not display','does display'),target.replace('4 of their 5','5 of their 4')]:
            _,proof=validate_english_sentence(source,bad,item)
            self.assertFalse(proof['passed'],bad)
        for source in ['Affiche intéressante vendredi entre deux équipes plutôt joueuses.','Une affiche entre deux équipes plutôt joueuses vendredi.']:
            _,proof=validate_english_sentence(source,'An interesting fixture on Friday between two attack-minded teams.',item)
            # The second source has a different order; inspect the noun kind
            # independently instead of authorising a global order inversion.
            if source.startswith('Affiche'):
                self.assertTrue(proof['passed'],proof)
            self.assertTrue(any(a['source'].casefold()=='affiche' and a['target'].casefold()=='fixture' for a in proof['anchors']))

    def test_three_basket_periods_are_not_a_fraction_or_changed_score(self):
        item={'sport':{'key':'basketball'},'teams':{'home':{'name':'Washington Wizards'},'away':{'name':'Toronto Raptors'}}}
        source='Bousculés pendant trois quarts-temps, les hommes de Washington ont finalement fait la différence dans une dernière période à sens unique (38-23), pour s’imposer sur le score de 128-116.'
        target='Under pressure for three quarters, the men of Washington finally made the difference in a one-way final period (38-23), to win on a score of 128-116.'
        for good in [target,target.replace('three quarters','3 quarters')]:
            _,proof=validate_english_sentence(source,good,item)
            self.assertTrue(proof['passed'],proof)
        for bad in [target.replace('three quarters','three-quarters of the time'),target.replace('three quarters','3/4 of the time'),
                    target.replace('three quarters','four quarters'),target.replace('Under pressure','Buzzed'),
                    target.replace('(38-23)','(23-38)'),target.replace('128-116','116-128')]:
            _,proof=validate_english_sentence(source,bad,item)
            self.assertFalse(proof['passed'],bad)

    def test_restrictive_rank_and_one_small_point_keep_quantities_and_polarity(self):
        item={'sport':{'key':'football'},'teams':{'home':{'name':'Clermont Foot'},'away':{'name':'Guingamp'}}}
        source="Loin de là même puisque cette formation ne se trouve qu'à la 15ème place du classement avec un seul petit point d'avance sur la zone de relégation au départ de cette 10ème journée."
        target='Far from it, as this team is actually in 15th place in the table, with only a small margin of one point above the relegation zone at the start of this 10th matchday.'
        _,proof=validate_english_sentence(source,target,item)
        self.assertTrue(proof['passed'],proof)
        for bad in [target.replace('one point','two points'),target.replace('one point','a margin'),target.replace('15th','5th'),target.replace('10th','11th')]:
            _,proof=validate_english_sentence(source,bad,item)
            self.assertFalse(proof['passed'],bad)
        # No source quarter unit: a fractional extension must still fail.
        for source,target in [('Les Bucks ont marqué 4 points.','The Bucks scored four and a quarter points.'),('Les Bucks sont 4e.','The Bucks are fourth quarter.')]:
            _,proof=validate_english_sentence(source,target,item)
            self.assertFalse(proof['passed'],target)


def volleyball_payload(**changes):
    row = {'discipline': 'volley', 'gender':'Men', 'matchStatus': 0, 'isMatchTBD': False, 'currentSetNo': 0,
        'teamANo': 10, 'teamBNo': 20, 'tournamentNo': 1661, 'matchNo': 123,
        'competitionFullName': 'VNL 2026', 'matchDateUtc': '2026-10-23T18:00:00Z'}
    row.update(changes)
    return {'matches': [row], 'allTeams': [
        {'no': 10, 'discipline': 'volley', 'name': 'France', 'code': 'FRA'},
        {'no': 20, 'discipline': 'volley', 'name': 'Romania', 'code': 'ROU'}],
        'allTournaments': [{'no': 1661, 'discipline': 'volley', 'gender':'Men', 'name': 'VNL 2026'}]}


class VerifiedVolleyballTests(unittest.TestCase):
    fixture = {'sport': 'volleyball', 'gender':'men', 'competition': 'Nations League', 'home': 'France', 'away': 'Roumanie',
        'source_url': 'https://www.ruedesjoueurs.com/pronostic/france-roumanie-123.html',
        'journal_source_url': 'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/123-23-octobre-2026.html'}

    def resolver(self, payload):
        def fetch(url):
            return payload if url.endswith('/2026-10-23/2026-10-23') else {'matches': [], 'allTeams': [], 'allTournaments': []}
        return VerifiedKickoffs(fetch_json=fetch)

    def test_verified_provider_binds_teams_competition_id_status_and_utc(self):
        resolver = self.resolver(volleyball_payload())
        proof = resolver(self.fixture, '2026-10-23')
        self.assertEqual(proof['source_id'], '123')
        self.assertEqual(proof['source_url'], VOLLEY_BASE + '2026-10-23/2026-10-23')
        moment, _ = rdj._utc(self.fixture, s.datetime(2026,10,23,20), s.datetime(2026,10,23,18), date(2026,10,23), resolver)
        self.assertEqual(s.iso(moment), s.iso('2026-10-23T18:00:00Z'))

    def test_finished_live_tbd_wrong_tournament_and_naive_time_are_refused(self):
        for changes in [{'matchStatus': 2}, {'matchStatus': 1}, {'matchStatus': False}, {'isMatchTBD': True},
                {'discipline': 'beach'}, {'gender':'Women'}, {'competitionFullName': 'Unknown League'}, {'matchDateUtc': '2026-10-23T18:00:00'}, {'teamANo': 20, 'teamBNo': 10}]:
            payload = volleyball_payload(**changes)
            if 'competitionFullName' in changes:
                payload['allTournaments'][0]['name'] = 'Unknown League'
            with self.subTest(changes=changes):
                self.assertIsNone(self.resolver(payload)(self.fixture, '2026-10-23'))

    def test_ambiguous_event_identity_refused_and_ranking_history_ignored(self):
        payload = volleyball_payload()
        payload['matches'].append(dict(payload['matches'][0], matchNo=999))
        self.assertIsNone(self.resolver(payload)(self.fixture, '2026-10-23'))
        unknown = dict(self.fixture);unknown.pop('gender')
        self.assertIsNone(self.resolver(volleyball_payload())(unknown,'2026-10-23'))
        payload['matches'] = []
        payload['worldRanking'] = {'pastWorldRanking': {'matches': [{'matchNo':123,'matchDateUtc':'2026-10-23T18:00:00Z'}]}}
        self.assertIsNone(self.resolver(payload)(self.fixture, '2026-10-23'))

    def test_forged_official_url_or_unbound_teams_not_accepted_by_clock_guard(self):
        proof = self.resolver(volleyball_payload())(self.fixture, '2026-10-23')
        for bad in [dict(proof, source_url=VOLLEY_BASE+'2026-10-23/2026-10-23?anything=1'), dict(proof, matched_participants=['Roumanie','France']), dict(proof, status='finished')]:
            with self.assertRaisesRegex(ValueError, 'approved official|proof'):
                rdj._utc(self.fixture, s.datetime(2026,10,23,20), s.datetime(2026,10,23,18), date(2026,10,23), lambda *a: bad)


class NbaProviderTests(unittest.TestCase):
    fixture = {'sport':'basketball','competition':'NBA','home':'Milwaukee Bucks','away':'Chicago Bulls',
        'source_url':'https://www.ruedesjoueurs.com/pronostic/milwaukee-bucks-chicago-bulls-6019664.html',
        'journal_source_url':'https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal/74775-23-octobre-2026.html'}

    def payload(self):
        row={'id':'401810001','date':'2026-10-23T20:00:00Z','timeValid':True,
            'status':{'type':{'state':'pre','name':'STATUS_SCHEDULED','completed':False}},
            'competitors':[{'type':'team','homeAway':side,'team':{'displayName':name}} for side,name in [('home','Milwaukee Bucks'),('away','Chicago Bulls')]]}
        return {'leagues':[{'slug':'nba'}],'events':[{'id':'401810001','competitions':[row]}]}

    def resolver(self,payload):
        def fetch(url):
            if url.startswith('https://cdn.nba.com/'):
                raise ValueError('HTTP403 synthetic unavailable official CDN')
            return payload if url.endswith('dates=20261023') else {'leagues':[{'slug':'nba'}],'events':[]}
        return VerifiedKickoffs(fetch_json=fetch)

    def test_public_nba_cdn_failure_has_bounded_verified_espn_fallback(self):
        resolver=self.resolver(self.payload());proof=resolver(self.fixture,'2026-10-23')
        self.assertEqual(proof['league_id'],'nba')
        moment,_=rdj._utc(self.fixture,s.datetime(2026,10,23,22),s.datetime(2026,10,23,22),date(2026,10,23),resolver)
        self.assertEqual(s.iso(moment),s.iso('2026-10-23T20:00:00Z'))

    def test_nba_wrong_home_away_live_unknown_time_and_competition_rejected(self):
        for edit in ['live','unknown_time','reverse','league','ambiguous']:
            payload=self.payload();row=payload['events'][0]['competitions'][0]
            if edit=='live':row['status']['type'].update(state='in',name='STATUS_IN_PROGRESS')
            if edit=='unknown_time':row['timeValid']=False
            if edit=='reverse':row['competitors'].reverse();row['competitors'][0]['homeAway']='home';row['competitors'][1]['homeAway']='away'
            if edit=='league':payload['leagues'][0]['slug']='wnba'
            if edit=='ambiguous':payload['events'].append({'id':'401810002','competitions':[dict(row,id='401810002')]})
            with self.subTest(edit=edit):self.assertIsNone(self.resolver(payload)(self.fixture,'2026-10-23'))

    def test_forged_espn_other_league_is_not_clock_proof(self):
        proof=self.resolver(self.payload())(self.fixture,'2026-10-23')
        proof['source_url']=proof['source_url'].replace('/nba/','/wnba/')
        with self.assertRaisesRegex(ValueError,'approved official'):
            rdj._utc(self.fixture,s.datetime(2026,10,23,22),s.datetime(2026,10,23,22),date(2026,10,23),lambda *a:proof)


class TicketFilteringTests(unittest.TestCase):
    def real_pmu(self):
        directory = Path(__file__).parent / 'fixtures'
        rows = json.loads((directory/'catalogue-provenance.json').read_text('utf8'))
        captured = {}
        for row in rows:
            raw = (directory/row['file']).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), row['fixtureSha256'])
            captured[row['file']] = rdj.FetchedPage(row['sourceUrl'], raw.decode('utf8'))
        p = captured['combine-pmu-2026-10-23.html']
        details = [captured['football-stuttgart-2026-10-23.html'], captured['football-brest-2026-10-23.html']]
        listing = rdj.FetchedPage(s.SOURCES['rdj_football_analysis'], ''.join('<a href="'+p.url+'">Lire l’analyse</a>' for p in details))
        def clock(fixture, edition):
            minute = '30' if 'Stuttgart' in fixture['home'] else '45'
            return {'kickoff_utc':edition+'T18:'+minute+':00Z','method':'official_schedule','source_id':fixture['home'], 'source_url':'https://match.uefa.com/v5/matches?fixture-test=1'}
        return p, Offline(details+[listing]), clock

    def test_real_pmu23_nested_analysis_mixed_markets_and_paris_clocks(self):
        p, fetch, clock = self.real_pmu()
        item = s.parse_combine(p, '2026-10-23', fetch, clock, source='rdj_football_duo')
        self.assertEqual(item['sourceId'], '74768')
        self.assertEqual(item['selection']['totalOdds'], 2.0)
        self.assertEqual([leg['selection']['betType'] for leg in item['legs']], ['match_winner','btts'])
        self.assertEqual([leg['startsAtUtc'] for leg in item['legs']], ['2026-10-23T18:30:00Z','2026-10-23T18:45:00Z'])
        self.assertEqual(item['curation']['bookmaker'], 'PMU PLAY Sport')
        self.assertTrue(all('Excluded promotion' not in str(leg['analysis']) for leg in item['legs']))
        translator = LocalTranslator(request=lambda *args:self.fail('Market translation must be deterministic'))
        english = translator.market(item['selection']['label']['fr'], item)
        self.assertIn('VfB Stuttgart to win', english)
        self.assertIn('Both teams to score', english)

    def test_real_mixed_ticket_is_not_mislabelled_as_goals(self):
        p, fetch, clock = self.real_pmu()
        with self.assertRaisesRegex(ValueError, 'goals_requires'):
            s.parse_combine(p,'2026-10-23',fetch,clock,source='rdj_football_goals')

    def test_sponsored_content_inside_analysis_is_still_refused(self):
        p, fetch, clock = self.real_pmu()
        p = rdj.FetchedPage(p.url, p.html.replace('Regression fixture:', '<a rel="sponsored">Bookmaker promotion</a> Regression fixture:', 1))
        with self.assertRaisesRegex(ValueError, 'analysis_contains_ad'):
            s.parse_combine(p,'2026-10-23',fetch,clock,source='rdj_football_duo')

    def test_combi_clock_qualifiers_ambiguity_and_wrong_weekday_never_ignored(self):
        for text in ['20h30 UTC','20h30 ou 21h30','20h30 Europe/Paris','25h30','20h70','mercredi 20h30']:
            p,fetch,clock=self.real_pmu();bad=rdj.FetchedPage(p.url,p.html.replace('(20h30)','('+text+')'))
            with self.subTest(text=text), self.assertRaisesRegex(ValueError,'combi_displayed_(?:time|weekday)_conflict'):
                s.parse_combine(bad,'2026-10-23',fetch,clock,source='rdj_football_duo')

    def context(self):
        p = page('combine-2026-10-21')
        a, b = page('football-lille-2026-10-21'), page('football-como-2026-10-21')
        listing = rdj.FetchedPage(s.SOURCES['rdj_football_analysis'], '<a href="'+a.url+'">Lire l’analyse</a><a href="'+b.url+'">Lire l’analyse</a>')
        return p, Offline([a,b,listing])

    def test_same_real_publisher_ticket_qualifies_for_duo_and_goals(self):
        for source in ['rdj_football_duo','rdj_football_goals']:
            p, fetch = self.context()
            item = s.parse_combine(p,'2026-10-21',fetch,fixture_clock,source=source)
            self.assertEqual(item['sourceId'],'74744')
            self.assertEqual(item['selection']['totalOdds'],2.17)
            self.assertEqual(item['selection']['betType'],'accumulator')
            self.assertEqual(item['curation']['sourceUrl'],p.url)
            self.assertTrue(all(leg['selection']['odds'] is None for leg in item['legs']))
            runner.validate_item(item,source,'2026-10-21',s.iso('2026-10-21T08:00:00Z'),30)

    def test_one_btts_publisher_ticket_has_duo_priority_and_goals_can_run_alone(self):
        p,fetch=self.context()
        for url in s.COMBINE_INDEXES:fetch.pages[url]=rdj.FetchedPage(url,'<a href="'+p.url+'">COMBI FOOT</a>')
        fetch.pages[p.url]=p
        kwargs={'now':s.iso('2026-10-21T08:00:00Z'),'resolver':fixture_clock}
        duo=s.collect_combine('2026-10-21',fetch,source='rdj_football_duo',**kwargs)
        self.assertEqual(len(duo['items']),1)
        goals=s.collect_combine('2026-10-21',fetch,source='rdj_football_goals',exclude_ticket_fingerprints={s.ticket_fingerprint(duo['items'][0])},**kwargs)
        self.assertEqual(goals['items'],[])
        alone=s.collect_combine('2026-10-21',fetch,source='rdj_football_goals',**kwargs)
        self.assertEqual(len(alone['items']),1)
        # Another article ID with the same composition remains the same ticket.
        copied=deepcopy(duo['items'][0]);copied['sourceId']='99999'
        self.assertEqual(s.ticket_fingerprint(copied),s.ticket_fingerprint(duo['items'][0]))
        copied['legs'][0]['sourceId']='9999999'
        self.assertEqual(s.ticket_fingerprint(copied),s.ticket_fingerprint(duo['items'][0]))

    def test_mixed_ticket_preferred_and_a_distinct_goal_composition_remains(self):
        p,fetch,clock=self.real_pmu()
        # Explicit synthetic second article exercises classification only. It
        # is never part of a live preview or represented as a real publisher pick.
        other_url=p.url.replace('/74768-','/99999-')
        other=rdj.FetchedPage(other_url,p.html.replace('Victoire Stuttgart + Brest - Nice : Les 2 marquent','Les deux équipes marquent VfB Stuttgart - M Gladbach + Brest - Nice'))
        for url in s.COMBINE_INDEXES:fetch.pages[url]=rdj.FetchedPage(url,'<a href="'+other_url+'">COMBI</a><a href="'+p.url+'">COMBI</a>')
        fetch.pages[p.url]=p;fetch.pages[other_url]=other
        kwargs={'now':s.iso('2026-10-23T08:00:00Z'),'resolver':clock}
        duo=s.collect_combine('2026-10-23',fetch,source='rdj_football_duo',**kwargs)
        self.assertEqual([item['sourceId'] for item in duo['items']],['74768'])
        goals=s.collect_combine('2026-10-23',fetch,source='rdj_football_goals',exclude_ticket_fingerprints={s.ticket_fingerprint(duo['items'][0])},**kwargs)
        self.assertEqual([item['sourceId'] for item in goals['items']],['99999'])

    def test_duo_total_outside_range_refused_without_repricing(self):
        p, fetch = self.context()
        bad = rdj.FetchedPage(p.url,p.html.replace('2,17','4,17'))
        with self.assertRaisesRegex(ValueError,'duo_requires'):
            s.parse_combine(bad,'2026-10-21',fetch,fixture_clock,source='rdj_football_duo')

    def test_multisport_and_source_catalogue_keys_are_distinct(self):
        self.assertEqual(len(s.SOURCES),7)
        self.assertIn('rdj_multisport_analysis',s.SOURCES)
        root = rdj.Document('<a href="https://outside.invalid/combine-23-10-2026.html">COMBI</a><a href="'+s.HOST+'/paris-sportifs/sport-news/news-pmu-sport/74768-combine-23-10-2026.html">COMBI</a>').root
        self.assertEqual(s._dated_combine_links(root,'2026-10-23'),[s.HOST+'/paris-sportifs/sport-news/news-pmu-sport/74768-combine-23-10-2026.html'])

    def test_multisport_outage_is_distinct_from_a_successfully_empty_index(self):
        class Down:
            def html(self,url):raise ValueError('source_http_503')
        result=s.collect_multisport('2026-10-23',Down(),now=s.iso('2026-10-23T12:00:00Z'),resolver=lambda *a:None)
        self.assertEqual(result['status'],'source_incomplete')
        self.assertEqual(len(result['issues']),2)
        class OneAvailable:
            def html(self,url):
                if url==s.MULTISPORT_INDEXES[0]:return rdj.FetchedPage(url,'<h1>Basket</h1>')
                raise ValueError('source_http_503')
        result=s.collect_multisport('2026-10-23',OneAvailable(),now=s.iso('2026-10-23T12:00:00Z'),resolver=lambda *a:None)
        self.assertEqual(result['status'],'source_absent')


class NbaNightTests(unittest.TestCase):
    def item(self, utc='2026-10-24T05:30:00Z', edition='2026-10-23'):
        return {'startsAtUtc':utc, 'editionDate':edition, 'sport':{'key':'basketball'},'competition':{'name':'NBA'},
            'teams':{'home':{'name':'Milwaukee Bucks'},'away':{'name':'Chicago Bulls'}},
            'editionConvention':'nba_following_night','scheduleProof':{'sourceUrl':'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261024',
            'sourceId':'123','method':'provider_schedule','provider':'espn','matchedParticipants':['Milwaukee Bucks','Chicago Bulls'],
            'startsAtUtc':utc,'status':'upcoming'}}

    def test_nba_following_night_is_bounded_and_preserves_edition(self):
        item = self.item()
        self.assertTrue(s.eligible(item,'2026-10-23',s.iso('2026-10-23T12:00:00Z')))
        self.assertEqual(item['editionDate'],'2026-10-23')
        official=self.item();official['scheduleProof'].update(method='official_schedule',provider='nba',sourceId='0022600050',sourceUrl='https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json')
        self.assertTrue(s.eligible(official,'2026-10-23',s.iso('2026-10-23T12:00:00Z')))
        for utc in ['2026-10-24T10:00:00Z','2026-10-25T00:00:00Z']:
            self.assertFalse(s.eligible(self.item(utc),'2026-10-23',s.iso('2026-10-23T12:00:00Z')))

    def test_nba_night_does_not_leak_to_other_sport_or_competition(self):
        for sport, competition in [('football','NBA'),('volleyball','NBA'),('basketball','WNBA'),('basketball','Euroleague')]:
            item = self.item(); item['sport']['key']=sport;item['competition']['name']=competition
            self.assertFalse(s.eligible(item,'2026-10-23',s.iso('2026-10-23T12:00:00Z')))
        item=self.item();item.pop('scheduleProof')
        self.assertFalse(s.eligible(item,'2026-10-23',s.iso('2026-10-23T12:00:00Z')))
        item=self.item();item['scheduleProof']['sourceUrl']='https://outside.invalid/schedule'
        self.assertFalse(s.eligible(item,'2026-10-23',s.iso('2026-10-23T12:00:00Z')))
        for malformed in [None,[],True,'not-a-proof']:
            item=self.item();item['scheduleProof']=malformed
            self.assertFalse(s.eligible(item,'2026-10-23',s.iso('2026-10-23T12:00:00Z')))

    def test_nba_night_cutoff_uses_paris_dst_not_fixed_offset(self):
        # Europe/Paris falls back on25October: 10:59Z is11:59,11:00Z noon.
        self.assertTrue(s.eligible(self.item('2026-10-25T10:59:00Z','2026-10-24'),'2026-10-24',s.iso('2026-10-24T12:00:00Z')))
        self.assertFalse(s.eligible(self.item('2026-10-25T11:00:00Z','2026-10-24'),'2026-10-24',s.iso('2026-10-24T12:00:00Z')))

    def test_translation_weekdays_use_source_edition_not_following_night(self):
        item=self.item('2026-10-24T01:30:00Z','2026-10-23')
        self.assertEqual(_fixture(item)['reference_date'],'2026-10-23')
        # On the Friday source edition, last Friday means the prior week;
        # the same text must not be reinterpreted as the Friday just ended.
        _,proof=validate_english_sentence('Milwaukee Bucks a gagné vendredi dernier.',
            'Milwaukee Bucks won last Friday.',item)
        self.assertTrue(proof['passed'],proof)
        source='Milwaukee Bucks a gagné vendredi dernier.'
        target='Milwaukee Bucks won Friday last week.'
        self.assertEqual(_relative_weekday_errors(source,target,_fixture(item)['reference_date']),[])
        self.assertEqual(_relative_weekday_errors(source,target,'2026-10-24'),['relative_weekday_shifted_to_previous_calendar_week'])


if __name__ == '__main__':
    unittest.main()
