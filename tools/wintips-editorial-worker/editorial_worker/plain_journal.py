"""The same editorial-text collector and translator as the BigWin journal.

This module does not create tickets, resolve event clocks or collect results.
Only the local, versioned shared source is imported; no remote code is loaded.
"""
from pathlib import Path
import importlib
import os
import sys


def shared(name):
    root = Path(os.environ.get('WINTIPS_JOURNAL_TEXT_CODE_ROOT', '/var/www/proxidream/api-bigwin/tools/journal-parieur-worker'))
    expected = root / 'journal_worker' / (name + '.py')
    if not root.is_absolute() or root.is_symlink() or not expected.is_file() or expected.is_symlink():
        raise ValueError('shared_journal_text_source_unavailable')
    sys.path.insert(0, str(root))
    try:
        module = importlib.import_module('journal_worker.' + name)
    finally:
        sys.path.remove(str(root))
    if Path(module.__file__).resolve() != expected.resolve():
        raise ValueError('shared_journal_text_source_mismatch')
    return module


def collect_text(edition, fetcher, now):
    collector = shared('editorial_source')
    from journal_worker.collector import FetchedPage
    def fetch(url):
        page = fetcher.html(url)
        return FetchedPage(page.url, page.html, page.status)
    packet = collector.collect_editorial(edition, fetcher=fetch, now=now)
    if packet['status'] != 'ready':
        return {'status': packet['status'], 'items': [], 'issues': packet.get('issues', [])}
    translator = shared('text_translation')
    cache = Path(os.environ.get('WINTIPS_EDITORIAL_TEXT_CACHE', '/var/lib/wintips-editorial-worker/plain-text-translations'))
    packet = translator.translate(packet, config={}, cache_dir=cache)
    items = []
    for row in packet['fixtures']:
        title = row['headline_fr']
        content = {}
        for lang in ('fr', 'en'):
            paragraphs = row.get('analysis_' + lang, row['analysis_fr']).split('\n\n')
            pick = row.get('pick_' + lang) or row.get('pick_fr')
            if pick:
                paragraphs.append(('Pronostic : ' if lang == 'fr' else 'Pick: ') + pick
                    + (' · ' + row['odds_text'] if row.get('odds_text') else ''))
            content[lang] = [{'heading': row.get('headline_' + lang) or title, 'paragraphs': paragraphs}]
        item = {'source': 'rdj_petit_journal', 'editionDate': edition,
            'sourceId': edition + '-' + str(row['id']), 'sourceUrl': packet['source_url'], 'kind': 'article',
            'title': {'fr': title, 'en': row.get('headline_en') or title},
            'summary': {'fr': row['analysis_fr'][:650], 'en': (row.get('analysis_en') or row['analysis_fr'])[:650]},
            'analysis': content, 'startsAtUtc': None, 'status': 'unknown',
            'sport': {'key': row.get('sport') or 'sport', 'name': row.get('sport') or 'Sport'},
            'selection': {'label': {'fr': row.get('pick_fr') or 'Analyse', 'en': row.get('pick_en') or 'Analysis'}, 'odds': None}}
        if row.get('home') and row.get('away'):
            item['teams'] = {'home': {'name': row['home']}, 'away': {'name': row['away']}}
        if row.get('competition'):
            item['competition'] = {'name': row['competition']}
        items.append(item)
    return {'status': 'ready', 'items': items, 'issues': []}
