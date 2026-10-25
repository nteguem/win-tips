"""Race identity keeps internal hyphens; field separators are independent.

The Saint-Cloud mutations below are explicitly synthetic versions of the real
24 October snapshots. The separate 25 October snapshots cover the native bug.
No HTTP, model or publishing API is used.
"""
import hashlib
import json
from pathlib import Path
import unittest

from editorial_worker import sources as s
from test_turf_linked_analysis import page, listing, Offline


FIXTURES = Path(__file__).parent / "fixtures"


def hyphenated_venue(raw):
    return (raw.replace("Compiègne", "Saint-Cloud")
            .replace("Compiegne", "Saint-Cloud")
            .replace(r"Compi\u00e8gne", "Saint-Cloud"))


class TurfHyphenatedIdentityTests(unittest.TestCase):
    def test_internal_venue_hyphen_survives_classic_title_and_conditions(self):
        course = page("course", hyphenated_venue)
        analysis = page("analysis", hyphenated_venue)
        item = s.parse_turf(course, "2026-10-24", analysis_page=analysis)
        self.assertEqual(item["race"]["racecourse"], "Saint-Cloud")
        self.assertEqual(item["startsAtUtc"], "2026-10-24T13:15:00Z")
        self.assertEqual(item["selection"]["orderedNumbers"], [4, 6, 7, 12, 5, 9, 2, 1])

    def test_internal_venue_hyphen_survives_the_single_bridge_hop(self):
        course = page("course-current", hyphenated_venue)
        bridge = page("bridge", hyphenated_venue)
        analysis = page("analysis", hyphenated_venue)
        fetcher = Offline([listing(course), course, bridge, analysis])
        result = s.collect_turf("2026-10-24", fetcher, now=s.iso("2026-10-24T08:00:00Z"))
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["items"][0]["race"]["racecourse"], "Saint-Cloud")
        self.assertEqual(fetcher.urls, [s.SOURCES["rdj_turf_quinte"], course.url, bridge.url, analysis.url])

    def test_different_or_removed_internal_hyphen_is_not_same_venue(self):
        course = page("course", hyphenated_venue)
        for wrong in ("Saint-Malo", "Saint Cloud", "Saint - Cloud", "SaintCloud"):
            with self.subTest(wrong=wrong), self.assertRaisesRegex(ValueError, "identity_conflict"):
                analysis = page("analysis", lambda raw: hyphenated_venue(raw).replace("Saint-Cloud", wrong))
                s.parse_turf(course, "2026-10-24", analysis_page=analysis)

    def test_bridge_wrong_venue_cannot_benefit_from_separator_normalization(self):
        course = page("course-current", hyphenated_venue)
        for wrong in ("Saint-Malo", "Saint Cloud"):
            with self.subTest(wrong=wrong), self.assertRaisesRegex(ValueError, "identity_conflict"):
                bridge = page("bridge", lambda raw: hyphenated_venue(raw).replace("Saint-Cloud", wrong))
                s._turf_classic_analysis_url(bridge, course, "2026-10-24")

    def test_conditions_still_require_exact_venue_and_race_time(self):
        course = page("course", hyphenated_venue)
        for wrong in ("Prix De Beaune - Saint-Malo - R1C3 - 15h15",
                      "Prix De Beaune - Saint-Cloud - R1C3 - 16h15"):
            with self.subTest(wrong=wrong), self.assertRaisesRegex(ValueError, "conditions_conflict"):
                analysis = page("analysis", lambda raw: hyphenated_venue(raw).replace(
                    "Prix De Beaune - Saint-Cloud - R1C3 - 15h15", wrong))
                s.parse_turf(course, "2026-10-24", analysis_page=analysis)

    def test_spaced_dash_variants_do_not_change_hyphenated_venue(self):
        course = page("course", hyphenated_venue)
        for separator in (" – ", " — ", "  -  "):
            with self.subTest(separator=separator):
                analysis = page("analysis", lambda raw: hyphenated_venue(raw).replace(" - ", separator))
                item = s.parse_turf(course, "2026-10-24", analysis_page=analysis)
                self.assertEqual(item["race"]["racecourse"], "Saint-Cloud")


