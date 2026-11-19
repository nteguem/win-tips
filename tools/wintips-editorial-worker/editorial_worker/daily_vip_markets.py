"""Exact publisher markets. Never price a combined market by its components."""
from decimal import Decimal, InvalidOperation
import re

from .vendor import rdj_collector as html
from .daily_vip_identity import resolve_participant


class DailyVipMarketError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _key(value):
    return html.folded(html.text(value)).strip(' !.')


def _number(value):
    return format(Decimal(value.replace(',', '.')).normalize(), 'f')


def _pick(kind, fr, en, side, raw, **extra):
    return {'betType': kind, 'label': {'fr': fr, 'en': en},
            'side': side, 'raw': raw, **extra}


def _participant(value, teams, sport):
    return resolve_participant(re.sub(r'^(?:(?:le|la|les|du|des|de)\s+|d[’\']\s*)', '', value, flags=re.I), teams, sport)


def parse_recommendation(raw, teams, sport):
    """Recognise a whole author's choice, never a convenient partial choice."""
    raw = html.text(raw).rstrip(' !.')
    value = _key(raw)
    if re.search(r'\b(?:mi[- ]temps|quart[- ]temps|premier set|premier quart|1er set|set [12])\b', value):
        return None
    straight_sets = re.fullmatch(r'(?:victoire (?:de |du |des |d[’\'])?(.+?)|(.+?) gagne) en 2 sets?', raw, re.I)
    if straight_sets and sport == 'tennis':
        side = _participant(straight_sets[1] or straight_sets[2], teams, sport)
        if side:
            name = teams[side]['name']
            score = '2-0' if side == 'home' else '0-2'
            return _pick('correct_score', f'{name} gagne en 2 sets', f'{name} to win in straight sets', score, raw)
    # Resolve a whole winner before splitting conjunctions: a participant can
    # itself contain "et". Extra betting conditions never resolve as a name.
    winner = re.fullmatch(r'(?:victoire (?:de |du |des |d[’\'])?(.+)|(.+?) gagne)', raw, re.I)
    if winner:
        side = _participant(winner[1] or winner[2], teams, sport)
        if side:
            name = teams[side]['name']
            return _pick('match_winner', f'Victoire de {name}', f'{name} to win', '1' if side == 'home' else '2', raw)
    # The tennis phrasing 'wins in over N games' contains two conditions.
    special = re.fullmatch(r'victoire (?:de |du |des |d[’\'])?(.+?) en (plus|moins) de (\d+(?:[,.]\d+)?) jeux', raw, re.I)
    pieces = ([f'Victoire de {special[1]}', f'{special[2]} de {special[3]} jeux'] if special
              else re.split(r'\s*(?:&|\bet\b)\s*', raw, flags=re.I))
    if len(pieces) > 1:
        if len(pieces) != 2:
            return None
        parts = [parse_recommendation(part, teams, sport) for part in pieces]
        if parts[0] and not parts[1] and parts[0]['betType'] == 'match_winner' and _key(pieces[1]) in {'garde sa cage inviolee', 'garde une cage inviolee'}:
            side = parts[0]['side']
            name = teams['home' if side == '1' else 'away']['name']
            parts[1] = _pick('clean_sheet', f'{name} garde sa cage inviolée', f'{name} to keep a clean sheet', side, pieces[1])
        if not all(parts) or any(part['betType'] == 'combined_market' for part in parts):
            return None
        return _pick('combined_market', raw, ' and '.join(part['label']['en'] for part in parts), 'combined', raw, components=parts)
    found = re.fullmatch(r'(.+?) (?:marque|inscrit) (plus|moins) de (\d+(?:[,.]\d+)?) points', raw, re.I)
    if found and sport == 'basketball':
        player, direction, line = found[1], found[2].lower(), _number(found[3])
        return _pick('player_points', raw, f'{player}: {"over" if direction == "plus" else "under"} {line} points', ('+' if direction == 'plus' else '-') + line, raw, player=player, line=line)
    found = re.fullmatch(r'(plus|moins) de (\d+(?:[,.]\d+)?) (buts|points|jeux)(?: dans le match)?', value)
    if found:
        direction, amount, unit = found.groups()
        kinds = {'buts': ('football', 'over_under_goals', 'goals'), 'points': ('basketball', 'over_under_points', 'points'), 'jeux': ('tennis', 'over_under_games', 'games')}
        expected, kind, english = kinds[unit]
        if sport != expected:
            return None
        line = _number(amount)
        return _pick(kind, raw, f'{"Over" if direction == "plus" else "Under"} {line} {english}', ('+' if direction == 'plus' else '-') + line, raw, line=line)
    if sport == 'football' and value in {'les deux equipes marquent', 'les 2 equipes marquent', 'but pour les deux equipes', 'les deux equipes vont marquer'}:
        return _pick('btts', 'Les deux équipes marquent', 'Both teams to score: Yes', 'Oui', raw)
    found = re.fullmatch(r'(.+?) (?:ou (?:match )?nul|ne perd pas)', raw, re.I)
    if found and sport == 'football':
        side = _participant(found[1], teams, sport)
        if side:
            name = teams[side]['name']
            return _pick('double_chance', f'{name} ou match nul', f'{name} or draw', '1N' if side == 'home' else 'N2', raw)
    found = re.fullmatch(r'(.+?) (?:rembours[eé] si (?:match )?nul|draw no bet)', raw, re.I)
    if found and sport == 'football':
        side = _participant(found[1], teams, sport)
        if side:
            return _pick('draw_no_bet', raw, f'{teams[side]["name"]}: draw no bet', '1' if side == 'home' else '2', raw)
    found = re.fullmatch(r'(.+?) gagne (?:par au moins (\d+) buts?(?: d[’\']écart)?|de (\d+) points? ou plus)', raw, re.I)
    if found:
        side = _participant(found[1], teams, sport)
        amount, unit = (found[2], 'buts') if found[2] else (found[3], 'points')
        if side and ((unit == 'buts' and sport == 'football') or (unit == 'points' and sport == 'basketball')):
            line = str(-(Decimal(amount) - Decimal('.5')))
            return _pick('handicap', raw, f'{teams[side]["name"]} to win by at least {amount} {"goals" if unit == "buts" else "points"}', '1' if side == 'home' else '2', raw, line=line)
    found = re.fullmatch(r'(?:victoire (?:de |du |des |d[’\'])?(.+)|(.+?) gagne)', raw, re.I)
    if found:
        side = _participant(found[1] or found[2], teams, sport)
        if side:
            name = teams[side]['name']
            return _pick('match_winner', f'Victoire de {name}', f'{name} to win', '1' if side == 'home' else '2', raw)
    return None


