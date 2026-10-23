"""Match participants to official schedules or explicitly identified ESPN data."""
from datetime import date, datetime, timedelta, timezone
import json, re, unicodedata, urllib.request

ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/'
LEAGUE_NAMES = {
    'fra.1': ('ligue 1', 'ligue1', 'french ligue 1', 'france - ligue 1', "ligue 1 mcdonald's", 'ligue 1 mcdonalds'),
    'fra.2': ('ligue 2', 'ligue2', 'french ligue 2', 'france - ligue 2', 'ligue 2 bkt'),
    'eng.1': ('premier league', 'premierleague', 'english premier league', 'angleterre - premier league'),
    'esp.1': ('liga', 'la liga', 'laliga', 'laliga ea sports', 'spanish laliga', 'espagne - liga'),
    'ita.1': ('serie a', 'serie a enilive', 'italian serie a', 'italie - serie a'),
    'ger.1': ('bundesliga', 'german bundesliga', 'allemagne - bundesliga'),
}


def _label(value):
    if not isinstance(value, str):
        return ''
    value = ''.join(c for c in unicodedata.normalize('NFKD', value.casefold()) if not unicodedata.combining(c))
    return re.sub(r'\s+', ' ', value.replace('\u2019', "'")).strip()


def _identity(value):
    return re.sub('[^a-z0-9]', '', _label(value))


PROVIDER_LEAGUES = {name: league for league, names in LEAGUE_NAMES.items() for name in names}
UEFA_COMPETITIONS = {
    'ligue europa': 14, 'europa league': 14, 'uefa europa league': 14,
    'ligue des champions': 3, 'champions league': 3, 'uefa champions league': 3,
    'ligue conference': 19, 'ligue europa conference': 19,
    'conference league': 19, 'uefa conference league': 19, 'europa conference league': 19,
}
# Finite spelling/name aliases only. No surname, substring or edit-distance match.
FOOTBALL_NAME_GROUPS = (
    ('rennes', 'stade rennais', 'stade rennais fc'), ('marseille', 'om', 'olympique de marseille'),
    ('lyon', 'ol', 'olympique lyonnais'), ('paris saint-germain', 'psg'), ('monaco', 'as monaco'),
    ('nice', 'ogc nice'), ('lens', 'rc lens'), ('lille', 'losc lille', 'lille osc'),
    ('toulouse', 'toulouse fc'), ('angers', 'angers sco'), ('auxerre', 'aj auxerre'),
    ('nantes', 'fc nantes'), ('le havre', 'le havre ac'), ('lorient', 'fc lorient'),
    ('montpellier', 'montpellier hsc'), ('reims', 'stade de reims'), ('metz', 'fc metz'),
    ('strasbourg', 'rc strasbourg', 'rc strasbourg alsace'),
    ('nancy', 'as nancy lorraine'), ('laval', 'stade laval', 'stade lavallois', 'stade lavallois mayenne fc'),
    ('clermont', 'clermont foot', 'clermont foot 63'), ('guingamp', 'ea guingamp', 'en avant guingamp'),
    ('dunkerque', 'usl dunkerque'), ('grenoble', 'grenoble foot 38'), ('pau', 'pau fc'),
    ('annecy', 'fc annecy'), ('sochaux', 'fc sochaux', 'fc sochaux-montbeliard'),
    ('bastia', 'sc bastia'), ('rodez', 'rodez aveyron'), ('red star', 'red star fc'),
    ('tottenham', 'tottenham hotspur'), ('wolverhampton', 'wolverhampton wanderers', 'wolves'),
    ('nottingham forest', 'nottingham'), ('manchester city', 'man city'),
    ('manchester united', 'man united'), ('newcastle', 'newcastle united'), ('leeds', 'leeds united'),
    ('leicester', 'leicester city'), ('brighton', 'brighton & hove albion'),
    ('west ham', 'west ham united'), ('bournemouth', 'afc bournemouth'),
    ('athletic bilbao', 'athletic club'), ('betis seville', 'real betis', 'betis'),
    ('fc seville', 'seville', 'sevilla', 'sevilla fc'), ('alaves', 'deportivo alaves'),
    ('osasuna', 'ca osasuna'), ('milan ac', 'ac milan', 'milan'),
    ('juventus', 'juventus fc'), ('inter milan', 'internazionale', 'inter'),
    ('naples', 'ssc naples', 'napoli'), ('atalanta', 'atalanta bergame'),
    ('lazio', 'lazio rome'), ('as rome', 'as roma', 'roma'), ('hellas verone', 'hellas verona'),
    ('bayern munich', 'bayern munchen'), ('mayence', 'mainz', 'mainz 05'),
    ('fribourg', 'freiburg', 'sc freiburg'), ('cologne', 'fc koln'),
    ('hambourg', 'hamburger sv'), ('st pauli', 'fc st pauli'),
    ('union berlin', 'fc union berlin', '1. fc union berlin'),
    ('hoffenheim', 'tsg hoffenheim', 'tsg 1899 hoffenheim'),
    ('leverkusen', 'bayer leverkusen', 'bayer 04 leverkusen'),
)
FOOTBALL_ALIASES = {_identity(name): _identity(names[0]) for names in FOOTBALL_NAME_GROUPS for name in names}
TENNIS_ALIASES = {_identity('Daniel Vallejo'): _identity('Adolfo Daniel Vallejo')}
UNKNOWN_ACTORS = {'tbd', 'tba', 'bye', 'qualifier', 'qualifie', 'qualifying', 'unknown', 'inconnu', 'adeterminer'}


