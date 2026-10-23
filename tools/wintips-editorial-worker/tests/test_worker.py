from argparse import Namespace
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from editorial_worker.http import PublicFetcher, FetchError, public_url
from editorial_worker import sources as s
from editorial_worker import runner
from editorial_worker.calendar import edition_day, source_event_day, paris_timezone

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def page(key, replacement=None):
    manifest = json.loads((FIXTURES / "provenance.json").read_text("utf-8"))
    row = next(row for row in manifest if row["file"] == key + ".html")
    raw = (FIXTURES / row["file"]).read_text("utf-8")
    if replacement:
        raw = replacement(raw)
    return s.rdj.FetchedPage(row["sourceUrl"], raw)


class Offline:
    def __init__(self, pages=()):
        self.pages = {p.url: p for p in pages}
        self.requests = 0
        self.records = []

    def html(self, url):
        self.requests += 1
        if url not in self.pages:
            raise AssertionError("Offline fixture not provided: " + url)
        return self.pages[url]

    def json(self, url):
        raise AssertionError("The suite must never access a live schedule: " + url)


def fixture_clock(fixture, edition):
    # A deliberately injected clock stub, not a claim that a real league API
    # has been consulted by the offline tests. Production uses OfficialKickoffs.
    return {"kickoff_utc": edition + "T16:45:00Z", "method": "official_schedule",
            "source_url": "https://match.uefa.com/v5/matches?fixture-clock-test=1", "source_id": "fixture-clock"}


def args(directory, **values):
    result = Namespace(edition="2026-10-23", source=["rdj_turf_quinte"], output=str(directory),
                       api_base=None, publish=False, minimum_lead_minutes=30, max_requests=40,
                       max_seconds=240, cache_ttl_seconds=600)
    for key, value in values.items():
        setattr(result, key, value)
    return result


