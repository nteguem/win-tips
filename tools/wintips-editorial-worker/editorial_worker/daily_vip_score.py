"""Exact full-match tennis set scores from the publisher's observed SCORE DOM.

The primary row labels its score, while hidden bookmaker rows inherit that
score only from the same immediate group and its matching data-oddtype marker.
Sets totals, set-period scores and a winner price are never equivalent quotes.
"""
from decimal import Decimal, InvalidOperation
import re

from .vendor import rdj_collector as html


def extract_tennis_score_prices(root, pick, sport):
    from .daily_vip import BOOKMAKERS
    from .daily_vip_markets import DailyVipMarketError, _children, _ancestors, _key

    def fail(code='daily_vip_exact_market_price_unavailable'):
        raise DailyVipMarketError(code)

    if sport != 'tennis' or pick.get('side') not in {'2-0', '0-2'}:
        fail()
    sections = html.find(root, lambda n: n.attrs.get('id') == 'SCORE'
                         and not any(parent.attrs.get('id') == 'PERIOD' for parent in _ancestors(n)))
    if len(sections) > 1:
        fail('daily_vip_odds_market_ambiguous')
    if not sections:
        fail()
    section = sections[0]
    titles = html.find(section, lambda n: n.tag == 'span' and n.has_class('design-title')
                       and _key(n.plain()) == 'score exact')
    headings = html.find(section, lambda n: n.tag == 'div' and n.has_class('grid')
                        and n.has_class('font-semibold') and [_key(c.plain()) for c in _children(n, 'span')]
                        == ['resultat', 'bookmaker', 'cote', 'bonus'])
    if len(headings) > 1:
        fail('daily_vip_odds_market_ambiguous')
    if not titles or len(headings) != 1:
        fail()
    table = headings[0].parent.parent
    if 'list-toggle' not in table.attrs.get('data-controller', '').split():
        fail()
    table_titles = [_key(node.plain()) for node in _children(table.parent, 'span') if node.has_class('design-title')]
    if table_titles != ['score exact']:
        fail()
    desired = pick['side']
    desired_marker = '_' + desired.replace('-', '_')
    groups = []
    for group in _children(table, 'div'):
        if any(parent.attrs.get('id') == 'PERIOD' for parent in _ancestors(group)):
            continue
        primaries = []
        for row in _children(group, 'div'):
            markers = [node for node in _children(row, 'div') if node.attrs.get('data-oddtype')]
            anchors = [node for node in _children(row, 'a')
                       if re.fullmatch(r'/book/[a-z0-9-]+/odds', node.attrs.get('href', ''))]
            if markers and anchors:
                primaries.append((row, markers, anchors))
        if len(primaries) != 1:
            continue
        row, markers, anchors = primaries[0]
        if len(markers) != 1 or len(anchors) != 1:
            continue
        cells = _children(anchors[0], 'div')
        if (len(cells) == 3 and html.text(cells[0].plain()) == desired
                and markers[0].attrs.get('data-oddtype') == desired_marker):
            groups.append((group, anchors[0], cells[1]))
    if len(groups) > 1:
        fail('daily_vip_odds_market_ambiguous')
    if not groups:
        fail()
    group, main_anchor, main_price = groups[0]
    quotes = {}

    def quote(anchor, cell):
        match = re.fullmatch(r'/book/([a-z0-9-]+)/odds', anchor.attrs.get('href', ''))
        if not match or match[1] not in BOOKMAKERS:
            return
        raw = html.text(cell.plain())
        if not re.fullmatch(r'\d{1,2}(?:[.,]\d{1,3})?', raw):
            return
        try:
            price = Decimal(raw.replace(',', '.'))
        except InvalidOperation:
            return
        if not Decimal('1') < price <= Decimal('20'):
            return
        book = BOOKMAKERS[match[1]]
        if book in quotes and quotes[book] != price:
            fail('daily_vip_odds_market_ambiguous')
        quotes[book] = price

    quote(main_anchor, main_price)
    for hidden in _children(group, 'div'):
        markers = [token for token in hidden.attrs.get('class', '').split() if re.fullmatch(r'_\d_\d', token)]
        if markers != [desired_marker]:
            continue
        anchors = _children(hidden, 'a')
        if len(anchors) != 1:
            continue
        cells = _children(anchors[0], 'div')
        if len(cells) != 4 or html.text(cells[0].plain()):
            continue
        quote(anchors[0], cells[2])
    if not quotes:
        fail()
    return quotes
