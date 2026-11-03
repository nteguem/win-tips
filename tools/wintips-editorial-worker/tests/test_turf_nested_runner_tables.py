"""Offline runner ownership: horse histories are nested tables, not more entries."""
import json
from pathlib import Path
import re
import unittest

from editorial_worker import sources as s


URL = s.HOST + "/turf/pronostic-turf/course/03-11-2026/R1/C1/prix-de-vienne.html"
FIXTURES = Path(__file__).parent / "fixtures"


def history(number):
    # Public RDJ's new horse detail modals embed this kind of history table.
    # This is synthetic test data, including deliberate name/number collisions.
    return ('<div class="fiche"><table class="fiche__runs"><thead><tr><th>Date</th>'
            '<th>Hippodrome</th><th>Place</th></tr></thead><tbody><tr><td>02/11/26</td>'
            '<td><b>Ancien cheval</b><img alt="Casaque historique" '
            'src="https://media.genybet.fr/old.png"></td><td>3e</td></tr>'
            '<tr><td>' + str(number) + '</td><td><strong>Ancien concurrent</strong></td>'
            '<td><a class="cote-link" title="Parier sur Ancien concurrent chez Test">99</a>'
            '</td></tr></tbody></table></div>')


def runner(number, *, nested=True, bold=True):
    label = "Cheval " + str(number)
    name = "<strong>" + label + "</strong>" if bold else label
    return ('<tr><td>' + str(number) + '</td><td>' + name
            + '<img alt="Casaque de ' + label + '" src="https://media.genybet.fr/' + str(number) + '.png">'
            + (history(number) if nested else '') + '</td><td>H6</td><td>'
            '<a class="cote-link" title="Parier sur ' + label + ' chez Test">6,40</a></td></tr>')


def table(rows, *, nested=True, bold=True):
    return ('<table class="uk-table"><thead><tr><th>N</th><th>Cheval</th><th>S/A</th>'
            '<th>Cote (parier)</th></tr></thead><tbody>'
            + ''.join(runner(n, nested=nested, bold=bold) for n in rows) + '</tbody></table>')


def root(body):
    return s.rdj.Document('<section id="partants">' + body + '</section>').root


class TurfNestedRunnerTablesTests(unittest.TestCase):
    def test_seventeen_nested_histories_are_not_eighteen_runner_tables(self):
        document = root(table(range(1, 18)))
        self.assertEqual(len(s.rdj.find(document, lambda n: n.tag == "table")), 18)
        rows = s._runners(document, URL)
        self.assertEqual([r["number"] for r in rows], list(range(1, 18)))
        self.assertEqual([r["name"] for r in rows], ["Cheval " + str(n) for n in range(1, 18)])
        self.assertTrue(all(r["odds"] == 6.4 for r in rows))
        self.assertEqual(rows[0]["silksUrl"], "https://media.genybet.fr/1.png")

    def test_nested_names_and_numbers_never_replace_primary_runner_fields(self):
        document = root(table([1, 2], bold=False))
        rows = s._runners(document, URL)
        self.assertEqual([(r["number"], r["name"], r["odds"]) for r in rows],
                         [(1, "Cheval 1", 6.4), (2, "Cheval 2", 6.4)])

    def test_two_real_principal_tables_remain_ambiguous(self):
        with self.assertRaises(s.rdj.SourceError) as error:
            s._runners(root(table([1, 2]) + table([3, 4])), URL)
        self.assertEqual(error.exception.code, "structure_ambiguous")
        self.assertEqual(str(error.exception), "race runners table: expected one element, found 2")

    def test_duplicate_main_numbers_are_still_rejected(self):
        with self.assertRaisesRegex(ValueError, "runners_missing_or_duplicate"):
            s._runners(root(table([1, 1])), URL)

    def test_invalid_main_number_is_not_repaired_from_nested_history(self):
        broken = table([1, 2]).replace('<tr><td>1</td>', '<tr><td>?</td>', 1)
        with self.assertRaisesRegex(ValueError, "runner_number_ambiguous"):
            s._runners(root(broken), URL)

    def test_flat_original_format_is_unchanged(self):
        rows = s._runners(root(table([1, 2], nested=False)), URL)
        self.assertEqual(rows, [
            {"number": 1, "name": "Cheval 1", "odds": 6.4, "silksUrl": "https://media.genybet.fr/1.png"},
            {"number": 2, "name": "Cheval 2", "odds": 6.4, "silksUrl": "https://media.genybet.fr/2.png"}])

    def test_layout_table_outside_runner_scope_does_not_hide_its_principal(self):
        document = s.rdj.Document('<table class="layout"><tr><td><section id="partants">'
                                  + table([1, 2]) + '</section></td></tr></table>').root
        self.assertEqual([r["number"] for r in s._runners(document, URL)], [1, 2])

    def test_no_main_runner_cannot_be_fabricated_from_history_rows(self):
        document = root('<table class="uk-table"><tr><td colspan="4">' + history(1) + '</td></tr></table>')
        with self.assertRaisesRegex(ValueError, "runner_number_ambiguous"):
            s._runners(document, URL)

    def test_real_archived_race_keeps_full_facts_when_histories_are_added(self):
        provenance = json.loads((FIXTURES / "provenance.json").read_text("utf-8"))
        row = next(row for row in provenance if row["file"] == "turf-2026-10-23.html")
        html = (FIXTURES / row["file"]).read_text("utf-8")
        baseline = s.parse_turf(s.rdj.FetchedPage(row["sourceUrl"], html), "2026-10-23")
        # Only the horse-name cell receives a synthetic modal; all race facts,
        # original selections, prices and source analysis remain unchanged.
        nested, count = re.subn(r'(<td class="uk-text-left">)',
                               lambda match: match[0] + history(1), html)
        self.assertGreaterEqual(count, 18)
        actual = s.parse_turf(s.rdj.FetchedPage(row["sourceUrl"], nested), "2026-10-23")
        self.assertEqual(actual, baseline)


if __name__ == "__main__":
    unittest.main()