class RealFixtureTests(unittest.TestCase):
    def test_fixtures_have_integrity_and_provenance(self):
        records = json.loads((FIXTURES / "provenance.json").read_text("utf-8"))
        self.assertGreaterEqual(len(records), 8)
        for row in records:
            blob = (FIXTURES / row["file"]).read_bytes()
            self.assertEqual(hashlib.sha256(blob).hexdigest(), row["fixtureSha256"])
            self.assertTrue(row["sourceUrl"].startswith(s.HOST + "/"))

    def test_real_turf_identity_and_explicit_event_utc(self):
        item = s.parse_turf(page("turf-2026-10-23"), "2026-10-23")
        self.assertEqual(item["sourceId"], "2026-10-23-R1C4")
        self.assertEqual(item["race"]["racecourse"], "Vincennes")
        self.assertEqual(item["race"]["runnersCount"], 18)
        self.assertEqual(len(item["race"]["runners"]), 18)
        self.assertEqual(item["startsAtUtc"], "2026-10-23T18:15:00Z")
        self.assertEqual(item["selection"]["orderedNumbers"], [15, 11, 10, 8, 7, 17, 12, 6])
        self.assertIsNone(item["selection"]["odds"])
        self.assertNotIn("teams", item)

    def test_genybet_list_never_replaces_rdj_selection(self):
        def change(raw):
            return raw.replace("</body>", '<div id="api-tip"><ol class="picks"><li>1</li><li>2</li></ol></div></body>')
        item = s.parse_turf(page("turf-2026-10-23", change), "2026-10-23")
        self.assertEqual(item["selection"]["orderedNumbers"][0], 15)

    def test_turf_refuses_publication_offset_as_event_clock(self):
        broken = page("turf-2026-10-23", lambda raw: raw.replace("2026-10-23T20:15:00+02:00", "2026-10-23T20:15:00"))
        with self.assertRaisesRegex(ValueError, "event_timezone"):
            s.parse_turf(broken, "2026-10-23")

    def test_turf_refuses_finished_event(self):
        broken = page("turf-2026-10-23", lambda raw: raw.replace("EventScheduled", "EventCompleted"))
        with self.assertRaisesRegex(ValueError, "race_not_scheduled"):
            s.parse_turf(broken, "2026-10-23")

    def test_turf_refuses_wrong_edition(self):
        with self.assertRaisesRegex(ValueError, "wrong_date"):
            s.parse_turf(page("turf-2026-10-23"), "2026-10-24")

    def test_turf_refuses_runner_count_conflict(self):
        broken = page("turf-2026-10-23", lambda raw: raw.replace("18 partants", "19 partants"))
        with self.assertRaisesRegex(ValueError, "runner_count"):
            s.parse_turf(broken, "2026-10-23")

    def test_real_football_preserves_names_analysis_and_logos(self):
        p = page("football-2026-10-22")
        detail = s.rdj._detail(p)
        item = s.match_item(detail, p, "rdj_football_analysis", "2026-10-22", resolver=fixture_clock)
        self.assertEqual(item["sourceId"], "6112320")
        self.assertEqual(item["teams"]["home"]["name"], "Lech Poznan")
        self.assertEqual(item["teams"]["away"]["name"], "Sunderland")
        self.assertTrue(item["teams"]["home"]["logo"].startswith("https://img.ruedesjoueurs.com/"))
        self.assertEqual(item["analysis"]["fr"][0]["paragraphs"], detail["analysis_paragraphs"])
        self.assertEqual(item["selection"]["label"]["fr"], "Victoire Sunderland")
        self.assertIsNone(item["selection"]["odds"])
        self.assertNotIn("countryCode", item["competition"])
        self.assertNotIn("en", item["analysis"])

    def test_football_does_not_invent_utc(self):
        p = page("football-2026-10-22")
        with self.assertRaisesRegex(ValueError, "resolver|schedule|proof|complete|clock|offset|timezone|unresolved"):
            s.match_item(s.rdj._detail(p), p, "rdj_football_analysis", "2026-10-22", resolver=lambda *a: None)

    def test_real_petit_journal_selects_source_cards_only(self):
        fetch = Offline([page(key) for key in ("petit-index", "petit-journal-2026-10-22", "football-2026-10-22", "football-dinamo-2026-10-22")])
        result = s.collect_petit("2026-10-22", fetch, now=s.iso("2026-10-22T08:00:00Z"), resolver=fixture_clock)
        self.assertEqual(result["status"], "ready", result.get("issues"))
        self.assertEqual(len(result["items"]), 2)
        self.assertTrue(all("le-petit-journal/74762-" in item["sourceUrl"] for item in result["items"]))
        self.assertTrue(all(item["selection"]["odds"] > 1 for item in result["items"]))

    def test_absent_petit_journal_never_uses_yesterday(self):
        fetch = Offline([page("petit-index")])
        result = s.collect_petit("2026-10-23", fetch, now=s.iso("2026-10-23T08:00:00Z"), resolver=fixture_clock)
        self.assertEqual(result["status"], "source_absent")
        self.assertEqual(result["items"], [])

    def test_football_excludes_known_free_match(self):
        p = page("football-2026-10-22")
        listing = s.rdj.FetchedPage(s.SOURCES["rdj_football_analysis"], '<a href="' + p.url + '">Lire l’analyse</a>')
        fetch = Offline([listing])
        result = s.collect_football("2026-10-22", fetch, now=s.iso("2026-10-22T08:00:00Z"), resolver=fixture_clock, exclude_ids={"6112320"})
        self.assertEqual(result["items"], [])
        self.assertEqual(fetch.requests, 1)

    def combi_context(self, raw_change=None):
        p = page("combine-2026-10-21", raw_change)
        a, b = page("football-lille-2026-10-21"), page("football-como-2026-10-21")
        # Synthetic catalogue wrapper points only to verified real source fixtures.
        listing = s.rdj.FetchedPage(s.SOURCES["rdj_football_analysis"], '<a href="' + a.url + '">Lire l’analyse</a><a href="' + b.url + '">Lire l’analyse</a>')
        return p, Offline([a, b, listing])

    def test_real_combine_preserves_explicit_total_and_independent_analyses(self):
        p, fetch = self.combi_context()
        item = s.parse_combine(p, "2026-10-21", fetch, fixture_clock)
        self.assertEqual(item["sourceId"], "74744")
        self.assertEqual(item["selection"]["totalOdds"], 2.17)
        self.assertEqual(len(item["legs"]), 2)
        self.assertEqual(item["legs"][0]["teams"]["home"]["name"], "Lille")
        self.assertEqual(item["legs"][1]["teams"]["home"]["name"], "Como")
        self.assertTrue(all(leg["selection"]["odds"] is None for leg in item["legs"]))
        self.assertNotEqual(item["legs"][0]["analysis"], item["legs"][1]["analysis"])

    def test_combine_refuses_wrong_edition(self):
        p, fetch = self.combi_context()
        with self.assertRaisesRegex(ValueError, "wrong_edition"):
            s.parse_combine(p, "2026-10-23", fetch, fixture_clock)

    def test_combine_refuses_market_identity_conflict(self):
        p, fetch = self.combi_context(lambda raw: raw.replace("Come - Man U", "Lyon - Man U"))
        with self.assertRaisesRegex(ValueError, "participants_conflict"):
            s.parse_combine(p, "2026-10-21", fetch, fixture_clock)

    def test_combine_refuses_display_time_conflict(self):
        p, fetch = self.combi_context(lambda raw: raw.replace("mercredi 18h45", "mercredi 19h45"))
        with self.assertRaisesRegex(ValueError, "time_conflict"):
            s.parse_combine(p, "2026-10-21", fetch, fixture_clock)

    def test_old_combine_not_reused_as_today(self):
        p = page("combine-2026-10-21")
        index = s.rdj.FetchedPage(s.SOURCES["rdj_football_combine"], '<article class="news-tile"><h3><a href="' + p.url + '">COMBI FOOT</a></h3></article>')
        extra = [s.rdj.FetchedPage(url, '<a href="' + p.url + '">COMBINE</a>') for url in s.COMBINE_INDEXES[1:]]
        fetch = Offline([index, *extra])
        result = s.collect_combine("2026-10-23", fetch, now=s.iso("2026-10-23T08:00:00Z"), resolver=fixture_clock)
        self.assertEqual(result["items"], [])
        self.assertEqual(fetch.requests, 3)


