"""Typed NBA/tennis adapter for the single versioned RDJ collector."""
from datetime import date, timedelta
import importlib
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

from .calendar import paris_timezone

INDEXES = {'nba': 'https://www.ruedesjoueurs.com/pronostics/nba-943387.html',
           'tennis': 'https://www.ruedesjoueurs.com/pronostics/tennis.html'}


def owner():
    hub = os.environ.get('RDJ_HUB_CODE_ROOT')
    explicit = os.environ.get('RDJ_SPORTS_CODE_ROOT')
    if not hub and not explicit:
        raise ValueError('rdj_sports_canonical_collector_unconfigured')
    root = Path(explicit) if explicit else Path(hub).parent / 'journal-parieur-worker'
    expected = root / 'journal_worker/rdj_sports.py'
    if (not root.is_absolute() or root.is_symlink() or root.resolve() != root.absolute()
            or not expected.is_file() or expected.is_symlink() or expected.resolve() != expected.absolute()):
        raise ValueError('rdj_sports_canonical_collector_missing')
    sys.path.insert(0, str(root))
    try:
        module = importlib.import_module('journal_worker.rdj_sports')
    finally:
        sys.path.remove(str(root))
    if Path(module.__file__).resolve() != expected.resolve():
        raise ValueError('rdj_sports_canonical_collector_origin_invalid')
    return module


def publisher_url(value, identity):
    url = urlsplit(value)
    if (url.scheme != 'https' or url.hostname != 'www.ruedesjoueurs.com' or url.port or url.username
            or url.password or url.query or url.fragment
            or not re.fullmatch(r'/pronostic/[\w-]+-' + re.escape(identity) + r'\.html', url.path)):
        raise ValueError('rdj_sports_fixture_url_invalid')
    return value


class CanonicalReader:
    """Convert the consumer's page type without hiding its shared HTTP hub.

    The canonical collector deliberately accepts only its own FetchedPage.
    Keeping html as a bound method with the original hub also prevents the
    collector from entering the same shared URL lock a second time.
    """
    def __init__(self, reader, canonical):
        self.reader = reader
        self.canonical = canonical
        self.hub = getattr(reader, 'hub', None)

    def html(self, url):
        from .vendor.rdj_collector import FetchedPage as ConsumerPage
        page = self.reader.html(url)
        if isinstance(page, str):
            return self.canonical.FetchedPage(url, page)
        if isinstance(page, self.canonical.FetchedPage):
            return page
        if isinstance(page, ConsumerPage):
            return self.canonical.FetchedPage(page.url, page.html, page.status)
        raise ValueError('rdj_sports_consumer_page_invalid')


def valid_proof(proof, item, edition):
    from .sources import iso
    try:
        local = iso(item['startsAtUtc']).astimezone(paris_timezone())
        return (set(proof) == {'sourceUrl', 'sourceId', 'indexUrl', 'method', 'provider', 'editionDate',
                'matchedParticipants', 'startsAtUtc', 'status'}
            and item['source'] == 'rdj_nba' and item['kind'] == 'match'
            and item['sport']['key'] == 'basketball' and item['competition']['name'] == 'NBA'
            and local.date() == date.fromisoformat(edition) + timedelta(days=1) and local.hour < 12
            and proof['method'] == 'rdj_sport_detail_clock_v1' and proof['provider'] == 'rdj'
            and proof['sourceUrl'] == publisher_url(item['sourceUrl'], item['sourceId'])
            and proof['sourceId'] == item['sourceId'] and proof['indexUrl'] == INDEXES['nba']
            and proof['editionDate'] == edition and proof['startsAtUtc'] == item['startsAtUtc']
            and proof['matchedParticipants'] == [item['teams'][side]['name'] for side in ('home', 'away')]
            and proof['status'] == 'upcoming')
    except (ValueError, KeyError, TypeError, AttributeError):
        return False