def _children(node, tag=None):
    return [child for child in node.children if not isinstance(child, str) and (tag is None or child.tag == tag)]


def _ancestors(node):
    while node is not None:
        yield node
        node = node.parent


def extract_exact_market_prices(root, pick, teams, sport):
    """Price only verified full-match tables; unsupported markets fail closed.

    Tables/identifiers below are observed in SportyTrader's actual odds pages.
    Combined markets and player props have no verified table in these pages.
    """
    kind = pick['betType']
    if kind == 'correct_score':
        from .daily_vip_score import extract_tennis_score_prices
        return extract_tennis_score_prices(root, pick, sport)
    if kind in {'match_winner', 'btts', 'over_under_goals'}:
        return None
    clean_sheet_side = None
    if kind == 'combined_market':
        parts = pick.get('components', [])
        if (len(parts) == 2 and parts[0]['betType'] == 'match_winner'
                and parts[1]['betType'] == 'clean_sheet' and parts[0]['side'] == parts[1]['side']):
            clean_sheet_side = parts[0]['side']
    if kind == 'player_points' or kind == 'combined_market' and clean_sheet_side is None:
        raise DailyVipMarketError('daily_vip_exact_market_price_unavailable')
    if kind not in {'double_chance', 'draw_no_bet', 'handicap', 'over_under_points', 'over_under_games', 'combined_market'}:
        return None
    from .daily_vip import BOOKMAKERS
    candidates, visited = [], set()
    for anchor in html.find(root, lambda n: n.tag == 'a' and re.fullmatch(r'/book/[a-z0-9-]+/odds', n.attrs.get('href') or '')):
        table = anchor.parent
        if id(table) in visited:
            continue
        visited.add(id(table))
        ancestors = list(_ancestors(table))
        if any(n.attrs.get('id') == 'PERIOD' for n in ancestors):
            continue
        ids = {n.attrs.get('id') for n in ancestors}
        titles = [_key(n.plain()) for n in _children(table, 'span') if n.has_class('design-title')]
        if len(titles) > 1:
            continue
        title = titles[0] if titles else ''
        headings = [n for n in _children(table, 'div') if n.has_class('grid') and n.has_class('font-semibold')]
        if len(headings) != 1:
            continue
        labels = [html.text(n.plain()).replace(',', '.') for n in _children(headings[0], 'span')]
        if not labels or labels[0] != 'Bookmaker' or labels[-1] != 'Bonus':
            continue
        desired = pick['side']
        if clean_sheet_side is not None:
            if ('RESULT' not in ids or title != f'equipe {clean_sheet_side} gagne sans encaisser'
                    or labels != ['Bookmaker', 'Oui', 'Non', 'Bonus']):
                continue
            desired = 'Oui'
        elif kind == 'double_chance':
            if 'RESULT' not in ids or title != 'double chance - vainqueur' or labels != ['Bookmaker', '1N', 'N2', '12', 'Bonus']:
                continue
        elif kind == 'draw_no_bet':
            if 'RESULT' not in ids or title != 'vainqueur (rembourse si match nul)' or labels != ['Bookmaker', '1', '2', 'Bonus']:
                continue
        elif kind == 'handicap':
            if 'SPREAD' not in ids or not title.startswith('handicap ') or len(labels) != 4:
                continue
            matched = []
            for label in labels[1:-1]:
                match = re.fullmatch(r'([12]) \(([+-]?\d+(?:\.\d+)?)\)', label)
                if match and match[1] == pick['side'] and Decimal(match[2]) == Decimal(pick['line']):
                    matched.append(label)
            if len(matched) != 1:
                continue
            desired = matched[0]
        else:
            if 'UNDER_OVER' not in ids:
                continue
            if kind == 'over_under_games' and sport != 'tennis' or kind == 'over_under_points' and sport != 'basketball':
                continue
            # Tennis also has set totals in this section: use its explicit
            # Jeux block, never an equal numeric line in the Set block.
            area_titles = [_key(n.plain()) for ancestor in ancestors[:5] for n in _children(ancestor, 'span') if n.has_class('design-title')]
            if kind == 'over_under_games' and 'plus / moins jeux' not in area_titles:
                continue
            panels = [n for n in ancestors if n.attrs.get('data-panel-key') == 'UNDER_OVER_' + pick['line'].replace('.', '_')]
            if len(panels) != 1 or labels != ['Bookmaker', '-' + pick['line'], '+' + pick['line'], 'Bonus']:
                continue
        if labels.count(desired) != 1:
            continue
        quotes, conflicting_books = {}, set()
        for row in _children(table, 'a'):
            match = re.fullmatch(r'/book/([a-z0-9-]+)/odds', row.attrs.get('href') or '')
            if not match or match[1] not in BOOKMAKERS:
                continue
            cells = _children(row, 'div')
            if len(cells) != len(labels) - 1:
                continue
            raw = html.text(cells[labels.index(desired) - 1].plain())
            if not re.fullmatch(r'\d{1,2}(?:[.,]\d{1,3})?', raw):
                continue
            try:
                price = Decimal(raw.replace(',', '.'))
            except InvalidOperation:
                continue
            if not Decimal('1') < price <= Decimal('20'):
                continue
            book = BOOKMAKERS[match[1]]
            if book in conflicting_books:
                continue
            if book in quotes and quotes[book] != price:
                quotes.pop(book)
                conflicting_books.add(book)
            else:
                quotes[book] = price
        if quotes:
            candidates.append(quotes)
    if len(candidates) > 1:
        raise DailyVipMarketError('daily_vip_odds_market_ambiguous')
    if not candidates:
        raise DailyVipMarketError('daily_vip_exact_market_price_unavailable')
    return candidates[0]