class RuntimeSafetyTests(unittest.TestCase):
    def setUp(self):
        self.item = s.parse_turf(page("turf-2026-10-23"), "2026-10-23")
        self.clock = s.iso("2026-10-23T08:00:00Z")

    def test_default_dry_run_never_constructs_api_client(self):
        with tempfile.TemporaryDirectory() as out, patch.object(runner, "collect", return_value={"status": "ready", "items": [self.item], "issues": []}), patch.object(runner, "ApiClient", side_effect=AssertionError("No API in default preview")):
            report = runner.run(args(out), fetcher=Offline(), now=self.clock)
            self.assertEqual(report["mode"], "dry_run")
            self.assertFalse(report["published"])
            self.assertFalse(report["notificationsSent"])

    def test_publish_requires_explicit_api_config(self):
        with tempfile.TemporaryDirectory() as out:
            with self.assertRaisesRegex(ValueError, "enabled_import"):
                runner.run(args(out, publish=True), fetcher=Offline(), now=self.clock)

    def test_disabled_import_never_collects_or_posts(self):
        class Api:
            def request(self, route, payload=None):
                if payload is not None:
                    raise AssertionError("No POST permitted")
                return {"date": "2026-10-23", "importEnabled": False, "sources": []}
        with tempfile.TemporaryDirectory() as out, patch.object(runner, "collect", side_effect=AssertionError("No collection when blocked")):
            with self.assertRaisesRegex(ValueError, "enabled_import"):
                runner.run(args(out, publish=True, api_base="http://localhost:4300"), fetcher=Offline(), now=self.clock, api_client=Api())

    def test_unassigned_sources_are_not_collected(self):
        class Api:
            def request(self, route, payload=None):
                return {"date": "2026-10-23", "importEnabled": False, "sources": [{"key": "rdj_turf_quinte", "categoryIds": []}]}
        with tempfile.TemporaryDirectory() as out, patch.object(runner, "collect", side_effect=AssertionError("BO source unassigned")):
            report = runner.run(args(out, api_base="http://localhost:4300"), fetcher=Offline(), now=self.clock, api_client=Api())
            self.assertEqual(report["sources"], [])

    def test_publication_rejects_historical_edition(self):
        with tempfile.TemporaryDirectory() as out:
            with self.assertRaisesRegex(ValueError, "current_source_edition"):
                runner.run(args(out, publish=True, edition="2026-10-22"), fetcher=Offline(), now=self.clock)

    def test_payload_requires_exact_source_url(self):
        bad = deepcopy(self.item)
        bad["sourceUrl"] = "https://www.ruedesjoueurs.com/pronostics/foot.html"
        with self.assertRaisesRegex(ValueError, "does_not_match_adapter"):
            runner.validate_item(bad, "rdj_turf_quinte", "2026-10-23", self.clock, 30)

    def test_fewer_than_thirty_minutes_blocks_payload(self):
        with self.assertRaisesRegex(ValueError, "outside_publication"):
            runner.validate_item(self.item, "rdj_turf_quinte", "2026-10-23", s.iso("2026-10-23T18:00:00Z"), 30)

    def test_single_run_lock_blocks_concurrent_run(self):
        with tempfile.TemporaryDirectory() as out:
            with runner.single_run(out):
                with self.assertRaises(OSError):
                    with runner.single_run(out):
                        self.fail("Concurrent run acquired the same lock")

    def test_network_urls_fail_closed(self):
        for url in ("http://www.ruedesjoueurs.com/", "https://evil.example/", "https://x:secret@www.ruedesjoueurs.com/", "https://www.ruedesjoueurs.com:81/"):
            with self.assertRaises(FetchError):
                public_url(url)

    def test_api_refuses_plain_http_remote(self):
        with self.assertRaisesRegex(ValueError, "https_or_loopback"):
            runner.ApiClient("http://api.example.test", "not-a-real-token")

    def test_request_budget_is_global_and_before_network(self):
        with tempfile.TemporaryDirectory() as out:
            fetcher = PublicFetcher(out, max_requests=0)
            with self.assertRaisesRegex(FetchError, "request_budget"):
                fetcher.get(s.SOURCES["rdj_turf_quinte"])

    def test_no_english_translation_is_claimed(self):
        self.assertNotIn("en", self.item["title"])
        self.assertNotIn("en", self.item["analysis"])