class TurfReal25IdentityTests(unittest.TestCase):
    DAY = "2026-10-25"

    @classmethod
    def setUpClass(cls):
        cls.provenance = json.loads((FIXTURES / "turf-2026-10-25-provenance.json").read_text("utf-8"))

    def page25(self, kind, change=None):
        row = next(row for row in self.provenance if row["file"] == "turf-2026-10-25-" + kind + ".html")
        raw = (FIXTURES / row["file"]).read_text("utf-8")
        changed = change(raw) if change else raw
        if change:
            self.assertNotEqual(raw, changed, "A mutation must really alter the archived source")
        return s.rdj.FetchedPage(row["sourceUrl"], changed)

    def parse25(self, analysis=None, course=None):
        return s.parse_turf(course or self.page25("course"), self.DAY,
                            analysis_page=analysis or self.page25("analysis"))

    def test_real_25_snapshots_have_exact_lf_integrity_and_source_provenance(self):
        self.assertEqual(len(self.provenance), 2)
        for row in self.provenance:
            raw = (FIXTURES / row["file"]).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), row["fixtureSha256"])
            self.assertEqual(len(raw), row["bytes"])
            self.assertNotIn(b"\r", raw)
            self.assertEqual(row["httpStatus"], 200)
            self.assertTrue(row["sourceUrl"].startswith(s.HOST + "/turf/"))

    def test_real_25_native_identity_selection_and_three_authored_focuses(self):
        item = self.parse25()
        self.assertEqual(item["sourceId"], "2026-10-25-R1C5")
        self.assertEqual(item["race"]["name"], "Prix de l'Elevage")
        self.assertEqual(item["race"]["racecourse"], "Saint-Cloud")
        self.assertEqual(item["race"]["runnersCount"], 16)
        self.assertEqual(item["race"]["distanceMeters"], 2500)
        self.assertEqual(item["selection"]["orderedNumbers"], [15, 8, 13, 16, 2, 11, 3, 1])
        expected = [node.plain() for node in s.rdj.find(s.page_root(self.page25("analysis")),
                                                     lambda node: node.has_class("focus-item"))]
        self.assertEqual(len(expected), 3)
        self.assertEqual(item["analysis"]["fr"], [{"heading": "Analyse de la course", "paragraphs": expected}])

    def test_real_25_dst_clock_is_1415_utc_and_collection_needs_no_bridge(self):
        course, analysis = self.page25("course"), self.page25("analysis")
        fetcher = Offline([listing(course), course, analysis])
        result = s.collect_turf(self.DAY, fetcher, now=s.iso("2026-10-25T05:30:00Z"))
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["items"][0]["startsAtUtc"], "2026-10-25T14:15:00Z")
        self.assertEqual(fetcher.urls, [s.SOURCES["rdj_turf_quinte"], course.url, analysis.url])

    def test_real_25_different_venue_race_or_rc_remains_a_conflict(self):
        for old, new in (("Saint-cloud", "Saint-Malo"), ("Saint-cloud", "Saint cloud"),
                         ("Prix de l&#039;Elevage", "Prix de Beaune"), ("R1C5", "R1C4"), ("R1C5", "R5C1")):
            with self.subTest(new=new), self.assertRaisesRegex(ValueError, "race_analysis_identity_conflict"):
                self.parse25(self.page25("analysis", lambda raw: raw.replace(old, new)))

    def test_real_25_wrong_day_weekday_or_year_is_rejected(self):
        for old, new in (("Dimanche 25 Octobre", "Samedi 24 Octobre"),
                         ("Dimanche 25 Octobre", "Samedi 25 Octobre"),
                         ("Dimanche 25 Octobre", "Dimanche 25 Octobre 2025")):
            with self.subTest(new=new), self.assertRaisesRegex(ValueError, "race_analysis_wrong_date"):
                self.parse25(self.page25("analysis", lambda raw: raw.replace(old, new)))

    def test_real_25_exact_course_backlink_remains_required(self):
        article = self.page25("analysis", lambda raw: raw.replace("/prix-de-l-elevage.html", "/prix-de-beaune.html"))
        with self.assertRaisesRegex(ValueError, "race_analysis_course_reference_conflict"):
            self.parse25(article)

    def test_real_25_conditions_and_horse_identities_remain_required(self):
        for old, new, code in (("R1C5 - 15h15", "R1C5 - 16h15", "conditions_conflict"),
                               ("2500m", "2400m", "conditions_conflict"),
                               ("15 - JANAH", "14 - JANAH", "runner_conflict"),
                               ("8 - CRISTABEL", "8 - JANAH", "runner_conflict")):
            with self.subTest(new=new), self.assertRaisesRegex(ValueError, code):
                self.parse25(self.page25("analysis", lambda raw: raw.replace(old, new)))

    def test_real_25_success_does_not_extend_the_publication_window(self):
        course, analysis = self.page25("course"), self.page25("analysis")
        fetcher = Offline([listing(course), course, analysis])
        result = s.collect_turf(self.DAY, fetcher, now=s.iso("2026-10-25T14:00:00Z"))
        self.assertEqual(result["status"], "outside_publication_window")
        self.assertEqual(result["items"], [])


if __name__ == "__main__":
    unittest.main()
