"""Real five-day regressions and explicit withdrawals, without network or DB."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch

from editorial_worker import sources as s


FIXTURES = Path(__file__).parent / "fixtures" / "turf-nonpartants-20261104"
API_ROOT = Path(__file__).resolve().parents[3]
PROVENANCE = json.loads((FIXTURES / "provenance.json").read_text("utf-8"))
URL = s.HOST + "/turf/pronostic-turf/course/04-11-2026/R1/C2/grand-national-du-trot.html"


def captured(name="course-2026-11-04.html"):
    proof = next(row for row in PROVENANCE if row["file"] == name)
    return s.rdj.FetchedPage(proof["sourceUrl"], (FIXTURES / name).read_text("utf-8"))


def document(rows):
    return s.rdj.Document('<section id="partants"><table><tbody>' + rows
                          + '</tbody></table></section>').root


def runner(number=1, name="Cheval Exact", *, status="", links=None, extras=""):
    if links is None:
        links = [name]
    prices = ''.join('<a class="cote-link" title="Parier sur ' + label
                     + ' chez Bookmaker">4.20</a>' for label in links)
    return ('<tr><td>' + str(number) + '</td><td><div class="uk-text-bold">' + name
            + '<img alt=""><button data-fiche-open="fiche-1">Fiche</button></div>'
            + ('<div class="uk-text-small">' + status + '</div>' if status else '')
            + extras + '</td><td>H6</td><td>' + prices + '</td></tr>')


class TurfNonpartantsTests(unittest.TestCase):
    def test_public_capture_bytes_are_bound_to_provenance(self):
        self.assertEqual(len(PROVENANCE), 6)
        for row in PROVENANCE:
            with self.subTest(file=row["file"]):
                self.assertTrue(row["sourceUrl"].startswith(s.HOST + '/turf/pronostic-turf/course/'))
                self.assertEqual(hashlib.sha256((FIXTURES / row["file"]).read_bytes()).hexdigest(), row["sha256"])

    def test_five_real_days_active_names_and_counts(self):
        counts = {"2026-10-31": 16, "2026-11-01": 18, "2026-11-02": 16,
                  "2026-11-03": 17, "2026-11-04": 12}
        for day, count in counts.items():
            with self.subTest(day=day):
                page = captured('course-' + day + '.html')
                root = s.page_root(page)
                rows = s._runners(root, page.url)
                self.assertEqual(len(rows), count)
                self.assertEqual(len({row['number'] for row in rows}), count)
                self.assertTrue(all(row['name'] and 'Fiche' not in row['name'] for row in rows))
                advertised = re.search(r'\b(\d+)\s+partants\b', s.event(root, page.url)['description'])
                self.assertEqual(int(advertised[1]), count)

    def test_complete_today_source_preserves_eight_authored_picks(self):
        item = s.parse_turf(captured(), '2026-11-04')
        self.assertEqual(item['race']['runnersCount'], 12)
        self.assertEqual([row['number'] for row in item['race']['runners']], list(range(1, 13)))
        self.assertEqual(item['race']['runners'][0]['name'], "Jerenal d'Hameline")
        self.assertEqual(item['race']['runners'][6]['name'], 'Karnac Wood')
        self.assertEqual(item['selection']['orderedNumbers'], [7, 12, 6, 8, 11, 1, 10, 9])
        self.assertEqual(item['startsAtUtc'], '2026-11-04T12:55:00Z')
        self.assertTrue(item['analysis']['fr'][0]['paragraphs'])

    def test_old_header_thirteen_does_not_override_twelve_active_sports_event(self):
        page = captured()
        self.assertIn('13 partants', page.html)
        self.assertIn('12 partants', s.event(s.page_root(page), page.url)['description'])
        self.assertEqual(s.parse_turf(page, '2026-11-04')['race']['runnersCount'], 12)

    def test_explicit_nonpartant_never_requires_a_betting_link(self):
        rows = s._runners(document(runner(1) + runner(2, 'Retire', status='Non partant', links=[])), URL)
        self.assertEqual([row['number'] for row in rows], [1])

    def test_hyphenated_explicit_nonpartant_status_is_supported(self):
        rows = s._runners(document(runner(1) + runner(2, 'Retire', status='Non-partant', links=[])), URL)
        self.assertEqual([row['number'] for row in rows], [1])

    def test_missing_betting_link_does_not_imply_withdrawal(self):
        rows = s._runners(document(runner(1, links=[])), URL)
        self.assertEqual(rows, [{'number': 1, 'name': 'Cheval Exact'}])

    def test_buttons_icons_and_modal_statistics_are_not_horse_names(self):
        modal = '<dialog class="fiche"><div class="uk-text-bold">Autre cheval</div><strong>12/31</strong></dialog>'
        rows = s._runners(document(runner(1, links=[], extras=modal)), URL)
        self.assertEqual(rows[0]['name'], 'Cheval Exact')

    def test_modal_nonpartant_does_not_exclude_active_horse(self):
        modal = '<dialog class="fiche"><div class="uk-text-small">Non partant</div></dialog>'
        self.assertEqual(len(s._runners(document(runner(1, extras=modal)), URL)), 1)

    def test_duplicate_number_cannot_be_hidden_as_nonpartant(self):
        with self.assertRaisesRegex(ValueError, 'runners_missing_or_duplicate'):
            s._runners(document(runner(1) + runner(1, status='Non partant')), URL)

    def test_multiple_bookmakers_may_confirm_same_exact_name(self):
        self.assertEqual(s._runners(document(runner(1, links=['Cheval Exact', 'Cheval Exact'])), URL)[0]['name'], 'Cheval Exact')

    def test_conflicting_bookmaker_name_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'runner_name_conflict'):
            s._runners(document(runner(1, links=['Autre cheval'])), URL)

    def test_multiple_distinct_principal_names_are_not_guessed(self):
        with self.assertRaisesRegex(ValueError, 'runner_name_ambiguous'):
            s._runners(document(runner(1, extras='<div class="uk-text-bold">Autre cheval</div>')), URL)

    def test_all_horses_withdrawn_cannot_make_a_ticket(self):
        with self.assertRaisesRegex(ValueError, 'runners_missing_or_duplicate'):
            s._runners(document(runner(1, status='Non partant', links=[])), URL)

    def test_authored_selection_of_withdrawn_horse_is_not_silently_replaced(self):
        page = captured()
        html, count = re.subn(r'(<ol class="picks">\s*<li[^>]*>)7(</li>)', r'\g<1>13\2', page.html, count=1)
        self.assertEqual(count, 1)
        with self.assertRaisesRegex(ValueError, 'selection_runner_missing'):
            s.parse_turf(s.rdj.FetchedPage(page.url, html), '2026-11-04')

    def test_named_withdrawal_without_status_still_exposes_count_conflict(self):
        page = captured()
        html, count = re.subn(r'(<div class="uk-text-small">)\s*Non partant\s*(</div>)', r'\1\2', page.html, count=1)
        self.assertEqual(count, 1)
        with self.assertRaisesRegex(ValueError, 'runner_count_conflict'):
            s.parse_turf(s.rdj.FetchedPage(page.url, html), '2026-11-04')

    def test_unpublished_early_source_cannot_invent_selection(self):
        with self.assertRaises((ValueError, s.rdj.SourceError)):
            s.parse_turf(captured('course-2026-11-04-unpublished.html'), '2026-11-04')

    def test_publication_lead_is_preserved(self):
        item = s.parse_turf(captured(), '2026-11-04')
        self.assertTrue(s.eligible(item, '2026-11-04', datetime(2026, 11, 4, 11, 20, tzinfo=timezone.utc), 30))
        self.assertFalse(s.eligible(item, '2026-11-04', datetime(2026, 11, 4, 12, 26, tzinfo=timezone.utc), 30))

    def test_collect_today_reaches_ready_with_one_authored_coupon(self):
        page = captured()
        index = s.rdj.FetchedPage(s.SOURCES['rdj_turf_quinte'], '<a href="' + page.url + '">Quinté</a>')
        fetcher = SimpleNamespace(html=Mock(side_effect=lambda url: index if url == index.url else page))
        result = s.collect_turf('2026-11-04', fetcher,
                               now=datetime(2026, 11, 4, 11, 20, tzinfo=timezone.utc))
        self.assertEqual(result['status'], 'ready')
        self.assertEqual(len(result['items']), 1)
        self.assertEqual(result['items'][0]['selection']['orderedNumbers'], [7, 12, 6, 8, 11, 1, 10, 9])
        self.assertEqual([call.args[0] for call in fetcher.html.call_args_list], [index.url, page.url])

    def test_opted_in_fetcher_uses_shared_canonical_collection(self):
        owner = Mock(return_value={'status': 'ready', 'items': ['shared'], 'issues': []})
        hub = object()
        fetcher = SimpleNamespace(hub=hub)
        moment = datetime(2026, 11, 4, 11, 20, tzinfo=timezone.utc)
        with patch.dict('sys.modules', {'rdj_hub.turf': SimpleNamespace(collect=owner)}):
            result = s.collect_turf('2026-11-04', fetcher, now=moment, lead=30, limit=1)
        self.assertEqual(result['items'], ['shared'])
        owner.assert_called_once_with(hub, '2026-11-04', fetcher, now=moment, lead=30, limit=1)

    @unittest.skipUnless(shutil.which('node'), 'Node is required for authoritative API schema validation')
    def test_today_complete_payload_passes_actual_pure_api_validator(self):
        item = s.parse_turf(captured(), '2026-11-04')
        payload = {'source': 'rdj_turf_quinte', 'editionDate': '2026-11-04', 'items': [item]}
        script = "const fs=require('fs');const {validate}=require('./tools/wintips-editorial-worker/validate-api-payload.cjs');console.log(JSON.stringify(validate(fs.readFileSync(0),new Date('2026-11-04T11:20:00Z'))));"
        done = subprocess.run(['node', '-e', script], input=json.dumps(payload).encode(),
                              cwd=API_ROOT, capture_output=True, timeout=20, check=True)
        result = json.loads(done.stdout)
        self.assertTrue(result['passed'], result)
        self.assertEqual(result['code'], 'validated')
        self.assertEqual(result['itemCount'], 1)


if __name__ == '__main__':
    unittest.main()
