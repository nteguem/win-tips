"""Exact participant identity for the daily VIP source adapter.

Typographic normalization and the explicit, sport-scoped catalogue below are
allowed. Inside a proven football fixture, exact club decorators may also be
omitted. Cross-page identities retain those decorators and all women's, youth
and reserve markers.
An author's conclusion may omit a women's marker only inside a fixture whose
participants have already been established by the source's event hero.

``resolve_participant`` takes a participant name, not a whole recommendation:
the recommendation parser owns phrases/articles such as ``victoire du``.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
import re
import unicodedata


def _key(value):
    if not isinstance(value, str):
        return ''
    folded = ''.join(char for char in unicodedata.normalize('NFKD', value.casefold())
                     if not unicodedata.combining(char))
    return ' '.join(re.sub(r'[^\w]+', ' ', folded, flags=re.UNICODE).replace('_', ' ').split())


# Stable current franchises, checked against https://www.nba.com/teams on
# 2026-11-25. Names and conventional nicknames are complete aliases, never a
# substring or a city-only match. French city names used by the source are
# explicit; historical franchises are not inferred from their successor.
_NBA_ALIASES = (
    ('Atlanta Hawks', 'Hawks'),
    ('Boston Celtics', 'Celtics'),
    ('Brooklyn Nets', 'Nets'),
    ('Charlotte Hornets', 'Hornets'),
    ('Chicago Bulls', 'Bulls'),
    ('Cleveland Cavaliers', 'Cavaliers', 'Cavs'),
    ('Dallas Mavericks', 'Mavericks', 'Mavs'),
    ('Denver Nuggets', 'Nuggets'),
    ('Detroit Pistons', 'Pistons'),
    ('Golden State Warriors', 'Warriors'),
    ('Houston Rockets', 'Rockets'),
    ('Indiana Pacers', 'Pacers'),
    ('LA Clippers', 'Los Angeles Clippers', 'Clippers'),
    ('LA Lakers', 'Los Angeles Lakers', 'Lakers'),
    ('Memphis Grizzlies', 'Grizzlies'),
    ('Miami Heat', 'Heat'),
    ('Milwaukee Bucks', 'Bucks'),
    ('Minnesota Timberwolves', 'Timberwolves', 'Wolves'),
    ('New Orleans Pelicans', 'Nouvelle-Orléans Pelicans',
     'La Nouvelle-Orléans Pelicans', 'Pelicans'),
    ('New York Knicks', 'Knicks'),
    ('Oklahoma City Thunder', 'Thunder'),
    ('Orlando Magic', 'Magic'),
    ('Philadelphia 76ers', 'Philadelphie 76ers', 'Philadelphia Sixers',
     'Philadelphie Sixers', '76ers', 'Sixers'),
    ('Phoenix Suns', 'Suns'),
    ('Portland Trail Blazers', 'Trail Blazers', 'Blazers'),
    ('Sacramento Kings', 'Kings'),
    ('San Antonio Spurs', 'Spurs'),
    ('Toronto Raptors', 'Raptors'),
    ('Utah Jazz', 'Jazz'),
    ('Washington Wizards', 'Wizards'),
)

# Deliberately bounded aliases. An unknown historical club name, a city alone,
# and a different sport never acquire an inferred identity.
_ALIASES = {
    'basketball': _NBA_ALIASES + (
        ('Besiktas', 'Beşiktaş JK', 'BesiktasJK'),
    ),
    'football': (
        ('Besiktas', 'Beşiktaş JK', 'BesiktasJK'),
        ('Real Madrid', 'Real Madrid CF'),
        ('Paris SG', 'Paris Saint-Germain', 'PSG'),
        ('Chelsea', 'Chelsea FC'),
        ('Botafogo', 'Botafogo RJ'),
        ('Barcelone', 'FC Barcelone'),
    ),
    'rugby': (('Grenoble Rugby', 'Grenoble'),),
}
_CATALOGUE = {
    sport: tuple(frozenset(_key(name) for name in names) for names in groups)
    for sport, groups in _ALIASES.items()
}
# These shorter editorial labels were observed on the proven women's fixtures.
# They do not create aliases for unmarked men's clubs or historical identities.
_WOMEN_CATALOGUE = {
    'football': tuple(frozenset(_key(name) for name in names) for names in (
        ('HB Koege', 'Koge'),
        ('Servette FC Chênois', 'Servette FC'),
    )),
}
_WOMEN_SUFFIX = re.compile(r'\s+(?:f|feminin(?:e)?s?|women(?: s)?|dames)$')
_FIXTURE_SEPARATOR = re.compile(r'[-\u2010-\u2015]|(?<!\w)(?:vs?\.?|contre)(?!\w)', re.I)
_CLUB_DECORATORS = frozenset({'fc', 'cf', 'fk', 'afc', 'sc', 'ac', 'vfb'})


def _sport(value):
    if isinstance(value, Mapping):
        value = value.get('key')
    normalized = _key(value)
    return 'basketball' if normalized in {'basket', 'basketball', 'nba'} else normalized


def _base_aliases(name, sport, *, women=False):
    normalized = _key(name)
    if not normalized:
        return set()
    groups = _CATALOGUE.get(sport, ()) + (_WOMEN_CATALOGUE.get(sport, ()) if women else ())
    for group in groups:
        if normalized in group:
            return set(group)
    return {normalized}


def _women_base(name, sport):
    normalized = _key(name)
    if sport != 'football' or not normalized:
        return None
    match = _WOMEN_SUFFIX.search(normalized)
    return normalized[:match.start()] if match else None


def participant_aliases(name, sport):
    """Return normalized exact aliases, preserving participant class.

    An F/feminine/women suffix remains mandatory here. This function is suitable
    for comparing a prediction's hero with the separate odds page's hero.
    """
    sport = _sport(sport)
    base = _women_base(name, sport)
    if base:
        aliases = _base_aliases(base, sport, women=True)
        # Canonicalize equivalent explicit women's markers without equating the
        # resulting identity to the unmarked men's club.
        return {alias + ' f' for alias in aliases}
    return _base_aliases(name, sport)


def _names(teams):
    if isinstance(teams, Mapping):
        values = [teams.get('home'), teams.get('away')]
    elif isinstance(teams, Sequence) and not isinstance(teams, (str, bytes)) and len(teams) == 2:
        values = list(teams)
    else:
        return None
    names = [value.get('name') if isinstance(value, Mapping) else value for value in values]
    return names if all(isinstance(name, str) and _key(name) for name in names) else None


def same_participants(observed_teams, expected_teams, sport):
    """Compare both teams in source order, with no omitted class qualifiers."""
    observed, expected = _names(observed_teams), _names(expected_teams)
    if not observed or not expected:
        return False
    observed_aliases = [participant_aliases(name, sport) for name in observed]
    expected_aliases = [participant_aliases(name, sport) for name in expected]
    if observed_aliases[0] & observed_aliases[1] or expected_aliases[0] & expected_aliases[1]:
        return False
    return all(left & right for left, right in zip(observed_aliases, expected_aliases))


def _context_aliases(name, sport):
    aliases = participant_aliases(name, sport)
    base = _women_base(name, _sport(sport))
    if base:
        aliases |= _base_aliases(base, _sport(sport), women=True)
    return aliases


def _fixture_name_variants(aliases, sport):
    """Omit only complete edge decorators within an established football pair.

    Class qualifiers and every substantive word remain present. These variants
    are deliberately not returned by participant_aliases: a separate odds page
    must still prove its complete ordered participants.
    """
    if _sport(sport) != 'football':
        return aliases
    variants = set(aliases)
    for alias in aliases:
        words = alias.split()
        while len(words) > 1 and words[0] in _CLUB_DECORATORS:
            words.pop(0)
        while len(words) > 1 and words[-1] in _CLUB_DECORATORS:
            words.pop()
        variants.add(' '.join(words))
    return variants


def resolve_participant(text, teams, sport):
    """Resolve a whole name inside an already proven fixture, or return None.

    An author's omitted F is tolerated only for the source hero's women's team;
    if the resulting name could identify either participant, neither is chosen.
    Explicit U21, reserve, or other class differences are never removed.
    """
    names = _names(teams)
    value = _key(text)
    if not names or not value:
        return None
    # Canonicalize explicit women's suffixes on the proposed name as well.
    candidates = _fixture_name_variants(participant_aliases(text, sport), sport)
    matches = [side for side, name in zip(('home', 'away'), names)
               if candidates & _fixture_name_variants(_context_aliases(name, sport), sport)]
    return matches[0] if len(matches) == 1 else None


def recommendation_fixture_matches(raw_fixture, teams, sport):
    """Verify the author's complete fixture label in source home/away order.

    Consider each explicit separator so hyphens inside names (Saint-Germain or
    Bosnie-Herzégovine) remain valid. Every complete side must resolve exactly;
    additional text, a different team, or reversed participants do not match.
    """
    if not isinstance(raw_fixture, str) or not _names(teams):
        return False
    matches = 0
    for separator in _FIXTURE_SEPARATOR.finditer(raw_fixture):
        home, away = raw_fixture[:separator.start()], raw_fixture[separator.end():]
        if (resolve_participant(home, teams, sport) == 'home'
                and resolve_participant(away, teams, sport) == 'away'):
            matches += 1
    return matches == 1
