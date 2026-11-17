"""Bounded SportyTrader daily coupon, using its explicit editorial picks.

This is a composition policy, not a calibrated forecast. We never turn the
automatic probability table into an author's recommendation. Every selected
price comes from the exact full-match market and the same named bookmaker.
French publisher clocks are interpreted in Europe/Paris (including DST), then
stored in UTC. No prose, hidden guesses, live betting or invented prices.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from itertools import combinations
import json
import re
import time
from urllib.parse import urljoin, urlsplit, urlunsplit

from .calendar import paris_timezone
from .http import FetchError
from .vendor import rdj_collector as html

SOURCE = 'wintips_daily_vip'
HOST = 'https://www.sportytrader.com'
SOURCE_URL = HOST + '/pronostics/'
INDEX_URL = SOURCE_URL + 'aujourdhui/'
PREDICTION_PATH = re.compile(r'/pronostics/[a-z0-9-]+-(\d{1,12})/')
ODDS_PATH = re.compile(r'/cotes/[a-z0-9-]+-(\d{1,12})/')
MAX_CANDIDATES = 16
MAX_AGE_SECONDS = 900
SPORTS = {'football': ('football', 'Football'), 'tennis': ('tennis', 'Tennis'),
          'basket': ('basketball', 'Basketball'), 'rugby': ('rugby', 'Rugby'),
          'hockey': ('ice_hockey', 'Hockey'), 'baseball': ('baseball', 'Baseball'),
          'volley': ('volleyball', 'Volleyball'), 'handball': ('handball', 'Handball')}
BOOKMAKERS = {'unibet': 'Unibet', 'betclic': 'Betclic', 'winamax': 'Winamax',
              'bet365': 'Bet365', 'bwin': 'Bwin', 'pmu': 'PMU Play',
              'parionssport': 'Parions Sport', 'netbet': 'Netbet',
              'vbet': 'Vbet', 'zebet': 'Zebet', 'betsson': 'Betsson'}


class DailyVipError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(value, code):
    if not value:
        raise DailyVipError(code)


def canonical_url(value, *, kind=None):
    try:
        p = urlsplit(urljoin(HOST, value))
        require(p.scheme == 'https' and p.hostname == 'www.sportytrader.com'
                and p.port in (None, 443) and not p.username and not p.password
                and not p.query and not p.fragment, 'daily_vip_untrusted_source_url')
        if kind:
            pattern = PREDICTION_PATH if kind == 'prediction' else ODDS_PATH
            require(pattern.fullmatch(p.path), 'daily_vip_source_path_invalid')
        return urlunsplit(('https', 'www.sportytrader.com', p.path, '', ''))
    except (ValueError, TypeError) as exc:
        if isinstance(exc, DailyVipError):
            raise
        raise DailyVipError('daily_vip_untrusted_source_url') from None


def utc_text(value):
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def parse_utc(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', value),
            'daily_vip_explicit_utc_required')
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def one(nodes, code):
    require(len(nodes) == 1, code)
    return nodes[0]


def children(node, tag=None):
    return [n for n in node.children if not isinstance(n, str) and (tag is None or n.tag == tag)]


def key(value):
    # Typographic dashes/spaces may differ between the hero and the author's
    # conclusion (Bosnie-Herzégovine / Bosnie Herzégovine), without aliases or
    # fuzzy matching changing which participant is meant.
    return html.text(re.sub(r'[-–—]', ' ', html.folded(html.text(value)))).strip(' .!')


def document(entry, expected_url, now):
    require(entry.get('status') == 200, 'daily_vip_source_http_' + str(entry.get('status')))
    require(canonical_url(entry.get('final_url')) == expected_url, 'daily_vip_source_redirected')
    require(isinstance(entry.get('saved'), (float, int)), 'daily_vip_observation_time_missing')
    observed = datetime.fromtimestamp(entry['saved'], timezone.utc)
    require(-60 <= (now - observed).total_seconds() <= MAX_AGE_SECONDS, 'daily_vip_source_stale')
    require(isinstance(entry.get('body'), str) and len(entry['body'].encode()) <= 8_000_000,
            'daily_vip_source_too_large')
    return html.Document(entry['body']).root, observed


def discovery(root):
    def links_in(section):
        links = []
        for n in html.find(section, lambda n: n.tag == 'a' and n.attrs.get('href')):
            try:
                url = canonical_url(n.attrs['href'], kind='prediction')
            except DailyVipError:
                continue
            if url not in links:
                links.append(url)
        return links
    # The daily index groups its cards by sport. Round-robin these bounded
    # sections so a busy football Saturday cannot hide all tennis/basketball.
    sections = html.find(root, lambda n: n.tag == 'div' and n.has_class('pronostics-wrapper'))
    groups = [links_in(section) for section in sections] if sections else [links_in(root)]
    result = []
    for index in range(MAX_CANDIDATES):
        for group in groups:
            if index < len(group) and group[index] not in result:
                result.append(group[index])
                if len(result) == MAX_CANDIDATES:
                    return result
    return result


def breadcrumb(root, source_url):
    paths = []
    for n in html.find(root, lambda n: n.tag == 'script' and n.attrs.get('type') == 'application/ld+json'):
        try:
            data = json.loads(''.join(c for c in n.children if isinstance(c, str)))
        except (ValueError, TypeError):
            continue
        for value in data if isinstance(data, list) else [data]:
            if isinstance(value, dict) and value.get('@type') == 'BreadcrumbList':
                paths.append(value.get('itemListElement'))
    trail = one(paths, 'daily_vip_breadcrumb_missing_or_ambiguous')
    require(isinstance(trail, list) and len(trail) >= 5, 'daily_vip_breadcrumb_invalid')
    require(canonical_url(trail[-1]['item']) == source_url, 'daily_vip_breadcrumb_identity_conflict')
    sports_path = urlsplit(canonical_url(trail[2]['item'])).path
    match = re.fullmatch(r'/(?:pronostics|cotes)/([a-z-]+)/', sports_path)
    require(match and match[1] in SPORTS, 'daily_vip_sport_unsupported')
    sport, name = SPORTS[match[1]]
    competition = html.text(trail[3].get('name', ''))
    if urlsplit(source_url).path.startswith('/cotes/'):
        competition = re.sub(r'^Pari\s+', '', competition)
    require(competition and len(competition) < 180, 'daily_vip_competition_invalid')
    return {'key': sport, 'name': name}, competition


def safe_logo(value):
    try:
        p = urlsplit(value or '')
        if (p.scheme == 'https' and p.hostname == 'static.sportytrader.com' and not p.username
                and not p.password and p.port in (None, 443) and not p.query and not p.fragment
                and re.fullmatch(r'/icons/[a-z_/-]+/(?:teams|countries)/\d+x\d+/[a-z0-9_.-]+\.(?:webp|png|jpe?g)', p.path)):
            return value
    except ValueError:
        pass
    return None


def participant(node):
    names = [n.plain() for n in children(node, 'span') if n.has_class('font-semibold')]
    name = one(names, 'daily_vip_participant_name_ambiguous')
    require(1 <= len(name) <= 150, 'daily_vip_participant_name_invalid')
    logos, flags = [], []
    for n in node.walk():
        if n.tag == 'img':
            url = n.attrs.get('src') or n.attrs.get('data-src')
            if url and '/icons/countries/' in url:
                # Countries live directly below /icons/countries, unlike teams.
                p = urlsplit(url)
                if (p.scheme == 'https' and p.hostname == 'static.sportytrader.com'
                        and not p.username and not p.password and p.port in (None, 443)
                        and re.fullmatch(r'/icons/countries/\d+x\d+/[a-z0-9_.-]+\.webp', p.path) and not p.query and not p.fragment):
                    flags.append(url)
            elif safe_logo(url):
                logos.append(url)
        style = n.attrs.get('style') or ''
        for value in re.findall(r"background-image:\s*url\(['\"]?([^'\")]+)", style):
            if safe_logo(value):
                logos.append(value)
    value = {'name': name}
    unique = sorted(set(logos))
    if len(unique) == 1:
        value['logo'] = unique[0]
    elif not unique and len(set(flags)) == 1:
        value['logo'] = flags[0]
    return value


def hero(root):
    # Match the bounded central clock cell, never publication dates, H1 dates,
    # the opponent's recent results or a related-match widget.
    clocks = html.find(root, lambda n: n.tag == 'div' and n.has_class('col-span-4')
                       and n.has_class('text-xs') and re.fullmatch(r'\d\d/\d\d/\d{4} \d\d:\d\d', n.plain()))
    clock = one(clocks, 'daily_vip_event_clock_missing_or_ambiguous')
    parts = children(clock.parent)
    require(len(parts) == 3 and parts[1] is clock, 'daily_vip_event_hero_ambiguous')
    local = datetime.strptime(clock.plain(), '%d/%m/%Y %H:%M')
    # During an autumn DST fold or spring gap a naive clock is not sufficient.
    tz = paris_timezone()
    instants = {local.replace(tzinfo=tz, fold=fold).astimezone(timezone.utc) for fold in (0, 1)
                if local.replace(tzinfo=tz, fold=fold).astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None) == local}
    require(len(instants) == 1, 'daily_vip_event_clock_dst_ambiguous')
    teams = {'home': participant(parts[0]), 'away': participant(parts[2])}
    require(key(teams['home']['name']) != key(teams['away']['name']), 'daily_vip_duplicate_participant')
    return teams, instants.pop()


def recommendation(root, teams, sport):
    # Explicit author conclusion only. Ignore the algorithm's different rows.
    picks = []
    for n in html.find(root, lambda n: n.tag == 'p' or n.tag == 'div' and n.has_class('prose') and n.has_class('dark:text-white')):
        match = re.search(r'Notre pronostic\s+(.+?)\s*:\s*(.+?)\s*[!.]?\s*$', n.plain(), re.I)
        if not match:
            continue
        expected = f"{teams['home']['name']} - {teams['away']['name']}"
        require(key(match[1]) == key(expected), 'daily_vip_recommendation_identity_conflict')
        picks.append(html.text(match[2]).rstrip(' !.'))
    raw = one(list(dict.fromkeys(picks)), 'daily_vip_editorial_recommendation_missing_or_ambiguous')
    value = key(raw)
    for side in ('home', 'away'):
        name = teams[side]['name']
        if value in {f'victoire de {key(name)}', f'{key(name)} gagne', f'victoire {key(name)}'}:
            return {'betType': 'match_winner', 'label': {'fr': f'Victoire de {name}', 'en': f'{name} to win'},
                    'side': '1' if side == 'home' else '2', 'raw': raw}
    if sport == 'football':
        found = re.fullmatch(r'(plus|moins) de (\d+[,.]\d+) buts(?: dans le match)?', value)
        if found:
            line = Decimal(found[2].replace(',', '.'))
            require(line in {Decimal('1.5'), Decimal('2.5'), Decimal('3.5')}, 'daily_vip_goal_line_unsupported')
            direction = 'Over' if found[1] == 'plus' else 'Under'
            return {'betType': 'over_under_goals', 'label': {'fr': f'{found[1].capitalize()} de {line} buts',
                    'en': f'{direction} {line} goals'}, 'line': str(line),
                    'side': '+' + str(line) if direction == 'Over' else '-' + str(line), 'raw': raw}
        if value in {'les deux equipes marquent', 'les 2 equipes marquent'}:
            return {'betType': 'btts', 'label': {'fr': 'Les deux équipes marquent',
                    'en': 'Both teams to score: Yes'}, 'side': 'Oui', 'raw': raw}
    raise DailyVipError('daily_vip_recommended_market_unsupported')


def prediction(entry, url, edition, now, lead=30):
    root, observed = document(entry, url, now)
    sport, competition = breadcrumb(root, url)
    teams, start = hero(root)
    require(start.astimezone(paris_timezone()).date().isoformat() == edition, 'daily_vip_wrong_edition')
    require(start > now + timedelta(minutes=lead), 'daily_vip_event_started_or_too_close')
    pick = recommendation(root, teams, sport['key'])
    links = set()
    for n in html.find(root, lambda n: n.tag == 'a' and n.attrs.get('data-trans') in {
            'global.match.odds.tab %sport%', 'tips.all.odds.link %homeTeam% %awayTeam%'}):
        try:
            links.add(canonical_url(n.attrs.get('href'), kind='odds'))
        except DailyVipError:
            continue
    odds_url = one(list(links), 'daily_vip_event_odds_link_missing_or_ambiguous')
    return {'sourceId': 'sp' + PREDICTION_PATH.fullmatch(urlsplit(url).path)[1], 'sourceUrl': url,
            'editionDate': edition, 'teams': teams, 'sport': sport, 'competition': {'name': competition},
            'startsAtUtc': utc_text(start), 'pick': pick, 'oddsUrl': odds_url,
            'predictionObservedAtUtc': utc_text(observed)}


def decimal_price(value):
    require(re.fullmatch(r'\d{1,2}(?:[.,]\d{1,3})?', value), 'daily_vip_price_invalid')
    try:
        result = Decimal(value.replace(',', '.'))
    except InvalidOperation:
        raise DailyVipError('daily_vip_price_invalid') from None
    require(result.is_finite() and Decimal('1') < result <= Decimal('20'), 'daily_vip_price_invalid')
    return result


def prices(entry, detail, now):
    root, observed = document(entry, detail['oddsUrl'], now)
    teams, start = hero(root)
    sport, competition = breadcrumb(root, detail['oddsUrl'])
    require([key(teams[s]['name']) for s in ('home', 'away')] ==
            [key(detail['teams'][s]['name']) for s in ('home', 'away')]
            and utc_text(start) == detail['startsAtUtc'] and sport == detail['sport']
            and key(competition) == key(detail['competition']['name']), 'daily_vip_odds_event_identity_conflict')
    pick = detail['pick']
    if pick['betType'] == 'over_under_goals':
        section = one(html.find(root, lambda n: n.attrs.get('id') == 'UNDER_OVER'), 'daily_vip_odds_market_missing')
        panel = one(html.find(section, lambda n: n.tag == 'div' and n.attrs.get('data-panel-select-target') == 'panel'
                             and n.attrs.get('data-panel-key') == 'UNDER_OVER_' + pick['line'].replace('.', '_')),
                    'daily_vip_odds_line_missing')
    elif pick['betType'] == 'match_winner':
        section = one(html.find(root, lambda n: n.attrs.get('id') == 'RESULT'), 'daily_vip_odds_market_missing')
        expected = {'Vainqueur', '1N2 - Vainqueur'}
        heading = one(html.find(section, lambda n: n.tag == 'span' and n.plain() in expected), 'daily_vip_odds_market_ambiguous')
        panel = heading.parent
    else:
        section = one(html.find(root, lambda n: n.attrs.get('id') == 'GOALS'), 'daily_vip_odds_market_missing')
        heading = one(html.find(section, lambda n: n.tag == 'span' and n.plain() in {'Les 2 équipes marquent', 'Les deux équipes marquent'}),
                      'daily_vip_odds_market_ambiguous')
        panel = heading.parent
    # Every row shares this exact heading. Hidden alternative goal lines cannot
    # supply another column, nor can a generic best-odds summary supply a book.
    rows = html.find(panel, lambda n: n.tag == 'a' and re.fullmatch(r'/book/[a-z0-9-]+/odds', n.attrs.get('href') or ''))
    require(rows, 'daily_vip_bookmaker_rows_missing')
    table = rows[0].parent
    require(all(n.parent is table for n in rows), 'daily_vip_bookmaker_rows_ambiguous')
    headings = one([n for n in children(table, 'div') if n.has_class('grid') and n.has_class('font-semibold')],
                   'daily_vip_odds_columns_missing')
    labels = [n.plain() for n in children(headings, 'span')]
    expected = ['Bookmaker', '1', '2', 'Bonus'] if pick['betType'] == 'match_winner' and sport['key'] != 'football' else None
    if pick['betType'] == 'match_winner' and sport['key'] == 'football':
        expected = ['Bookmaker', '1', 'N', '2', 'Bonus']
        labels = ['N' if label == 'X' else label for label in labels]
    if pick['betType'] == 'over_under_goals':
        expected = ['Bookmaker', '-' + pick['line'], '+' + pick['line'], 'Bonus']
    elif pick['betType'] == 'btts':
        expected = ['Bookmaker', 'Oui', 'Non', 'Bonus']
    require(labels == expected and labels.count(pick['side']) == 1, 'daily_vip_market_column_conflict')
    position = labels.index(pick['side']) - 1
    result = {}
    for row in rows:
        slug = row.attrs['href'].split('/')[2]
        if slug not in BOOKMAKERS:
            continue
        cells = children(row, 'div')
        require(len(cells) == len(labels) - 1, 'daily_vip_price_row_column_conflict')
        prices_in_row = [cell.plain() for cell in cells[:-1]]
        require(len(prices_in_row) == len(labels) - 2, 'daily_vip_price_row_column_conflict')
        try:
            amount = decimal_price(prices_in_row[position])
        except DailyVipError:
            # A suspended price at one bookmaker does not invalidate another
            # explicitly observed price for the exact same market.
            continue
        book = BOOKMAKERS[slug]
        require(book not in result, 'daily_vip_duplicate_bookmaker')
        result[book] = amount
    require(result, 'daily_vip_supported_bookmaker_missing')
    return result, utc_text(observed)


def choose(candidates, *, maximum=Decimal('3.5')):
    require(Decimal('3') <= maximum <= Decimal('3.5'), 'daily_vip_policy_exception_not_enabled')
    choices = []
    for count in (2, 3):
        for group in combinations(candidates, count):
            # Two pages for the same fixture or participants playing twice are
            # not independent legs. Never create correlated same-match bets.
            ids = [n['sourceId'] for n in group]
            names = [key(n['teams'][s]['name']) for n in group for s in ('home', 'away')]
            if len(set(ids)) != count or len(set(names)) != 2 * count:
                continue
            common = set.intersection(*(set(n['prices']) for n in group))
            for bookmaker in sorted(common):
                product = Decimal('1')
                for leg in group:
                    product *= leg['prices'][bookmaker]
                # Check unrounded product too, so 2.999 never rounds into3.
                if not Decimal('3') <= product <= maximum:
                    continue
                total = product.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
                ranking = (abs(product - Decimal('3.25')), count,
                           0 if bookmaker == 'Unibet' else 1, bookmaker, tuple(sorted(ids)))
                choices.append((ranking, group, bookmaker, total))
    if not choices:
        return None
    return min(choices, key=lambda n: n[0])[1:]


def compose(chosen, edition):
    group, bookmaker, total = chosen
    legs = []
    for candidate in sorted(group, key=lambda n: (n['startsAtUtc'], n['sourceId'])):
        value = {key: deepcopy(candidate[key]) for key in ('sourceId', 'sourceUrl', 'editionDate', 'teams', 'sport', 'competition', 'startsAtUtc')}
        label = f"{candidate['teams']['home']['name']} — {candidate['teams']['away']['name']}"
        value.update(source=SOURCE, kind='match', title={'fr': label, 'en': label}, summary=deepcopy(candidate['pick']['label']),
                     analysis={'fr': [], 'en': []}, status='upcoming',
                     selection={'betType': candidate['pick']['betType'], 'label': candidate['pick']['label'],
                                'odds': float(candidate['prices'][bookmaker])},
                     provenance={'predictionUrl': candidate['sourceUrl'], 'oddsUrl': candidate['oddsUrl'],
                                 'observedAtUtc': candidate['observedAtUtc'], 'market': candidate['pick']['raw'],
                                 'eventClockSourceUrl': candidate['sourceUrl']})
        legs.append(value)
    sports = {leg['sport']['key'] for leg in legs}
    return {'source': SOURCE, 'sourceId': 'daily-vip-' + edition, 'sourceUrl': SOURCE_URL,
            'editionDate': edition, 'kind': 'combine', 'title': {'fr': 'Combiné du jour', 'en': 'Daily accumulator'},
            'summary': {'fr': f'{len(legs)} rencontres · un seul coupon', 'en': f'{len(legs)} events · one accumulator'},
            'startsAtUtc': min(leg['startsAtUtc'] for leg in legs),
            'sport': legs[0]['sport'] if len(sports) == 1 else {'key': 'multisport', 'name': 'Multisport'},
            'competition': {'name': 'Combiné du jour'}, 'analysis': {'fr': [], 'en': []},
            'selection': {'label': {'fr': f'{len(legs)} sélections', 'en': f'{len(legs)} selections'},
                          'betType': 'accumulator', 'totalOdds': float(total)},
            'legs': legs, 'status': 'upcoming',
            'dailyVip': {'version': 1, 'publisher': 'SportyTrader', 'bookmaker': bookmaker,
                         'observedAtUtc': max(leg['provenance']['observedAtUtc'] for leg in legs),
                         'policy': {'minTotalOdds': 3, 'targetMaxTotalOdds': 3.5, 'maxTotalOdds': 3.5},
                         'result': {'status': 'pending'}}}


def validate(item, edition, now, lead=30):
    require(item.get('source') == SOURCE and item.get('sourceId') == 'daily-vip-' + edition
            and item.get('sourceUrl') == SOURCE_URL and item.get('editionDate') == edition
            and item.get('kind') == 'combine', 'daily_vip_item_identity_conflict')
    proof = item.get('dailyVip', {})
    require(proof.get('version') == 1 and proof.get('publisher') == 'SportyTrader'
            and proof.get('bookmaker') in BOOKMAKERS.values()
            and proof.get('policy') == {'minTotalOdds': 3, 'targetMaxTotalOdds': 3.5, 'maxTotalOdds': 3.5}
            and proof.get('result') == {'status': 'pending'}, 'daily_vip_provenance_invalid')
    legs = item.get('legs', [])
    require(2 <= len(legs) <= 3 and len({leg.get('sourceId') for leg in legs}) == len(legs), 'daily_vip_legs_invalid')
    product = Decimal('1')
    for leg in legs:
        require(leg.get('source') == SOURCE and leg.get('kind') == 'match' and leg.get('status') == 'upcoming'
                and leg.get('editionDate') == edition, 'daily_vip_leg_identity_invalid')
        canonical_url(leg.get('sourceUrl'), kind='prediction')
        start = parse_utc(leg.get('startsAtUtc'))
        require(start > now + timedelta(minutes=lead) and start.astimezone(paris_timezone()).date().isoformat() == edition,
                'daily_vip_event_started_or_too_close')
        provenance = leg.get('provenance', {})
        require(provenance.get('predictionUrl') == leg['sourceUrl'] and provenance.get('eventClockSourceUrl') == leg['sourceUrl']
                and provenance.get('market'), 'daily_vip_leg_provenance_invalid')
        canonical_url(provenance.get('oddsUrl'), kind='odds')
        observed = parse_utc(provenance.get('observedAtUtc'))
        require(-60 <= (now - observed).total_seconds() <= MAX_AGE_SECONDS, 'daily_vip_source_stale')
        require(leg.get('selection', {}).get('betType') in {'match_winner', 'over_under_goals', 'btts'}, 'daily_vip_market_unsupported')
        product *= decimal_price(str(leg['selection']['odds']))
    require(Decimal('3') <= product <= Decimal('3.5') and float(product.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)) == item.get('selection', {}).get('totalOdds'), 'daily_vip_total_odds_invalid')
    require(item.get('startsAtUtc') == min(leg['startsAtUtc'] for leg in legs)
            and proof.get('observedAtUtc') == max(leg['provenance']['observedAtUtc'] for leg in legs), 'daily_vip_aggregate_clock_invalid')


def collect(edition, fetcher, *, now, lead=30):
    issues, candidates = [], []
    started = time.monotonic()
    current = lambda: now + timedelta(seconds=time.monotonic() - started)
    require(date.fromisoformat(edition).isoformat() == edition, 'daily_vip_edition_invalid')
    index = fetcher.get(INDEX_URL)
    root, _ = document(index, INDEX_URL, current())
    links = discovery(root)
    for url in links:
        try:
            source = fetcher.get(url)
            detail = prediction(source, url, edition, current(), lead)
            odds = fetcher.get(detail['oddsUrl'])
            table, observed = prices(odds, detail, current())
            detail.update(prices=table, observedAtUtc=observed)
            candidates.append(detail)
        except (DailyVipError, FetchError, OSError, KeyError, TypeError) as exc:
            issues.append({'url': url, 'code': getattr(exc, 'code', 'daily_vip_candidate_unavailable')})
    chosen = choose(candidates)
    item = compose(chosen, edition) if chosen else None
    if item:
        validate(item, edition, current(), lead)
    return {'status': 'ready' if item else 'source_absent', 'items': [item] if item else [],
            'issues': issues,
            'dailyVipAudit': {'version': 1, 'discoveredCount': len(links), 'verifiedCandidateCount': len(candidates),
                'policy': 'explicit-publisher-picks-common-bookmaker-3-to-3.5-v1',
                'selectionMethod': 'closest-total-to-3.25-not-a-predicted-win-rate',
                'resultTracking': 'pending-needs-verified-settlement',
                'candidateSources': [{'predictionUrl': n['sourceUrl'], 'oddsUrl': n['oddsUrl'],
                     'sourceId': n['sourceId'], 'market': n['pick']['raw'], 'observedAtUtc': n['observedAtUtc'],
                     'bookmakers': sorted(n['prices'])} for n in candidates],
                'noCouponReason': None if item else 'no_verified_common_bookmaker_combination_in_target'}}
