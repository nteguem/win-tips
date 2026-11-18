"""WinTips transport for the exact native BigWin Quinté text collector.

The shared publisher collector owns discovery, dated-course binding and article
fallbacks. This adapter never re-parses race results, live runners or clocks.
"""
from pathlib import Path
import os

from .plain_journal import shared


def _prefix(text, limit):
    """The API counts JavaScript UTF-16 units, including emoji surrogates."""
    return text.encode('utf-16-le')[:limit * 2].decode('utf-16-le', errors='ignore')


def _paragraphs(text):
    """Split only for transport limits; retain the complete source analysis."""
    result = []
    for paragraph in text.split('\n\n'):
        remaining = paragraph.strip()
        while remaining:
            prefix = _prefix(remaining, 6000)
            if len(prefix) == len(remaining):
                result.append(remaining)
                break
            # Prefer a word boundary. Extremely long tokens still fit the
            # contract without cutting a Unicode code point in half.
            boundary = max((index for index, char in enumerate(prefix)
                            if char.isspace()), default=0)
            if boundary:
                prefix = prefix[:boundary]
            result.append(prefix)
            remaining = remaining[len(prefix):].lstrip()
    return result


def _sections(headline, paragraphs):
    if len(headline) > len(_prefix(headline, 180)):
        # Keep even an unusually long original headline in the reader while
        # the API's cosmetic heading/title fields remain within their bounds.
        paragraphs = _paragraphs(headline) + paragraphs
    if not paragraphs or len(paragraphs) > 16 * 20:
        raise ValueError('horse_analysis_transport_capacity_exceeded')
    return [{'heading': _prefix(headline, 180), 'paragraphs': paragraphs[index:index + 20]}
            for index in range(0, len(paragraphs), 20)]


def collect_turf_text(edition, fetcher, *, now, resolver=None, lead=30, limit=1):
    # resolver/lead are kept only for the worker's common adapter interface.
    # Editorial publication follows the edition day, as the native BigWin job.
    collector = shared('editorial_horse_source')
    from journal_worker.collector import FetchedPage

    def fetch(url):
        page = fetcher.html(url)
        return FetchedPage(page.url, page.html, page.status)

    packet = collector.collect_editorial_horse(edition, fetcher=fetch, now=now)
    if packet.get('status') != 'ready':
        return {'status': packet.get('status', 'source_empty'), 'items': [],
                'issues': packet.get('issues', [])}

    translator = shared('text_translation')
    cache = Path(os.environ.get('WINTIPS_EDITORIAL_TEXT_CACHE',
        '/var/lib/wintips-editorial-worker/plain-text-translations'))
    translated = translator.translate(packet, config={}, cache_dir=cache)
    # BigWin prepares its horse narrative using these same translated fixture
    # fields; absent English is replaced with the exact original French.
    fixture = translated['fixtures'][0]
    race = translated['horse_racing']['items'][0]
    content = {}
    titles = {}
    summaries = {}
    selection = ' - '.join(str(number) for number in race.get('selection', []))
    for lang in ('fr', 'en'):
        headline = fixture.get('headline_' + lang) or fixture['headline_fr']
        titles[lang] = _prefix(headline, 220)
        analysis = fixture.get('analysis_' + lang) or fixture['analysis_fr']
        paragraphs = _paragraphs(analysis)
        if selection:
            paragraphs.extend(_paragraphs(('Sélection : ' if lang == 'fr' else 'Selection: ') + selection))
        content[lang] = _sections(headline, paragraphs)
        summaries[lang] = _prefix(analysis, 650)
    item = {'source': 'rdj_turf_quinte', 'editionDate': edition,
        'sourceId': race['sourceItemId'], 'sourceUrl': race['sourceUrl'], 'kind': 'article',
        'title': titles, 'summary': summaries, 'analysis': content,
        'startsAtUtc': None, 'status': 'unknown',
        'sport': {'key': 'horse_racing', 'name': 'Courses hippiques'},
        'competition': {'name': _prefix(race['racecourse'], 180)},
        'selection': {'label': {'fr': 'Sélection Quinté+', 'en': 'Quinté+ selection'}, 'odds': None}}
    return {'status': 'ready', 'items': [item], 'issues': packet.get('issues', [])}