def collect(edition, fetcher, *, sport, now, resolver=None, lead=30):
    from .sources import iso, utc_text, paragraphs, checked, eligible
    checked(sport in INDEXES and lead >= 30, 'rdj_sports_parameters_invalid')
    module = owner()
    reader = CanonicalReader(fetcher, module.rdj)
    packet = module.collect(edition, sport, now=now, fetcher=reader.html, schedule_resolver=resolver)
    checked(packet.get('edition') == edition and packet.get('source_key') == 'rdj_' + sport
            and packet.get('journal_kind') == sport and packet.get('source_url') == INDEXES[sport], 'rdj_sports_packet_identity_invalid')
    checked(packet.get('status') in {'ready', 'source_absent', 'source_incomplete', 'outside_publication_window'}, 'rdj_sports_packet_status_invalid')
    if packet['status'] != 'ready':
        return {'status': packet['status'], 'items': [], 'issues': packet.get('issues', [])}
    items = []
    for fixture in packet.get('fixtures', []):
        identity = fixture.get('id')
        checked(isinstance(identity, str) and bool(re.fullmatch(r'\d+', identity)), 'rdj_sports_fixture_identity_invalid')
        source_url = publisher_url(fixture['source_url'], identity)
        wanted = 'basketball' if sport == 'nba' else 'tennis'
        checked(fixture.get('sport') == wanted and (sport != 'nba' or fixture.get('competition') == 'NBA'), 'rdj_sports_sport_conflict')
        analysis = fixture.get('provenance', {}).get('analysis_paragraphs_fr') or fixture.get('analysis_paragraphs')
        price = fixture.get('odds')
        checked(not isinstance(price, bool) and bool(re.fullmatch(r'\d+(?:\.\d+)?', str(price))), 'rdj_sports_odds_invalid')
        price = float(price)
        checked(fixture['home'] != fixture['away'] and analysis and fixture.get('pick_fr')
                and 1 < price <= 100000, 'rdj_sports_source_facts_missing')
        kickoff = iso(fixture['kickoff_utc'])
        membership = fixture.get('provenance', {}).get('sport_edition_membership', {})
        checked(membership.get('method') == 'rdj_sport_detail_clock_v1' and membership.get('edition') == edition
                and membership.get('sport') == wanted and membership.get('source_url') == source_url
                and membership.get('source_id') == identity and membership.get('index_url') == INDEXES[sport]
                and membership.get('matched_participants') == [fixture['home'], fixture['away']]
                and iso(membership['starts_at_utc']) == kickoff, 'rdj_sports_membership_unverified')
        item = {'source': 'rdj_' + sport, 'sourceId': identity, 'sourceUrl': source_url, 'editionDate': edition,
            'kind': 'match', 'title': {'fr': fixture['home'] + ' — ' + fixture['away']},
            'summary': {'fr': fixture.get('headline_fr') or fixture['home'] + ' — ' + fixture['away']},
            'startsAtUtc': utc_text(kickoff), 'sport': {'key': wanted, 'name': 'Basketball' if sport == 'nba' else 'Tennis'},
            'competition': {'name': fixture['competition']},
            'teams': {side: {'name': fixture[side]} for side in ('home', 'away')},
            'analysis': paragraphs(analysis),
            'selection': {'label': {'fr': fixture['pick_fr']}, 'odds': price}, 'status': 'upcoming'}
        local = kickoff.astimezone(paris_timezone())
        if local.date() != date.fromisoformat(edition):
            proof = {'sourceUrl': source_url, 'sourceId': identity, 'indexUrl': INDEXES[sport],
                'method': membership['method'], 'provider': 'rdj', 'editionDate': edition,
                'matchedParticipants': [fixture['home'], fixture['away']], 'startsAtUtc': item['startsAtUtc'], 'status': 'upcoming'}
            checked(membership.get('following_night') is True and valid_proof(proof, item, edition), 'rdj_sports_following_night_invalid')
            item.update(editionConvention='rdj_sport_following_night', scheduleProof=proof)
        checked(eligible(item, edition, now, lead), 'rdj_sports_publication_window_closed')
        items.append(item)
    checked(items and len(items) <= 50 and len({row['sourceId'] for row in items}) == len(items), 'rdj_sports_duplicate_or_empty')
    return {'status': 'ready', 'items': items, 'issues': packet.get('issues', [])}