def _provider_name(value, football=False):
    name = _identity(value)
    if (not name or name in UNKNOWN_ACTORS or
        re.fullmatch(r'(?:tbd|tba|qualifier|qualifie|luckylo[os]er|winner|loser|vainqueur|perdant|q|ll)\d*', name) or
        name.startswith(('winnerof', 'loserof', 'vainqueurde', 'perdantde'))):
        return ''
    return (FOOTBALL_ALIASES if football else TENNIS_ALIASES).get(name, name)


def _source_id(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return ''
    result = str(value).strip()
    return result if result and result != '0' else ''


def _provider_time(competition, target):
    status = competition.get('status', {}).get('type', {})
    if competition.get('timeValid') is not True or status.get('state') != 'pre' or status.get('name') != 'STATUS_SCHEDULED':
        return None
    description = ' '.join(_label(status.get(key, '')) for key in ('description', 'detail', 'shortDetail'))
    if status.get('completed') is True or re.search(r'\b(?:tbd|tba|postponed|cancell?ed|delayed|undetermined|to be determined)\b', description):
        return None
    raw = competition.get('date')
    if not isinstance(raw, str) or 'T' not in raw:
        return None
    try:
        moment = datetime.fromisoformat(raw.replace('Z', '+00:00'))
    except ValueError:
        return None
    if moment.tzinfo is None or moment.utcoffset() != timedelta(0) or abs((moment.date() - target).days) > 1:
        return None
    start = competition.get('startDate')
    if start is not None:
        try:
            other = datetime.fromisoformat(start.replace('Z', '+00:00'))
        except (AttributeError, TypeError, ValueError):
            return None
        if other.tzinfo is None or other.utcoffset() != timedelta(0) or other != moment:
            return None
    return moment.isoformat().replace('+00:00', 'Z')

def _name(value):
    value=unicodedata.normalize('NFKD',str(value)).encode('ascii','ignore').decode().lower()
    value=re.sub(r'\b(fc|afc|ac|cf|sc|fk|nk|sv)\b','',value)
    value=re.sub('[^a-z0-9]','',value)
    return {'om':'marseille','ol':'lyon','bayer04leverkusen':'leverkusen','bayerleverkusen':'leverkusen',
            'oficrete':'oficrete','psg':'parissaintgermain','necnijmegen':'nec','necnymegen':'nec',
            'necnimegue':'nec','dinamozagreb':'dinamozagreb','gnkdinamo':'dinamozagreb','lechpoznan':'lechpoznan'}.get(value,value)

def _get(url):
    headers = {'User-Agent': 'Mozilla/5.0 (compatible; JournalDuParieur/1.0; schedule verification)',
               'Accept': 'application/json'}
    if url.startswith('https://cdn.nba.com/'):
        headers.update(Referer='https://www.nba.com/', Origin='https://www.nba.com')
    request=urllib.request.Request(url,headers=headers)
    with urllib.request.urlopen(request,timeout=25) as response:
        raw=response.read(8_000_001)
    if len(raw)>8_000_000:raise ValueError('Official schedule exceeds input limit')
    return json.loads(raw)

class OfficialKickoffs:
    def __init__(self,fetch_json=None):self.fetch=fetch_json or _get;self.cache={};self.provider_errors=set()
    def _load(self,url):
        if url not in self.cache:self.cache[url]=self.fetch(url)
        return self.cache[url]
    def _provider_pages(self, routes, target):
        for route in routes:
            for offset in (-1, 0, 1):
                day = target + timedelta(days=offset)
                url = ESPN_BASE + route + '/scoreboard?dates=' + day.strftime('%Y%m%d')
                if url in self.provider_errors:
                    raise ValueError('ESPN scoreboard unavailable during this resolver run')
                try:
                    data = self._load(url)
                except (OSError, ValueError, TypeError):
                    self.provider_errors.add(url)
                    raise
                if not isinstance(data, dict) or not isinstance(data.get('events'), list):
                    self.provider_errors.add(url)
                    raise ValueError('Unexpected ESPN scoreboard schema')
                yield url, data
    @staticmethod
    def _provider_unique(candidates):
        unique = {}
        for proof in candidates:
            key = (proof.get('league_id'), proof.get('tournament_id'), proof['source_id'])
            previous = unique.get(key)
            if previous and any(previous.get(field) != proof.get(field) for field in ('kickoff_utc', 'match_type', 'tournament_name')):
                return None
            unique.setdefault(key, proof)
        return next(iter(unique.values())) if len(unique) == 1 else None
    def _provider(self, fixture, target, league=None):
        football = league is not None
        requested = [_provider_name(fixture.get(key), football) for key in ('home', 'away')]
        if not all(requested) or requested[0] == requested[1]:
            return None
        routes = ['soccer/' + league] if football else ['tennis/atp', 'tennis/wta']
        candidates = []
        try:
            for url, data in self._provider_pages(routes, target):
                if football and not any(isinstance(item, dict) and item.get('slug') == league for item in data.get('leagues', [])):
                    return None
                for event in data['events']:
                    if not isinstance(event, dict):
                        return None
                    groups = [{'competitions': event.get('competitions', [])}] if football else event.get('groupings', [])
                    for group in groups:
                        match_type = group.get('grouping', {}).get('slug')
                        if not football and match_type not in ('mens-singles', 'womens-singles'):
                            continue
                        for competition in group.get('competitions', []):
                            moment = _provider_time(competition, target)
                            match_id = _source_id(competition.get('id'))
                            participants = competition.get('competitors', [])
                            if moment is None or not match_id or len(participants) != 2:
                                continue
                            if football:
                                if any(item.get('type') != 'team' for item in participants):
                                    continue
                                sides = {item.get('homeAway'): item for item in participants}
                                if set(sides) != {'home', 'away'}:
                                    continue
                                ordered = [sides[side] for side in ('home', 'away')]
                                names = [{_provider_name(item.get('team', {}).get(key), True) for key in ('displayName', 'name', 'shortDisplayName')} - {''} for item in ordered]
                                if not all(requested[i] in names[i] for i in (0, 1)):
                                    continue
                                orientation = 'home_away'
                            else:
                                if competition.get('type', {}).get('slug') != match_type or any(item.get('type') != 'athlete' for item in participants):
                                    continue
                                names = [{_provider_name(item.get('athlete', {}).get(key)) for key in ('fullName', 'displayName')} - {''} for item in participants]
                                if any(not nameset for nameset in names):
                                    continue
                                if requested[0] in names[0] and requested[1] in names[1]:
                                    orientation = 'same_order'
                                elif requested[0] in names[1] and requested[1] in names[0]:
                                    orientation = 'reversed'
                                else:
                                    continue
                                circuit = _label(fixture.get('competition', ''))
                                if (circuit == 'atp' or circuit.startswith('atp ')) and match_type != 'mens-singles':
                                    continue
                                if (circuit == 'wta' or circuit.startswith('wta ')) and match_type != 'womens-singles':
                                    continue
                            proof = {'kickoff_utc': moment, 'source_url': url, 'source_id': match_id,
                                'method': 'provider_schedule', 'provider': 'ESPN', 'time_valid': True, 'status': 'pre',
                                'matched_participants': [fixture['home'], fixture['away']], 'orientation': orientation}
                            if football:
                                proof['league_id'] = league
                            else:
                                tournament_id = _source_id(event.get('id'))
                                tournament_name = event.get('name')
                                if not tournament_id or not isinstance(tournament_name, str) or not tournament_name.strip():
                                    continue
                                proof.update(tournament_id=tournament_id, tournament_name=tournament_name, match_type=match_type)
                            candidates.append(proof)
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            return None
        return self._provider_unique(candidates)
    def __call__(self,fixture,edition):
        target=date.fromisoformat(edition)
        home,away=_name(fixture['home']),_name(fixture['away'])
        sport=str(fixture.get('sport','')).lower()
        candidates=[]
        if sport in ('football','foot','soccer'):
            league = PROVIDER_LEAGUES.get(_label(fixture.get('competition', '')))
            if league:
                return self._provider(fixture, target, league)
        elif sport == 'tennis':
            return self._provider(fixture, target)
        if sport in ('football','foot','soccer'):
            competition_id = UEFA_COMPETITIONS.get(_label(fixture.get('competition', '')))
            if competition_id is None:
                return None
            # UEFA seasons end in the following calendar year after summer.
            season=target.year+(target.month>=7)
            for competition in (competition_id,):
                url=f'https://match.uefa.com/v5/matches?competitionId={competition}&seasonYear={season}&offset=0&limit=500&order=ASC'
                try:data=self._load(url)
                except (OSError,ValueError):continue
                rows=data if isinstance(data,list) else data.get('matches',data.get('data',[]))
                for row in rows:
                    if not isinstance(row, dict) or row.get('status') != 'UPCOMING':
                        continue
                    ht=row.get('homeTeam',{});at=row.get('awayTeam',{})
                    names=lambda team:{_name(team.get(k,'')) for k in ('internationalName','displayName','name','translations') if isinstance(team.get(k),str)}
                    if home not in names(ht) or away not in names(at):continue
                    raw=row.get('kickOffTime',{}).get('dateTime')
                    self._candidate(candidates,raw,target,url,row.get('id'))
        elif sport in ('basket','basketball','basket-ball','nba'):
            if _label(fixture.get('competition', '')) not in {'nba', 'national basketball association'}:
                return None
            url='https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json'
            try:data=self._load(url)
            except (OSError,ValueError):return None
            for day in data.get('leagueSchedule',{}).get('gameDates',[]):
                for game in day.get('games',[]):
                    if (type(game.get('gameStatus')) is not int or game['gameStatus'] != 1 or
                        game.get('postponedStatus', 'N') != 'N' or
                        re.search(r'\b(?:tbd|tba|postponed|cancell?ed|delayed|suspended)\b',
                                  _label(game.get('gameStatusText', '')))):
                        continue
                    def names(team):
                        city=team.get('teamCity','');name=team.get('teamName','')
                        return {_name(city+' '+name),_name(name),_name(team.get('teamTricode',''))}
                    if home in names(game.get('homeTeam',{})) and away in names(game.get('awayTeam',{})):
                        self._candidate(candidates,game.get('gameDateTimeUTC'),target,url,game.get('gameId'))
        # A common kickoff is not an event identity. Two IDs remain ambiguous,
        # and one ID returned with conflicting start times is also rejected.
        unique = {}
        for candidate in candidates:
            key = (candidate['source_url'], candidate['source_id'])
            if key in unique and unique[key]['kickoff_utc'] != candidate['kickoff_utc']:
                return None
            unique[key] = candidate
        return next(iter(unique.values())) if len(unique)==1 else None
    @staticmethod
    def _candidate(out,raw,target,url,source_id):
        source_id = _source_id(source_id)
        if not raw or not source_id:return
        try:when=datetime.fromisoformat(raw.replace('Z','+00:00'))
        except (TypeError,ValueError):return
        if when.tzinfo is None:return
        when=when.astimezone(timezone.utc)
        if abs((when.date()-target).days)>1:return
        out.append({'kickoff_utc':when.isoformat().replace('+00:00','Z'),'source_url':url,'source_id':source_id,'method':'official_schedule'})
