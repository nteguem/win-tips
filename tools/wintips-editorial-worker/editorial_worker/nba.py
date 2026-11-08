"""Adapt the single Basket USA collector; never copy or infer source content."""
from datetime import date, timedelta
from hashlib import sha256
import importlib
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

from .calendar import paris_timezone

SOURCE = 'basketusa_nba'
INDEX_URL = 'https://www.basketusa.com/paris-sportifs/pronostics-nba/'


def publisher_url(value):
    try:
        url = urlsplit(value)
        valid = (url.scheme == 'https' and url.hostname == 'www.basketusa.com'
            and not url.port and not url.username and not url.password
            and not url.query and url.path == '/paris-sportifs/pronostics-nba/'
            and (not url.fragment or re.fullmatch(r'pari-[a-z0-9-]{1,150}', url.fragment)))
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise ValueError('basketusa_source_url_invalid')
    return value


def owner():
    explicit = os.environ.get('NBA_JOURNAL_CODE_ROOT')
    hub = os.environ.get('RDJ_HUB_CODE_ROOT')
    if not explicit and not hub:
        raise ValueError('basketusa_canonical_collector_unconfigured')
    root = Path(explicit) if explicit else Path(hub).parent / 'journal-parieur-worker'
    expected = root / 'journal_worker' / 'nba_source.py'
    if (not root.is_absolute() or root.is_symlink() or root.resolve() != root.absolute()
            or expected.is_symlink() or not expected.is_file() or expected.resolve() != expected.absolute()):
        raise ValueError('basketusa_canonical_collector_missing')
    sys.path.insert(0, str(root))
    try:
        loaded = importlib.import_module('journal_worker.nba_source')
    finally:
        sys.path.remove(str(root))
    if Path(loaded.__file__).resolve() != expected.resolve():
        raise ValueError('basketusa_canonical_collector_origin_invalid')
    return loaded


def stable_id(fixture):
    value = fixture.get('id')
    if not isinstance(value, str) or not value.startswith('basketusa:'):
        raise ValueError('basketusa_fixture_identity_missing')
    return 'basketusa_' + sha256(value.encode()).hexdigest()[:32]


def article_proof(item, published):
    return {'sourceUrl': item['sourceUrl'], 'sourceId': item['sourceId'],
        'method': 'basketusa_article_clock', 'provider': 'basketusa',
        'editionDate': item['editionDate'], 'articlePublishedAt': published,
        'matchedParticipants': [item['teams'][side]['name'] for side in ('home', 'away')],
        'startsAtUtc': item['startsAtUtc'], 'status': 'upcoming'}


def valid_proof(proof, item, edition):
    from .sources import iso
    try:
        return (isinstance(proof, dict) and set(proof) == {'sourceUrl', 'sourceId', 'method', 'provider',
                'editionDate', 'articlePublishedAt', 'matchedParticipants', 'startsAtUtc', 'status'}
            and item.get('source') == SOURCE and item.get('kind') == 'match'
            and item.get('sport', {}).get('key') == 'basketball'
            and item.get('competition', {}).get('name') == 'NBA'
            and proof['sourceUrl'] == publisher_url(item['sourceUrl'])
            and proof['sourceId'] == item['sourceId']
            and proof['method'] == 'basketusa_article_clock' and proof['provider'] == 'basketusa'
            and proof['editionDate'] == edition
            and iso(proof['articlePublishedAt']).astimezone(paris_timezone()).date().isoformat() == edition
            and iso(proof['articlePublishedAt']) < iso(item['startsAtUtc'])
            and proof['matchedParticipants'] == [item['teams'][side]['name'] for side in ('home', 'away')]
            and proof['startsAtUtc'] == item['startsAtUtc'] and proof['status'] == 'upcoming')
    except (ValueError, KeyError, TypeError, AttributeError):
        return False


def collect(edition, fetcher, *, now, lead=30, resolver=None, limit=16):
    from .sources import iso, utc_text
    packet = owner().collect(edition, now=now, fetcher=fetcher.html)
    if packet.get('edition') != edition or packet.get('source_key') != SOURCE or packet.get('journal_kind') != 'nba':
        raise ValueError('basketusa_canonical_packet_invalid')
    if packet.get('status') not in {'ready', 'source_absent', 'source_incomplete', 'outside_publication_window'}:
        raise ValueError('basketusa_canonical_status_invalid')
    if packet.get('status') != 'ready':
        return {'status': packet.get('status', 'source_incomplete'), 'items': [], 'issues': packet.get('issues', [])}
    fixtures = packet.get('fixtures')
    if not isinstance(fixtures, list) or not 1 <= len(fixtures) <= limit:
        raise ValueError('basketusa_canonical_fixture_count_invalid')
    published = utc_text(iso(packet['source_published_at']))
    if iso(published) > now + timedelta(minutes=5):
        raise ValueError('basketusa_publication_in_the_future')
    items = []
    for fixture in fixtures:
        if fixture.get('sport') != 'basketball' or fixture.get('competition') != 'NBA':
            raise ValueError('basketusa_nba_sport_required')
        start = iso(fixture['kickoff_utc'])
        local = start.astimezone(paris_timezone())
        day = date.fromisoformat(edition)
        if local.date() != day and not (local.date() == day + timedelta(days=1) and local.hour < 12):
            raise ValueError('basketusa_fixture_day_invalid')
        if start < now + timedelta(minutes=lead):
            return {'status': 'outside_publication_window', 'items': [], 'issues': []}
        analysis = fixture.get('analysis_fr')
        blocks = analysis if isinstance(analysis, list) else [analysis]
        if not blocks or any(not isinstance(text, str) or not text.strip() for text in blocks):
            raise ValueError('basketusa_analysis_missing')
        item = {'source': SOURCE, 'sourceId': stable_id(fixture), 'sourceUrl': publisher_url(fixture['source_url']),
            'editionDate': edition, 'kind': 'match',
            'sourcePublication': {'publishedAt': published,
                'protectedNames': list(fixture.get('protected_names') or [fixture['home'], fixture['away']])},
            'title': {'fr': fixture['home'] + ' — ' + fixture['away']},
            'summary': {'fr': fixture['teaser_fr']}, 'startsAtUtc': utc_text(start),
            'sport': {'key': 'basketball', 'name': 'Basketball'}, 'competition': {'name': 'NBA'},
            'teams': {side: {'name': fixture[side]} for side in ('home', 'away')},
            'analysis': {'fr': [{'heading': fixture['headline_fr'], 'paragraphs': blocks}]},
            'selection': {'label': {'fr': fixture['pick_fr']}, 'odds': float(fixture['odds'])}, 'status': 'upcoming'}
        for logo in fixture.get('cover_logos', []):
            side = logo.get('side')
            if side in ('home', 'away') and logo.get('team_name') == fixture[side]:
                target = urlsplit(logo.get('image_url', ''))
                if target.scheme == 'https' and target.hostname == 'www.basketusa.com' and not target.username and not target.password and not target.port:
                    item['teams'][side]['logo'] = logo['image_url']
        proof = article_proof(item, published)
        if not valid_proof(proof, item, edition):
            raise ValueError('basketusa_article_clock_invalid')
        if local.date() != day:
            item['editionConvention'] = 'basketusa_following_night'
            item['scheduleProof'] = proof
        items.append(item)
    if len({item['sourceId'] for item in items}) != len(items):
        raise ValueError('basketusa_duplicate_fixture')
    return {'status': 'ready', 'items': items, 'issues': []}
