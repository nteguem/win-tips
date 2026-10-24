"""Real public RDJ snapshots; all mutations and the listing wrapper are offline."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest

from editorial_worker import sources as s


FIXTURES = Path(__file__).parent / "fixtures"
PROVENANCE = json.loads((FIXTURES / "turf-linked-analysis-provenance.json").read_text("utf-8"))


def page(kind, transform=None, url=None):
    row = next(row for row in PROVENANCE if row["file"] == "turf-2026-10-24-" + kind + ".html")
    raw = (FIXTURES / row["file"]).read_text("utf-8")
    return s.rdj.FetchedPage(url or row["sourceUrl"], transform(raw) if transform else raw)


class Offline:
    def __init__(self, pages):
        self.pages = {p.url: p for p in pages}
        self.urls = []

    def html(self, url):
        self.urls.append(url)
        if url not in self.pages:
            raise AssertionError("Unexpected offline request: " + url)
        return self.pages[url]


def listing(course):
    # Synthetic routing wrapper only; real HTML has only documented CRLF -> LF normalization.
    return s.rdj.FetchedPage(s.SOURCES["rdj_turf_quinte"], '<a href="' + course.url + '">Quinté du jour</a>')


class TurfLinkedAnalysisTests(unittest.TestCase):
    def parse(self, article=None, course=None):
        return s.parse_turf(course or page("course"), "2026-10-24", analysis_page=article or page("analysis"))

    def reject_article(self, transform, reason):
        with self.assertRaisesRegex(ValueError, reason):
            self.parse(page("analysis", transform))

    def test_snapshots_have_exact_integrity_and_provenance(self):
        self.assertEqual(len(PROVENANCE), 2)
        for row in PROVENANCE:
            data = (FIXTURES / row["file"]).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), row["fixtureSha256"])
            self.assertEqual(len(data), row["bytes"])
            self.assertTrue(row["sourceUrl"].startswith(s.HOST + "/turf/"))

    def test_real_24_keeps_course_facts_and_exact_authored_focus(self):
        article = page("analysis")
        result = self.parse(article)
        self.assertEqual(result["sourceId"], "2026-10-24-R1C3")
        self.assertEqual(result["sourceUrl"], page("course").url)
        self.assertEqual(result["race"]["name"], "Prix de Beaune")
        self.assertEqual(result["race"]["racecourse"], "Compiègne")
        self.assertEqual(result["startsAtUtc"], "2026-10-24T13:15:00Z")
        self.assertEqual(result["race"]["distanceMeters"], 3600)
        self.assertEqual(result["race"]["runnersCount"], 15)
        self.assertEqual(result["selection"]["orderedNumbers"], [4, 6, 7, 12, 5, 9, 2, 1])
        self.assertIsNone(result["selection"]["odds"])
        expected = [n.plain() for n in s.rdj.find(s.page_root(article), lambda n: n.has_class("focus-item"))]
        self.assertEqual(result["analysis"]["fr"], [{"heading": "Analyse de la course", "paragraphs": expected}])
        self.assertEqual(len(expected), 3)
        self.assertIn("à condition que le terrain ne soit pas trop pénible", expected[0])
        self.assertNotIn("en", result["analysis"])

    def test_collection_fetches_only_exact_link_after_missing_inline_analysis(self):
        course, article = page("course"), page("analysis")
        fetch = Offline([listing(course), course, article])
        result = s.collect_turf("2026-10-24", fetch, now=s.iso("2026-10-24T08:00:00Z"))
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["items"], [self.parse()])
        self.assertEqual(fetch.urls, [s.SOURCES["rdj_turf_quinte"], course.url, article.url])

    def test_existing_inline_23_remains_unchanged_without_article_request(self):
        rows = json.loads((FIXTURES / "provenance.json").read_text("utf-8"))
        row = next(row for row in rows if row["file"] == "turf-2026-10-23.html")
        course = s.rdj.FetchedPage(row["sourceUrl"], (FIXTURES / row["file"]).read_text("utf-8"))
        expected = deepcopy(s.parse_turf(course, "2026-10-23"))
        fetch = Offline([listing(course), course])
        result = s.collect_turf("2026-10-23", fetch, now=s.iso("2026-10-23T08:00:00Z"))
        self.assertEqual(result["items"], [expected])
        self.assertEqual(len(fetch.urls), 2)
        self.assertEqual(s.parse_turf(course, "2026-10-23", analysis_page=page("analysis")), expected)

    def test_missing_link_or_article_never_fabricates_analysis(self):
        with self.assertRaisesRegex(ValueError, "analysis_missing"):
            s.parse_turf(page("course"), "2026-10-24")
        course = page("course", lambda raw: raw.replace("Analyse complète de la course", "Article connexe"))
        fetch = Offline([listing(course), course])
        with self.assertRaisesRegex(ValueError, "analysis_missing"):
            s.collect_turf("2026-10-24", fetch, now=s.iso("2026-10-24T08:00:00Z"))
        self.assertEqual(len(fetch.urls), 2)
        self.reject_article(lambda raw: raw.replace('class="focus-item"', 'class="unrelated"'), "analysis_missing")

    def test_wrong_article_day_year_or_weekday_is_refused(self):
        for old, new in (("Samedi 24 Octobre", "Vendredi 23 Octobre"),
                         ("Samedi 24 Octobre", "Samedi 24 Octobre 2025"),
                         ("Samedi 24 Octobre", "Vendredi 24 Octobre")):
            with self.subTest(new=new):
                self.reject_article(lambda raw: raw.replace(old, new), "race_analysis_wrong_date")

    def test_other_course_racecourse_or_meeting_is_refused(self):
        for old, new in (("Prix de Beaune", "Prix Vatelys"), ("Compiegne", "Vincennes"), ("R1C3", "R1C4")):
            with self.subTest(new=new):
                self.reject_article(lambda raw: raw.replace(old, new), "race_analysis_identity_conflict")

    def test_exact_canonical_backlink_not_just_date_and_race_number(self):
        self.reject_article(lambda raw: raw.replace("/prix-de-beaune.html", "/prix-vatelys.html"), "course_reference_conflict")
        self.reject_article(lambda raw: raw.replace("/24-10-2026/R1/C3/", "/24-10-2025/R1/C3/"), "course_reference_conflict")
        self.reject_article(lambda raw: raw.replace('class="news-fiche"', 'class="unrelated"'), "course reference")

    def test_article_redirect_and_ambiguous_links_are_refused(self):
        with self.assertRaisesRegex(ValueError, "redirect_conflict"):
            self.parse(page("analysis", url=page("analysis").url.replace("74776-", "74778-")))
        extra = '<a href="' + page("analysis").url.replace("74776-", "74778-") + '">Analyse complète de la course</a>'
        course = page("course", lambda raw: raw.replace("</body>", extra + "</body>"))
        with self.assertRaisesRegex(ValueError, "link_ambiguous"):
            self.parse(course=course)

    def test_unavailable_article_and_offsite_link_are_refused(self):
        article = page("analysis")
        with self.assertRaisesRegex(ValueError, "source_http_404"):
            self.parse(s.rdj.FetchedPage(article.url, "", status=404))
        course = page("course", lambda raw: raw.replace(page("analysis").url.removeprefix(s.HOST),
            "https://untrusted.example/analysis.html"))
        with self.assertRaises(ValueError):
            self.parse(course=course)

    def test_conflicting_conditions_clock_count_and_distance_are_refused(self):
        for old, new in (("R1C3 - 15h15", "R1C3 - 16h15"),
                         (">15</div>", ">16</div>"), ("3600m", "3800m")):
            with self.subTest(new=new):
                self.reject_article(lambda raw: raw.replace(old, new), "conditions_conflict")

    def test_wrong_horse_number_name_or_duplicate_focus_is_refused(self):
        for old, new in (("4 - LOUBA", "5 - LOUBA"), ("6 - LE COLOMBAR", "6 - LOUBA"),
                         ("6 - LE COLOMBAR", "4 - LOUBA")):
            with self.subTest(new=new):
                self.reject_article(lambda raw: raw.replace(old, new), "runner_conflict")

    def test_existing_event_guard_fails_before_article_lookup(self):
        course = page("course", lambda raw: raw.replace("EventScheduled", "EventCompleted"))
        fetch = Offline([listing(course), course])
        with self.assertRaisesRegex(ValueError, "race_not_scheduled"):
            s.collect_turf("2026-10-24", fetch, now=s.iso("2026-10-24T08:00:00Z"))
        self.assertEqual(len(fetch.urls), 2)

    def test_valid_article_does_not_bypass_publication_cutoff(self):
        course = page("course")
        fetch = Offline([listing(course), course, page("analysis")])
        result = s.collect_turf("2026-10-24", fetch, now=s.iso("2026-10-24T13:00:00Z"))
        self.assertEqual(result["status"], "outside_publication_window")
        self.assertEqual(result["items"], [])


if __name__ == "__main__":
    unittest.main()
