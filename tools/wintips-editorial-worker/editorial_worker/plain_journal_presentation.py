"""Optional publisher presentation facts; never a publication/access gate."""
import re
from datetime import date
from urllib.parse import urlsplit


def publisher_image(value):
    if not isinstance(value, str) or not value or len(value) > 2000:
        return None
    try:
        uri = urlsplit(value)
        if (uri.scheme != 'https' or uri.hostname != 'img.ruedesjoueurs.com'
                or uri.username or uri.password or uri.port or uri.fragment
                or any(ord(char) < 33 for char in value)
                or any(word in uri.path.lower() for word in
                       ('bookmaker', '/promo/', 'pixel', 'banner'))):
            return None
    except ValueError:
        return None
    return value


def presentation(row):
    """Keep proven names/crests and the printed clock, without guessing UTC."""
    result = {}
    home, away = row.get('home'), row.get('away')
    if (isinstance(home, str) and home.strip() and isinstance(away, str)
            and away.strip() and home.strip() != away.strip()):
        images = row.get('participant_images')
        images = images if isinstance(images, dict) else {}
        result['teams'] = {}
        for side, name in (('home', home), ('away', away)):
            team = {'name': name.strip()}
            logo = publisher_image(images.get(side))
            if logo:
                team['logo'] = logo
            result['teams'][side] = team
    image = publisher_image(row.get('image_url'))
    # Match artwork is accepted only with an already proven participant pair.
    if image and 'teams' in result:
        result['artworkUrl'] = image
    clock = row.get('source_clock_label')
    if isinstance(clock, str) and len(clock) <= 160:
        match = re.search(r'(?<!\d)([01]?\d|2[0-3])(?:h|:)([0-5]\d)(?!\d)\s*$', clock, re.I)
        if match:
            result['sourceTimeLabel'] = f'{int(match[1]):02}:{match[2]}'
    return result


def enrich_packet(packet, journal_html, fetcher):
    """One optional index request; both crests AND calendar day must match.

    No index outage, stale date or missing image can prevent text publication.
    Never take names from an unrelated copied match link or from free prose.
    """
    if not isinstance(journal_html, str):
        return
    try:
        from journal_worker.collector import Document, FetchedPage, find
        from .plain_journal import shared
        collector = shared('editorial_source')
        day = date.fromisoformat(packet['edition'])
        cards = collector._cards(FetchedPage(packet['source_url'], journal_html, 200), day)
        rows = packet['fixtures']
        if len(cards) != len(rows):
            return
        wanted = []
        for card in cards:
            images = [publisher_image(node.attrs.get('data-src') or node.attrs.get('src'))
                      for node in find(card, lambda n: n.tag == 'img')]
            images = [value for value in images if value and urlsplit(value).path.startswith('/img/')]
            wanted.append(tuple(images) if len(images) == 2 else None)
        if not any(wanted):
            return
        index_url = 'https://www.ruedesjoueurs.com/pronostics/foot.html'
        page = fetcher.html(index_url)
        if page.status != 200 or page.url != index_url:
            return
        index = Document(page.html).root
        matches = {}
        for card in find(index, lambda n: n.has_class('card') and n.has_class('vevent')):
            dates = find(card, lambda n: n.has_class('dtstart'))
            if len(dates) != 1 or dates[0].attrs.get('title', '').split('T')[0] != day.isoformat():
                continue
            images = find(card, lambda n: n.tag == 'img' and n.has_class('logoTeam'))
            if len(images) != 2:
                continue
            teams = []
            for image in images:
                url = publisher_image(image.attrs.get('data-src') or image.attrs.get('src'))
                name = re.fullmatch(r'Logo\s+(.+)', image.attrs.get('alt', '').strip())
                if not url or not name:
                    break
                teams.append({'name': name[1].strip(), 'logo': url})
            if len(teams) == 2 and teams[0]['name'] != teams[1]['name']:
                key = tuple(team['logo'] for team in teams)
                if key in matches and matches[key] != teams:
                    matches[key] = None
                else:
                    matches[key] = teams
        for row, key in zip(rows, wanted):
            teams = matches.get(key) if key else None
            if not teams:
                continue
            if any(row.get(side) and row[side] != teams[index]['name']
                   for index, side in enumerate(('home', 'away'))):
                continue
            row.update(home=teams[0]['name'], away=teams[1]['name'],
                       participant_images={side: teams[index]['logo']
                                           for index, side in enumerate(('home', 'away'))})
            if row.get('sport') in ('', 'sport', None):
                row['sport'] = 'football'
            row['presentation_source_url'] = index_url
    except Exception:
        # Presentation is optional even for custom/retryable fetch failures.
        # Process control exceptions (KeyboardInterrupt/SystemExit) still escape.
        return
