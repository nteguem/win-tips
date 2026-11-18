"""Replay the exact native BigWin horse-source fixtures through WinTips."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
SHARED = os.environ.get('WINTIPS_JOURNAL_TEXT_CODE_ROOT')
REQUIRED = ('editorial_horse_source.py', 'text_translation.py', 'document.py',
            'tests/test_editorial_horse_source.py')
if not SHARED or not all((Path(SHARED) / 'journal_worker' / name).is_file()
                         for name in REQUIRED):
    raise unittest.SkipTest('Explicit versioned BigWin journal source is required')
sys.path.insert(0, SHARED)

from editorial_worker import plain_quinte
from journal_worker import editorial_horse_source as source, text_translation
from journal_worker.collector import FetchedPage, SourceError
from journal_worker.document import build_payload
from journal_worker.tests import test_editorial_horse_source as original


class OfflineFetcher:
    def __init__(self):
        self.pages = {source.INDEX: original.INDEX, original.COURSE: original.RACE,
                      original.ARTICLE: original.TEXT}
        self.urls = []

    def html(self, url):
        self.urls.append(url)
        return FetchedPage(url, self.pages.get(url, ''), 200 if url in self.pages else 404)

    def json(self, _):
        raise AssertionError('An editorial text journal must not query schedules or results')


class PlainQuinteTests(unittest.TestCase):
    def setUp(self):
        self.fetcher = OfflineFetcher()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def fallback(self, packet, **_):
        def unavailable(_):
            raise ValueError('Simulated translation outage; no network')
        return text_translation.translate(packet, config={}, cache_dir=Path(self.directory.name),
                                           request=unavailable)

    def collect(self, translate=None):
        modules = {'editorial_horse_source': source,
                   'text_translation': SimpleNamespace(translate=translate or self.fallback)}
        with patch.object(plain_quinte, 'shared', side_effect=modules.__getitem__):
            return plain_quinte.collect_turf_text(original.DAY, self.fetcher, now=original.NOW)

    def test_loader_is_the_exact_versioned_bigwin_collector_not_a_copied_parser(self):
        self.assertIs(plain_quinte.shared('editorial_horse_source'), source)
        self.assertEqual(Path(source.__file__).resolve(),
            (Path(SHARED) / 'journal_worker/editorial_horse_source.py').resolve())

    def test_completed_race_and_changed_conditions_have_exact_bigwin_native_content(self):
        expected = source.collect_editorial_horse(original.DAY, fetcher=self.fetcher.html, now=original.NOW)
        native = build_payload(expected, original.COVERS, kind='horse_racing')
        item = self.collect()['items'][0]
        self.assertEqual(item['sourceId'], expected['horse_racing']['items'][0]['sourceItemId'])
        self.assertEqual(item['sourceUrl'], expected['source_url'])
        self.assertEqual(item['kind'], 'article')
        self.assertEqual(item['sport']['key'], 'horse_racing')
        for lang in ('fr', 'en'):
            section = native['content'][lang]['sections'][0]
            self.assertEqual(item['analysis'][lang][0]['paragraphs'],
                section['paragraphs'] + section.get('bullets', []))
        self.assertNotIn('Une publicite', str(item))

    def test_time_runners_selection_and_conditions_are_all_optional(self):
        self.fetcher.pages[original.COURSE] = '<h1>R1C6 Prix Exemple</h1><a href="' + original.ARTICLE + '">Analyse</a>'
        result = self.collect()
        self.assertEqual(result['status'], 'ready')
        item = result['items'][0]
        self.assertEqual(item['sourceId'], original.DAY + '-R1C6')
        self.assertIsNone(item['startsAtUtc'])
        self.assertEqual(item['status'], 'unknown')
        self.assertNotIn('race', item)
        self.assertEqual(item['analysis']['fr'][0]['paragraphs'],
            ['4 - Alpha : analyse source.', '1 - Beta : autre analyse source.'])

    def test_companion_fallback_is_the_same_as_bigwin_without_condition_checks(self):
        self.fetcher.pages[original.ARTICLE] = '<section><a href="' + original.CLASSIC + \
            '">Pronostic Quinté du Dimanche 15 Novembre - R1C6</a></section>'
        self.fetcher.pages[original.CLASSIC] = original.TEXT
        result = self.collect()
        self.assertEqual(result['status'], 'ready')
        self.assertIn(original.CLASSIC, self.fetcher.urls)
        self.assertEqual(result['items'][0]['analysis']['fr'][0]['paragraphs'][0],
                         '4 - Alpha : analyse source.')

    def test_course_body_does_not_depend_on_any_optional_article_link(self):
        self.fetcher.pages[original.COURSE] = original.RACE.replace(
            '<p itemprop="articleBody"></p>', '<p itemprop="articleBody">Analyse disponible.</p>')
        del self.fetcher.pages[original.ARTICLE]
        item = self.collect()['items'][0]
        self.assertEqual(item['analysis']['fr'][0]['paragraphs'][0], 'Analyse disponible.')
        self.assertNotIn(original.ARTICLE, self.fetcher.urls)

    def test_stale_listing_is_never_relabelled_as_todays_edition(self):
        self.fetcher.pages[source.INDEX] = original.INDEX.replace('15-11-2026', '14-11-2026')
        result = self.collect()
        self.assertEqual(result, {'status': 'source_absent', 'items': [], 'issues': []})
        self.assertEqual(self.fetcher.urls, [source.INDEX])

    def test_article_backlink_must_identify_the_exact_dated_course(self):
        self.fetcher.pages[original.ARTICLE] = original.TEXT.replace(
            '15-11-2026/R1/C6', '14-11-2026/R1/C6')
        result = self.collect()
        self.assertEqual(result['status'], 'source_empty')
        self.assertEqual(result['items'], [])

    def test_redirect_to_another_edition_is_rejected_by_the_shared_collector(self):
        original_fetch = self.fetcher.html
        def redirected(url):
            if url == original.COURSE:
                return FetchedPage(original.COURSE.replace('15-11', '14-11'), original.RACE)
            return original_fetch(url)
        self.fetcher.html = redirected
        with self.assertRaises(SourceError):
            self.collect()

    def test_translation_outage_keeps_the_exact_french_analysis_readable(self):
        item = self.collect()['items'][0]
        self.assertEqual(item['title']['en'], item['title']['fr'])
        self.assertEqual(item['analysis']['en'][0]['paragraphs'][:-1],
                         item['analysis']['fr'][0]['paragraphs'][:-1])
        self.assertEqual(item['analysis']['en'][0]['paragraphs'][-1], 'Selection: 4 - 1')

    def test_available_english_is_used_without_modifying_french_or_race_identity(self):
        def translated(packet, **_):
            result = deepcopy(packet)
            result['fixtures'][0].update(headline_en='Race analysis',
                analysis_en='First source analysis.\n\nSecond source analysis.', pick_en='4 - 1')
            return result
        item = self.collect(translated)['items'][0]
        self.assertEqual(item['title']['en'], 'Race analysis')
        self.assertEqual(item['analysis']['en'][0]['paragraphs'],
            ['First source analysis.', 'Second source analysis.', 'Selection: 4 - 1'])
        self.assertEqual(item['analysis']['fr'][0]['paragraphs'][0], '4 - Alpha : analyse source.')
        self.assertEqual(item['sourceId'], original.DAY + '-R1C6')

    def test_only_preview_summary_is_shortened_the_reader_keeps_the_full_source_text(self):
        full = 'Une longue analyse source conservée intégralement. ' * 100
        self.fetcher.pages[original.COURSE] = original.RACE.replace(
            '<p itemprop="articleBody"></p>', '<p itemprop="articleBody">' + full + '</p>')
        item = self.collect()['items'][0]
        expected = ' '.join(full.split())
        self.assertEqual(item['analysis']['fr'][0]['paragraphs'][0], expected)
        self.assertEqual(len(item['summary']['fr']), 650)
        self.assertGreater(len(expected), len(item['summary']['fr']))

    def test_transport_preserves_long_paragraphs_and_unicode_without_exceeding_api_limits(self):
        full = ('Analyse complète ⚽ avec tous les détails. ' * 550).strip()
        def translated(packet, **_):
            result = deepcopy(packet)
            for lang in ('fr', 'en'):
                result['fixtures'][0]['analysis_' + lang] = full
            return result
        item = self.collect(translated)['items'][0]
        for lang in ('fr', 'en'):
            paragraphs = [part for section in item['analysis'][lang]
                          for part in section['paragraphs']]
            self.assertEqual(' '.join(paragraphs[:-1]), full)
            self.assertTrue(all(len(part.encode('utf-16-le')) // 2 <= 6000
                                for part in paragraphs))
            self.assertEqual(len(item['summary'][lang].encode('utf-16-le')) // 2, 650)

    def test_transport_preserves_more_than_twenty_paragraphs_in_multiple_sections(self):
        paragraphs = ['Paragraphe source numéro ' + str(index) for index in range(47)]
        def translated(packet, **_):
            result = deepcopy(packet)
            result['fixtures'][0]['analysis_fr'] = '\n\n'.join(paragraphs)
            return result
        sections = self.collect(translated)['items'][0]['analysis']['fr']
        self.assertEqual(len(sections), 3)
        self.assertTrue(all(1 <= len(section['paragraphs']) <= 20 for section in sections))
        self.assertEqual([part for section in sections for part in section['paragraphs']][:-1],
                         paragraphs)

    def test_long_cosmetic_fields_are_bounded_but_complete_headline_remains_in_reader(self):
        headline = '🏇' * 130
        def translated(packet, **_):
            result = deepcopy(packet)
            result['fixtures'][0]['headline_fr'] = headline
            result['horse_racing']['items'][0]['racecourse'] = 'Longchamp ' * 40
            return result
        item = self.collect(translated)['items'][0]
        self.assertEqual(len(item['title']['fr'].encode('utf-16-le')) // 2, 220)
        self.assertEqual(len(item['analysis']['fr'][0]['heading'].encode('utf-16-le')) // 2, 180)
        self.assertEqual(item['analysis']['fr'][0]['paragraphs'][0], headline)
        self.assertLessEqual(len(item['competition']['name']), 180)

    def test_unbroken_token_is_split_without_losing_any_codepoint(self):
        full = '🏇' * 7001
        chunks = plain_quinte._paragraphs(full)
        self.assertEqual(''.join(chunks), full)
        self.assertTrue(all(len(chunk.encode('utf-16-le')) // 2 <= 6000 for chunk in chunks))

    def test_excessive_document_fails_explicitly_instead_of_silently_dropping_analysis(self):
        with self.assertRaisesRegex(ValueError, 'transport_capacity_exceeded'):
            plain_quinte._sections('Titre', ['Analyse intégrale.'] * 321)


if __name__ == '__main__':
    unittest.main()