class ParisCalendarTests(unittest.TestCase):
    def test_summer_midnight_advances_source_day_before_utc_midnight(self):
        self.assertEqual(edition_day(s.iso("2026-10-22T21:59:59Z")).isoformat(), "2026-10-22")
        self.assertEqual(edition_day(s.iso("2026-10-22T22:00:00Z")).isoformat(), "2026-10-23")

    def test_winter_midnight_uses_one_hour_offset(self):
        self.assertEqual(edition_day(s.iso("2026-12-22T22:59:59Z")).isoformat(), "2026-12-22")
        self.assertEqual(edition_day(s.iso("2026-12-22T23:00:00Z")).isoformat(), "2026-12-23")

    def test_spring_dst_jump_is_database_driven(self):
        before = s.iso("2026-03-29T00:59:00Z").astimezone(paris_timezone())
        after = s.iso("2026-03-29T01:00:00Z").astimezone(paris_timezone())
        self.assertEqual((before.hour, before.minute, before.utcoffset().total_seconds()), (1, 59, 3600))
        self.assertEqual((after.hour, after.minute, after.utcoffset().total_seconds()), (3, 0, 7200))
        self.assertEqual(before.date(), after.date())

    def test_autumn_repeated_hour_is_one_edition(self):
        first = s.iso("2026-10-25T00:30:00Z").astimezone(paris_timezone())
        second = s.iso("2026-10-25T01:30:00Z").astimezone(paris_timezone())
        self.assertEqual((first.hour, first.fold, first.utcoffset().total_seconds()), (2, 0, 7200))
        self.assertEqual((second.hour, second.fold, second.utcoffset().total_seconds()), (2, 1, 3600))
        self.assertEqual(first.date(), second.date())

    def test_timezone_fallback_has_verified_provenance(self):
        folder = Path(s.__file__).resolve().parent / "assets/zoneinfo"
        provenance = json.loads((folder / "provenance.json").read_text("utf-8"))
        blob = (folder / provenance["file"]).read_bytes()
        self.assertEqual(hashlib.sha256(blob).hexdigest(), provenance["sha256"])
        self.assertTrue(blob.startswith(b"TZif"))

    def test_naive_clock_is_not_silently_treated_as_utc(self):
        with self.assertRaisesRegex(ValueError, "timezone_aware"):
            edition_day(datetime(2026, 10, 23, 0, 0))
        self.assertEqual(source_event_day(datetime(2026, 10, 23, 0, 0)).isoformat(), "2026-10-23")

    def test_turf_after_paris_midnight_keeps_source_day_and_utc_instant(self):
        modified = page("turf-2026-10-23", lambda raw: raw.replace("2026-10-23T20:15:00+02:00", "2026-10-23T00:15:00+02:00"))
        item = s.parse_turf(modified, "2026-10-23")
        self.assertEqual(item["startsAtUtc"], "2026-10-22T22:15:00Z")
        self.assertTrue(s.eligible(item, "2026-10-23", s.iso("2026-10-22T21:00:00Z")))
        self.assertFalse(s.eligible(item, "2026-10-22", s.iso("2026-10-22T21:00:00Z")))

    def test_default_edition_and_api_config_use_paris_at_midnight(self):
        class Api:
            def request(self, route, payload=None):
                self.route = route
                return {"date": "2026-10-23", "importEnabled": False, "sources": []}
        clock = s.iso("2026-10-22T22:15:00Z")
        with tempfile.TemporaryDirectory() as out:
            result = runner.run(args(out, edition=None, api_base="http://localhost:4300"), fetcher=Offline(), now=clock, api_client=Api())
            self.assertEqual(result["editionDate"], "2026-10-23")
            self.assertEqual(result["editionTimezone"], "Europe/Paris")

    def test_publish_date_guard_accepts_paris_today_not_utc_yesterday(self):
        class Api:
            def request(self, route, payload=None):
                return {"date": "2026-10-23", "importEnabled": False, "sources": []}
        clock = s.iso("2026-10-22T22:15:00Z")
        with tempfile.TemporaryDirectory() as out:
            with self.assertRaisesRegex(ValueError, "enabled_import"):
                runner.run(args(out, edition="2026-10-23", publish=True, api_base="http://localhost:4300"), fetcher=Offline(), now=clock, api_client=Api())


if __name__ == "__main__":
    unittest.main()
