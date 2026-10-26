"""Explicit RDJ adapters; missing or ambiguous data never creates a ticket."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
import hashlib
import math
import re
from urllib.parse import urljoin, urlsplit

from .vendor import rdj_collector as rdj
from .vendor.timing import OfficialKickoffs, _provider_name
from .calendar import edition_day, source_event_day, paris_timezone
from .verified import VerifiedKickoffs
from .markets import market as describe_market, GOAL_TYPES, MarketError

HOST = "https://www.ruedesjoueurs.com"
SOURCES = {
    "rdj_petit_journal": HOST + "/paris-sportifs/le-petit-journal.html",
    "rdj_turf_quinte": HOST + "/turf/pronostic-turf.html",
    "rdj_football_analysis": HOST + "/pronostics/foot.html",
    "rdj_football_combine": HOST + "/actualites/paris-sportifs.html",
    "rdj_football_duo": HOST + "/paris-sportifs/sport-news/news-pmu-sport.html",
    "rdj_football_goals": HOST + "/actualites/paris-sportifs.html",
    "rdj_multisport_analysis": HOST + "/pronostics/basket.html",
}
COMBINE_INDEXES = tuple(dict.fromkeys((SOURCES["rdj_football_combine"], SOURCES["rdj_football_duo"], HOST + "/paris-sportifs.html")))
MULTISPORT_INDEXES = (HOST + "/pronostics/basket.html", HOST + "/pronostics/volleyball.html")
MATCH_PATH = re.compile(r"/pronostic/(?!statistiques/)[^/?#]+-(\d+)\.html$")
RACE_PATH = re.compile(r"/turf/pronostic-turf/course/(\d{2}-\d{2}-\d{4})/R(\d+)/C(\d+)/[^/?#]+\.html$")
COMBI_PATH = re.compile(r"/(?:actualites/paris-sportifs|paris-sportifs/sport-news/news-[a-z-]+)/(?P<id>\d+)-[^/?#]+\.html$")


class ParseError(ValueError):
    pass


def checked(condition, reason):
    if not condition:
        raise ParseError(reason)


def iso(value):
    checked(isinstance(value, str) and "T" in value, "explicit_event_datetime_required")
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    checked(moment.tzinfo is not None, "event_timezone_required")
    return moment.astimezone(timezone.utc)


def utc_text(moment):
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def source_url(value, base=HOST):
    return rdj.rdj_url(value, base)


def page_root(page):
    checked(page.status == 200, "source_http_" + str(page.status))
    return rdj.Document(page.html).root


def jsonld(root):
    def walk(value):
        if isinstance(value, list):
            for entry in value:
                yield from walk(entry)
        elif isinstance(value, dict):
            yield value
            for key in ("@graph",):
                if key in value:
                    yield from walk(value[key])
    for node in rdj.find(root, lambda n: n.tag == "script" and n.attrs.get("type") == "application/ld+json"):
        try:
            raw = "".join(c for c in node.children if isinstance(c, str))
            yield from walk(json.loads(raw))
        except (ValueError, TypeError):
            continue


def event(root, url):
    rows = []
    for row in jsonld(root):
        kinds = row.get("@type", [])
        if isinstance(kinds, str):
            kinds = [kinds]
        if "SportsEvent" in kinds and row.get("startDate"):
            if row.get("url") and source_url(row["url"], url) != url:
                continue
            rows.append(row)
    checked(len(rows) == 1, "one_explicit_sports_event_required")
    iso(rows[0]["startDate"])
    return rows[0]


def image_url(value, base):
    target = urljoin(base, value or "")
    p = urlsplit(target)
    if p.scheme == "https" and p.hostname in {"img.ruedesjoueurs.com", "www.ruedesjoueurs.com", "media.genybet.fr"} and not p.username and not p.password:
        return target
    return None


def _team_logos(root, url):
    match = rdj.one(rdj.find(root, lambda n: n.has_class("fichematch")), "fichematch")
    teams = rdj.find(match, lambda n: n.has_class("equipe"))
    result = []
    for team in teams:
        logos = []
        for n in rdj.find(team, lambda n: n.tag == "img"):
            value = image_url(n.attrs.get("data-src") or n.attrs.get("src"), url)
            if value and re.search(r"/img/\d+-", urlsplit(value).path):
                logos.append(value)
        result.append(next(iter(set(logos))) if len(set(logos)) == 1 else None)
    checked(len(result) == 2, "two_participants_required")
    return result


def paragraphs(values, heading="L’état de forme"):
    texts = [rdj.text(value) for value in values if isinstance(value, str) and rdj.text(value)]
    checked(bool(texts), "analysis_missing")
    return {"fr": [{"heading": heading, "paragraphs": texts}]}


def match_item(detail, page, source, edition, *, resolver, pick=None, odds=None, kickoff=None):
    root = page_root(page)
    if kickoff is None:
        # The publication's UTC offset is never an event-time proof.
        if detail["kickoff"].tzinfo is not None:
            kickoff = detail["kickoff"].astimezone(timezone.utc)
        else:
            fixture = {"home": detail["home"], "away": detail["away"], "sport": detail["sport"],
                       "competition": detail["competition"], "gender": detail.get("gender"), "source_url": page.url, "journal_source_url": page.url}
            moment, _ = rdj._utc(fixture, detail["kickoff"], detail["kickoff"], date.fromisoformat(edition), resolver)
            kickoff = iso(moment)
    logo_home, logo_away = _team_logos(root, page.url)
    teams = {"home": {"name": detail["home"]}, "away": {"name": detail["away"]}}
    for side, logo in (("home", logo_home), ("away", logo_away)):
        if logo:
            teams[side]["logo"] = logo
    expert = detail.get("expert_headline", {})
    if pick is None:
        outcome = expert.get("outcome_1n2")
        checked(outcome in {"1", "N", "2"}, "explicit_expert_outcome_missing")
        pick = {"1": "Victoire " + detail["home"], "N": "Match nul", "2": "Victoire " + detail["away"]}[outcome]
        pairs = {str(row["odds"]) for row in detail.get("detail_priced_markets", [])
                 if rdj.folded(row["pick_fr"]) == rdj.folded(pick)}
        if len(pairs) == 1:
            odds = float(pairs.pop())
    result = {"source": source, "sourceId": MATCH_PATH.fullmatch(urlsplit(page.url).path).group(1),
            "sourceUrl": page.url, "editionDate": edition, "kind": "match",
            "title": {"fr": detail["home"] + " — " + detail["away"]},
            "summary": {"fr": expert.get("text") or detail["home"] + " — " + detail["away"]},
            "startsAtUtc": utc_text(kickoff), "sport": {"key": detail["sport"], "name": detail["sport"].capitalize()},
            "competition": {"name": detail["competition"]}, "teams": teams,
            "analysis": paragraphs(detail["analysis_paragraphs"]),
            "selection": {"label": {"fr": pick}, "odds": odds}, "status": "upcoming"}
    local = kickoff.astimezone(paris_timezone())
    day = date.fromisoformat(edition)
    if detail["sport"] == "basketball" and rdj.folded(detail["competition"]) in {"nba", "national basketball association"} and local.date() == day + timedelta(days=1):
        checked(local.hour < 12, "nba_following_night_window_closed")
        fixture = {"home": detail["home"], "away": detail["away"], "sport": "basketball", "competition": "NBA", "source_url": page.url, "journal_source_url": page.url}
        checked(resolver is not None, "nba_following_night_schedule_required")
        proof = resolver(fixture, edition)
        # Even a source offset alone cannot grant the following-night exception.
        # Run the existing allowlisted clock guard over the provider's proof.
        canonical = kickoff.astimezone(timezone.utc).replace(tzinfo=None)
        resolved, _ = rdj._utc(fixture, canonical, canonical, day, lambda *args: proof)
        checked(iso(resolved) == kickoff, "nba_following_night_schedule_conflict")
        checked(proof["method"] in {"official_schedule", "provider_schedule"}, "nba_following_night_schedule_required")
        result["competition"]["name"] = "NBA"
        result["editionConvention"] = "nba_following_night"
        result["scheduleProof"] = {"sourceUrl": proof["source_url"], "sourceId": str(proof["source_id"]),
            "method": proof["method"], "provider": "espn" if proof["method"] == "provider_schedule" else "nba",
            "matchedParticipants": [detail["home"], detail["away"]], "startsAtUtc": result["startsAtUtc"], "status": "upcoming"}
    try:
        result["selection"]["betType"] = describe_market(pick, [detail["home"], detail["away"]], detail["sport"])[0]
    except MarketError:
        # Preserve every authored journal label. Unknown market wording uses
        # Gemini prose translation, or original-source fallback if unavailable.
        pass
    return result


def eligible(item, edition, now, lead=30):
    instant = iso(item["startsAtUtc"])
    local = instant.astimezone(paris_timezone())
    day = date.fromisoformat(edition)
    membership = local.date() == day
    if (local.date() == day + timedelta(days=1) and local.hour < 12 and item.get("sport", {}).get("key") == "basketball"
            and item.get("competition", {}).get("name") == "NBA" and item.get("editionConvention") == "nba_following_night"):
        proof = item.get("scheduleProof", {})
        if not isinstance(proof, dict):
            return False
        membership = (proof.get("startsAtUtc") == item["startsAtUtc"] and proof.get("status") == "upcoming"
                      and proof.get("matchedParticipants") == [item.get("teams", {}).get(side, {}).get("name") for side in ("home", "away")]
                      and _night_schedule_valid(proof))
    return membership and instant >= now + timedelta(minutes=lead)


def _night_schedule_valid(proof):
    if not isinstance(proof.get("sourceId"), str) or not re.fullmatch(r"\d+", proof["sourceId"]) or not int(proof["sourceId"]):
        return False
    url = proof.get("sourceUrl")
    if proof.get("method") == "official_schedule" and proof.get("provider") == "nba":
        return url in {"https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json", "https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json"}
    if proof.get("method") != "provider_schedule" or proof.get("provider") != "espn" or not isinstance(url, str):
        return False
    match = re.fullmatch(r"https://site\.api\.espn\.com/apis/site/v2/sports/basketball/nba/scoreboard\?dates=(\d{8})", url)
    if not match:
        return False
    try:
        requested = datetime.strptime(match[1], "%Y%m%d").date()
        instant = iso(proof.get("startsAtUtc"))
    except (ValueError, TypeError):
        return False
    return abs((requested - instant.date()).days) <= 1


def collect_petit(edition, fetcher, *, now, resolver, lead=30, limit=8):
    packet = rdj.collect_edition(edition, fetcher=fetcher.html, kickoff_resolver=resolver, now=now, max_index_pages=2)
    if packet["status"] != "ready":
        return {"status": packet["status"], "items": [], "issues": packet.get("issues", [])}
    items, normalizations = [], []
    for fixture in packet["fixtures"]:
        p = fetcher.html(fixture["source_url"])
        detail = rdj._detail(p)
        item = match_item(detail, p, "rdj_petit_journal", edition, resolver=resolver,
                          pick=fixture["pick_fr"], odds=fixture["odds"], kickoff=iso(fixture["kickoff_utc"]))
        item["sourceUrl"] = fixture["journal_source_url"]
        if not eligible(item, edition, now, lead):
            return {"status": "outside_publication_window", "items": [], "issues": []}
        items.append(item)
        if detail.get('source_canonicalization_audit') is not None:
            normalizations.append(detail['source_canonicalization_audit'])
    checked(len(items) <= limit, "petit_card_limit")
    return {"status": "ready", "items": items, "issues": [], 'sourceCanonicalizationAudits': normalizations}


def _fixture_links(root):
    out = []
    for n in rdj.find(root, lambda n: n.tag == "a" and n.attrs.get("href")):
        try:
            href = source_url(n.attrs["href"])
        except ValueError:
            continue
        if MATCH_PATH.fullmatch(urlsplit(href).path) and href not in out:
            out.append(href)
    return out


def _ambiguous_numeric_typos(paragraphs):
    # An integer glued directly to a CLOSED score before a new French clause
    # is not a provable sporting fact. Never guess a replacement or strip it.
    # Explicit separated counts/ordinals and HTML footnote nodes are preserved.
    pattern = re.compile(r'\(\d{1,3}\s*[-–−]\s*\d{1,3}\)\d{1,3}(?=\s+Ce\b)')
    return [{'paragraphIndex': index, 'offset': match.start(), 'excerpt': match[0]}
        for index, paragraph in enumerate(paragraphs) for match in pattern.finditer(paragraph)]


def collect_football(edition, fetcher, *, now, resolver, lead=30, limit=6, exclude_ids=None):
    root = page_root(fetcher.html(SOURCES["rdj_football_analysis"]))
    # Prefer editorial analysis links. The live/results sidebar is outside this scope.
    editorial = rdj.find(root, lambda n: n.tag == "a" and "lire l'analyse" in rdj.folded(n.plain()))
    links = []
    for n in editorial:
        href = source_url(n.attrs.get("href") or "")
        if MATCH_PATH.fullmatch(urlsplit(href).path) and href not in links:
            links.append(href)
    issues, items, normalizations = [], [], []
    for url in links[:20]:
        match_id = MATCH_PATH.fullmatch(urlsplit(url).path).group(1)
        if match_id in (exclude_ids or set()):
            continue
        try:
            p = fetcher.html(url)
            checked(MATCH_PATH.fullmatch(urlsplit(p.url).path) is not None and MATCH_PATH.fullmatch(urlsplit(p.url).path).group(1) == match_id, "prediction_redirected_to_other_id")
            detail = rdj._detail(p)
            if detail["sport"] != "football" or source_event_day(detail["kickoff"]).isoformat() != edition:
                continue
            numeric_typos = _ambiguous_numeric_typos(detail['analysis_paragraphs'])
            if numeric_typos:
                issues.append({'url': url, 'code': 'ambiguous_numeric_typo', 'locations': numeric_typos})
                continue
            item = match_item(detail, p, "rdj_football_analysis", edition, resolver=resolver)
            if eligible(item, edition, now, lead):
                items.append(item)
                if detail.get('source_canonicalization_audit') is not None:
                    normalizations.append(detail['source_canonicalization_audit'])
            if len(items) >= limit:
                break
        except (ValueError, OSError) as exc:
            issues.append({"url": url, "code": getattr(exc, "code", str(exc)[:100])})
    return {"status": "ready" if items else "source_absent", "items": items, "issues": issues,
        'sourceCanonicalizationAudits': normalizations}


def _multisport_pick(detail, page):
    """Only the authored conclusion owns the selection, not odds tables/ads."""
    root = page_root(page)
    headings = rdj.find(root, lambda n: n.tag == "h2" and re.match(r"pronostics?\s+(?:1n2|1-2)\s+du match\b", rdj.folded(n.plain())))
    labels = []
    for heading in headings:
        siblings = heading.parent.children
        start = next(i for i, n in enumerate(siblings) if n is heading)
        for node in siblings[start + 1:]:
            if isinstance(node, rdj.Node) and node.tag == "h2":
                break
            if not isinstance(node, rdj.Node):
                continue
            for bold in rdj.find(node, lambda n: n.tag in {"b", "strong"}):
                label = bold.plain().rstrip(".")
                try:
                    describe_market(label, [detail["home"], detail["away"]], detail["sport"])
                except MarketError:
                    continue
                labels.append(label)
    if len(set(labels)) == 1:
        label = labels[0]
    else:
        checked(not labels, "multisport_expert_selection_ambiguous")
        outcome = detail.get("expert_headline", {}).get("outcome_1n2")
        checked(outcome in {"1", "2"}, "multisport_explicit_selection_missing")
        label = "Victoire " + detail["home" if outcome == "1" else "away"]
        describe_market(label, [detail["home"], detail["away"]], detail["sport"])
    prices = {row["odds"] for row in detail.get("detail_priced_markets", []) if rdj.folded(row["pick_fr"]) == rdj.folded(label)}
    return label, float(prices.pop()) if len(prices) == 1 else None


def collect_multisport(edition, fetcher, *, now, resolver, lead=30, limit=6, exclude_ids=None):
    items, issues, links = [], [], []
    valid_indexes = 0
    for index in MULTISPORT_INDEXES:
        try:
            root = page_root(fetcher.html(index))
            valid_indexes += 1
            for link in rdj.find(root, lambda n: n.tag == "a" and "lire l'analyse" in rdj.folded(n.plain())):
                url = source_url(link.attrs.get("href", ""))
                if MATCH_PATH.fullmatch(urlsplit(url).path) and url not in links:
                    links.append(url)
        except (ValueError, OSError) as exc:
            issues.append({"url": index, "code": str(exc)[:100]})
    for url in links[:16]:
        identity = MATCH_PATH.fullmatch(urlsplit(url).path).group(1)
        if identity in (exclude_ids or set()):
            continue
        try:
            page = fetcher.html(url)
            checked(MATCH_PATH.fullmatch(urlsplit(page.url).path) is not None and MATCH_PATH.fullmatch(urlsplit(page.url).path).group(1) == identity, "prediction_redirected_to_other_id")
            detail = rdj._detail(page)
            event_day = source_event_day(detail["kickoff"])
            following_nba = (detail["sport"] == "basketball" and rdj.folded(detail["competition"]) in {"nba", "national basketball association"}
                             and event_day == date.fromisoformat(edition) + timedelta(days=1))
            if detail["sport"] not in {"basketball", "volleyball"} or (event_day.isoformat() != edition and not following_nba):
                continue
            label, odds = _multisport_pick(detail, page)
            item = match_item(detail, page, "rdj_multisport_analysis", edition, resolver=resolver, pick=label, odds=odds)
            if eligible(item, edition, now, lead):
                items.append(item)
            else:
                issues.append({"url": url, "code": "outside_publication_window"})
            if len(items) >= limit:
                break
        except (ValueError, OSError) as exc:
            issues.append({"url": url, "code": getattr(exc, "code", str(exc)[:100])})
    return {"status": "ready" if items else "source_absent" if valid_indexes else "source_incomplete", "items": items, "issues": issues}


def _runners(root, url):
    scope = rdj.one(rdj.find(root, lambda n: n.attrs.get("id") == "partants"), "race runners")
    table = rdj.one(rdj.find(scope, lambda n: n.tag == "table"), "race runners table")
    result = []
    for row in rdj.find(table, lambda n: n.tag == "tr"):
        cells = [n for n in row.children if isinstance(n, rdj.Node) and n.tag == "td"]
        if not cells:
            continue
        checked(len(cells) >= 3 and re.fullmatch(r"\d+", cells[0].plain()), "runner_number_ambiguous")
        number = int(cells[0].plain())
        names = rdj.find(cells[1], lambda n: n.tag in {"strong", "b"})
        if len(names) != 1:
            # The source links expose the exact horse name even if its display markup changes.
            odds_links = rdj.find(cells[-1], lambda n: n.tag == "a" and n.has_class("cote-link"))
            labels = [n.attrs.get("title", "") for n in odds_links]
            labels = [re.fullmatch(r"Parier sur (.+) chez .+", label) for label in labels]
            checked(len(labels) == 1 and labels[0], "runner_name_missing")
            name = labels[0].group(1)
        else:
            name = names[0].plain()
        result.append({"number": number, "name": name})
        links = rdj.find(cells[-1], lambda n: n.tag == "a" and n.has_class("cote-link"))
        if len(links) == 1:
            raw = links[0].plain().replace(",", ".")
            if re.fullmatch(r"\d+(?:\.\d+)?", raw) and float(raw) > 0:
                result[-1]["odds"] = float(raw)
        shirts = rdj.find(cells[1], lambda n: n.tag == "img" and "casaque" in rdj.folded(n.attrs.get("alt") or ""))
        if len(shirts) == 1:
            shirt = image_url(shirts[0].attrs.get("data-src") or shirts[0].attrs.get("src"), url)
            if shirt:
                result[-1]["silksUrl"] = shirt
    checked(bool(result) and len({n["number"] for n in result}) == len(result), "runners_missing_or_duplicate")
    return result


def _turf_analysis_url(root, course_url):
    """Follow the course's authored analysis link, never a related-news search."""
    links = []
    for node in rdj.find(root, lambda n: n.tag == "a" and n.attrs.get("href")):
        if not rdj.folded(node.plain()).startswith("analyse complete de la course"):
            continue
        href = source_url(node.attrs["href"], course_url)
        checked(re.fullmatch(r"/turf/pronostic-turf/pronostics-quinte/\d+-[^/?#]+\.html", urlsplit(href).path), "race_analysis_url_invalid")
        if href not in links:
            links.append(href)
    checked(bool(links), "analysis_missing")
    checked(len(links) == 1, "race_analysis_link_ambiguous")
    return links[0]


def _turf_classic_analysis_url(bridge, course, edition):
    """One bounded editorial hop when the course links its illustrated explainer.

    This explainer is not race analysis. Only its related classic article for
    the exact same dated race may be followed; promotion and tickets are ignored.
    """
    course_root = page_root(course)
    checked(bridge.url == _turf_analysis_url(course_root, course.url), "race_analysis_redirect_conflict")
    identity = RACE_PATH.fullmatch(urlsplit(course.url).path)
    checked(identity is not None, "invalid_race_url")
    label = re.search(r"R(\d+)C(\d+)\s+(.+)$", rdj.one(rdj.find(course_root, lambda n: n.tag == "h1"), "race h1").plain())
    checked(label and label[1] == identity[2] and label[2] == identity[3], "race_title_conflict")
    name = rdj.folded(label[3])
    venue = rdj.folded(event(course_root, course.url)["location"]["name"])
    day = date.fromisoformat(edition)
    month = next(key for key, value in rdj.MONTHS.items() if value == day.month)
    when = r"(?:" + rdj.WEEKDAYS[day.weekday()] + r" )?" + str(day.day) + (r"(?:er)?" if day.day == 1 else "") + " " + month + r"(?: " + str(day.year) + r")?"
    root = page_root(bridge)
    article = rdj.one(rdj.find(root, lambda n: n.tag == "article" and n.has_class("news-article")), "race analysis article")
    title = rdj.folded(rdj.one(rdj.find(article, lambda n: n.tag == "h1"), "race analysis h1").plain())
    # Only spaced field separators may change. Internal name hyphens, such as
    # Saint-Cloud, belong to the race identity and must remain intact.
    title = re.sub(r"\s+[–—-]\s+", " - ", title)
    pattern = (r"pronostic quinte\+ du " + when + " - " + re.escape(name) + r" \(" + re.escape(venue)
               + " r" + identity[2] + "c" + identity[3] + r"\) : le turf decrypte comme un pronostic foot")
    checked(re.fullmatch(pattern, title) is not None, "race_analysis_bridge_identity_conflict")
    fiche = rdj.one(rdj.find(article, lambda n: n.has_class("news-fiche")), "race analysis course reference")
    backlinks = [source_url(n.attrs["href"], bridge.url) for n in rdj.find(fiche, lambda n: n.tag == "a" and n.attrs.get("href"))]
    checked(backlinks == [course.url], "race_analysis_course_reference_conflict")
    related = rdj.one(rdj.find(root, lambda n: n.tag == "section" and n.has_class("news-related")), "race related articles")
    checked(related.parent is article.parent, "race_analysis_related_scope_conflict")
    classic = (r"pronostic quinte du " + when + " a " + re.escape(venue) + " - " + re.escape(name)
               + " - r" + identity[2] + "c" + identity[3])
    links = []
    for node in rdj.find(related, lambda n: n.tag == "a" and n.has_class("news-related__link") and n.attrs.get("href")):
        text = re.sub(r"\s+[–—-]\s+", " - ", rdj.folded(node.plain()))
        if re.fullmatch(classic, text) is None:
            continue
        href = source_url(node.attrs["href"], bridge.url)
        checked(re.fullmatch(r"/turf/pronostic-turf/pronostics-quinte/\d+-[^/?#]+\.html", urlsplit(href).path)
                and href != bridge.url, "race_analysis_url_invalid")
        if href not in links:
            links.append(href)
    checked(len(links) == 1, "race_classic_analysis_link_ambiguous")
    return links[0]


def _turf_linked_analysis(page, course, edition, identity, race_name, racecourse, starts, runners, distance, bridge=None):
    course_url = course.url
    expected_url = (_turf_classic_analysis_url(bridge, course, edition)
                    if bridge is not None else _turf_analysis_url(page_root(course), course_url))
    checked(page.url == expected_url, "race_analysis_redirect_conflict")
    root = page_root(page)
    article = rdj.one(rdj.find(root, lambda n: n.tag == "article" and n.has_class("news-article")), "race analysis article")
    title = rdj.folded(rdj.one(rdj.find(article, lambda n: n.tag == "h1"), "race analysis h1").plain())
    title = re.sub(r"\s+[–—-]\s+", " - ", title)
    match = re.fullmatch(r"pronostic quinte du (?:(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche) )?(\d{1,2})(?:er)? (" + "|".join(rdj.MONTHS) + r")(?: (\d{4}))? a (.+?) - (.+?) - r(\d+)c(\d+)", title)
    checked(match is not None, "race_analysis_title_missing")
    day = date.fromisoformat(edition)
    checked(int(match[2]) == day.day and rdj.MONTHS[match[3]] == day.month
            and (not match[4] or int(match[4]) == day.year)
            and (not match[1] or match[1] == rdj.WEEKDAYS[day.weekday()]), "race_analysis_wrong_date")
    checked(match[5] == rdj.folded(racecourse) and match[6] == rdj.folded(race_name)
            and match[7] == identity[2] and match[8] == identity[3], "race_analysis_identity_conflict")
    # This editorial backlink includes the full year and exact course slug;
    # the article can legitimately have been published the previous day.
    fiche = rdj.one(rdj.find(article, lambda n: n.has_class("news-fiche")), "race analysis course reference")
    backlinks = [source_url(n.attrs["href"], page.url) for n in rdj.find(fiche, lambda n: n.tag == "a" and n.attrs.get("href"))]
    checked(backlinks == [course_url], "race_analysis_course_reference_conflict")
    body = rdj.one(rdj.find(article, lambda n: n.attrs.get("id") == "articleMainContent"), "race analysis body")
    conditions = rdj.one(rdj.find(body, lambda n: n.has_class("course-block")), "race analysis conditions")
    header = rdj.folded(rdj.one(rdj.find(conditions, lambda n: n.has_class("course-header")), "race analysis conditions header").plain())
    header = re.sub(r"\s+[–—-]\s+", " - ", header)
    expected_header = (rdj.folded(race_name) + " - " + rdj.folded(racecourse) + " - r" + identity[2] + "c" + identity[3]
                       + " - " + starts.astimezone(paris_timezone()).strftime("%Hh%M"))
    checked(header == expected_header, "race_analysis_conditions_conflict")
    values = {}
    for row in rdj.find(conditions, lambda n: n.has_class("course-row")):
        label, separator, value = rdj.folded(row.plain()).partition(":")
        checked(separator and label.strip() not in values, "race_analysis_conditions_ambiguous")
        values[label.strip()] = value.strip()
    checked(values.get("epreuve") == rdj.folded(race_name)
            and values.get("partants") == str(len(runners))
            and re.fullmatch(r"[\d ]+\s*m", values.get("distance", "")) is not None
            and int(values["distance"].replace("m", "").replace(" ", "")) == distance, "race_analysis_conditions_conflict")
    focus = rdj.one(rdj.find(body, lambda n: n.has_class("focus-block")), "race analysis focus")
    texts, seen = [], set()
    names = {row["number"]: rdj.folded(row["name"]) for row in runners}
    for node in rdj.find(focus, lambda n: n.has_class("focus-item")):
        text = node.plain()
        match = re.fullmatch(r"(\d+)\s*[-–—]\s*(.+?)\s+[–—]\s+(.+)", text)
        checked(match and len(match[3].split()) >= 12, "race_analysis_horse_text_missing")
        number = int(match[1])
        checked(number not in seen and names.get(number) == rdj.folded(match[2]), "race_analysis_runner_conflict")
        checked(not any("sponsored" in (n.attrs.get("rel") or "") for n in node.walk()), "race_analysis_sponsored")
        seen.add(number)
        texts.append(text)
    checked(bool(texts), "analysis_missing")
    return texts


def parse_turf(page, edition, *, analysis_page=None, analysis_bridge=None):
    root = page_root(page)
    identity = RACE_PATH.fullmatch(urlsplit(page.url).path)
    checked(identity is not None, "invalid_race_url")
    checked(datetime.strptime(identity[1], "%d-%m-%Y").date().isoformat() == edition, "race_url_wrong_date")
    ev = event(root, page.url)
    starts = iso(ev["startDate"])
    checked(edition_day(starts).isoformat() == edition, "race_event_wrong_date")
    checked(ev.get("eventStatus") == "https://schema.org/EventScheduled", "race_not_scheduled")
    racecourse = (ev.get("location") or {}).get("name")
    checked(isinstance(racecourse, str) and racecourse, "racecourse_missing")
    title = rdj.one(rdj.find(root, lambda n: n.tag == "h1"), "race h1").plain()
    label = re.search(r"R(\d+)C(\d+)\s+(.+)$", title)
    checked(label and label[1] == identity[2] and label[2] == identity[3], "race_title_conflict")
    desc = ev.get("description", "")
    distance = re.search(r"\bsur\s+([\d\s]+)\s*m\b", desc)
    count = re.search(r"\b(\d+)\s+partants\b", desc)
    discipline = re.search(r"course\s+de\s+(.+?)\s+sur\s+", desc, re.I)
    checked(distance and count and discipline, "race_conditions_missing")
    scope = rdj.one(rdj.find(root, lambda n: n.attrs.get("id") == "nospronos"), "RDJ race selection")
    picks = rdj.one(rdj.find(scope, lambda n: n.tag == "ol" and n.has_class("picks")), "RDJ ordered picks")
    numbers = [int(n.plain()) for n in rdj.find(picks, lambda n: n.tag == "li") if re.fullmatch(r"\d+", n.plain())]
    checked(len(numbers) >= 2 and len(set(numbers)) == len(numbers), "race_picks_missing_or_duplicate")
    runners = _runners(root, page.url)
    checked(set(numbers) <= {n["number"] for n in runners}, "selection_runner_missing")
    checked(len(runners) == int(count[1]), "runner_count_conflict")
    text = []
    for node in scope.children:
        if node is picks:
            break
        if isinstance(node, rdj.Node) and node.tag == "p" and len(node.plain().split()) >= 12:
            if not any("sponsored" in (n.attrs.get("rel") or "") for n in node.walk()):
                text.append(node.plain())
    if not text and analysis_page is not None:
        text = _turf_linked_analysis(analysis_page, page, edition, identity, label[3], racecourse,
                                     starts, runners, int(distance[1].replace(" ", "")), analysis_bridge)
    return {"source": "rdj_turf_quinte", "sourceId": edition + "-R" + identity[2] + "C" + identity[3],
            "sourceUrl": page.url, "editionDate": edition, "kind": "horse_racing",
            "title": {"fr": label[3] + " · " + racecourse},
            "summary": {"fr": "R" + identity[2] + "C" + identity[3] + " · " + discipline[1] + " · " + distance[1].replace(" ", "") + " m"},
            "startsAtUtc": utc_text(starts), "sport": {"key": "horse_racing", "name": "Courses hippiques"},
            "competition": {"name": label[3]},
            "race": {"meetingNumber": int(identity[2]), "raceNumber": int(identity[3]), "name": label[3],
                     "racecourse": racecourse, "discipline": discipline[1], "distanceMeters": int(distance[1].replace(" ", "")),
                     "runnersCount": int(count[1]), "runners": runners},
            "analysis": paragraphs(text, "Analyse de la course"),
            "selection": {"label": {"fr": "Sélection Quinté+"}, "odds": None, "betType": "quinte_selection",
                          "orderedNumbers": numbers}, "status": "upcoming"}


def collect_turf(edition, fetcher, *, now, resolver=None, lead=30, limit=1):
    root = page_root(fetcher.html(SOURCES["rdj_turf_quinte"]))
    links = []
    for n in rdj.find(root, lambda n: n.tag == "a" and n.attrs.get("href")):
        try:
            href = source_url(n.attrs["href"])
        except ValueError:
            continue
        match = RACE_PATH.fullmatch(urlsplit(href).path)
        if match and datetime.strptime(match[1], "%d-%m-%Y").date().isoformat() == edition and "quinte" in rdj.folded(n.plain()):
            if href not in links:
                links.append(href)
    if not links:
        return {"status": "source_absent", "items": [], "issues": []}
    checked(len(links) <= limit, "quinte_identity_ambiguous")
    items = []
    for url in links:
        page = fetcher.html(url)
        checked(page.url == url, "race_redirect_conflict")
        try:
            item = parse_turf(page, edition)
        except ParseError as exc:
            if str(exc) != "analysis_missing":
                raise
            article_url = _turf_analysis_url(page_root(page), page.url)
            article = fetcher.html(article_url)
            try:
                item = parse_turf(page, edition, analysis_page=article)
            except ParseError as article_error:
                if str(article_error) != "race_analysis_title_missing":
                    raise
                classic_url = _turf_classic_analysis_url(article, page, edition)
                item = parse_turf(page, edition, analysis_page=fetcher.html(classic_url), analysis_bridge=article)
        items.append(item)
    items = [item for item in items if eligible(item, edition, now, lead)]
    return {"status": "ready" if items else "outside_publication_window", "items": items, "issues": []}


def _article_date(root):
    articles = rdj.find(root, lambda n: n.tag == "article" and n.has_class("news-article"))
    article = rdj.one(articles, "editorial news article")
    meta = rdj.one(rdj.find(article, lambda n: n.tag == "p" and n.has_class("news-article__meta")), "news publication metadata")
    times = rdj.find(meta, lambda n: n.tag == "time" and n.attrs.get("datetime"))
    return iso(rdj.one(times, "news publication date").attrs["datetime"])


def _analysis_blocks(root):
    body = rdj.one(rdj.find(root, lambda n: n.attrs.get("id") == "articleMainContent"), "article body")
    h = rdj.one(rdj.find(body, lambda n: n.tag == "h2" and re.match(r"lanalyse (?:du|de ce) combine", rdj.folded(n.plain()).replace("'", ""))), "combi analysis heading")
    blocks, active = [], False
    # PMU nests analysis AND its next promotional h2 in one div. Traverse in
    # document order and stop at that h2 even across wrapper boundaries; never
    # flatten the div and accidentally ingest bookmaker instructions as prose.
    for n in body.walk():
        if n is h:
            active = True
            continue
        if not active:
            continue
        if n.tag == "h2":
            break
        if n.tag == "p" and n.plain():
            checked(not rdj.find(n, lambda a: "sponsored" in (a.attrs.get("rel") or "")), "combi_analysis_contains_ad")
            blocks.append(n.plain())
    checked(bool(blocks), "combi_analysis_empty")
    return body, blocks


def parse_combine(page, edition, fetcher, resolver, *, source="rdj_football_combine"):
    root = page_root(page)
    identity = COMBI_PATH.fullmatch(urlsplit(page.url).path)
    checked(identity is not None, "invalid_combi_url")
    _article_date(root)  # Validates metadata, but its offset never resolves kickoff.
    body, blocks = _analysis_blocks(root)
    explicit = []
    for n in rdj.find(body, lambda n: n.tag == "p"):
        raw = n.plain()
        match = re.search(r'(?:pari|le) combin[eé]\s+["«](.+?)["»]\s+est cot[eé]\s+[aà]\s+(\d+[,.]\d+)\s+chez\s+(.+?)(?:\s*[-—]\s*|$)', raw, re.I)
        if match:
            explicit.append((match[1], float(match[2].replace(",", ".")), match[3].strip()))
    checked(len(set(explicit)) == 1, "one_explicit_combine_market_and_price_required")
    market, total, bookmaker = explicit[0]
    checked(math.isfinite(total) and total > 1, "invalid_combine_odds")
    # Format supported by the verified modern COMBI article: each exact match
    # heading is a paragraph, then its analysis. No LLM guesses at segmentation.
    groups, pending = [], None
    for block in blocks:
        heading = re.fullmatch(r"(.+?)\s+[—–-]\s+(.+?)\s*\(([^)]+)\)\s*:\s*(.*)", block)
        if heading:
            pending = {"home": heading[1], "away": heading[2], "displayClock": heading[3], "paragraphs": []}
            if heading[4]:
                pending["paragraphs"].append(heading[4])
            groups.append(pending)
        elif pending is not None:
            pending["paragraphs"].append(block)
        else:
            raise ParseError("combi_analysis_unbound_paragraph")
    checked(2 <= len(groups) <= 5 and all(g["paragraphs"] for g in groups), "combi_leg_analysis_missing")
    # Legacy format scopes one BTTS instruction over a list of exact pairs;
    # modern PMU tickets spell a distinct market for every leg instead.
    prefix = re.match(r"les (?:2|deux) [eé]quipes marquent\s+", market, re.I)
    if prefix:
        parts = market[prefix.end():].split("+")
        market_pairs = []
        for part in parts:
            sides = re.fullmatch(r"\s*(.+?)\s+[—–-]\s+(.+?)\s*", part)
            checked(sides is not None, "combi_market_participants_ambiguous")
            market_pairs.append([team_key(sides[1]), team_key(sides[2])])
        checked(market_pairs == [[team_key(g["home"]), team_key(g["away"])] for g in groups], "combi_market_participants_conflict")
        labels = ["Les deux équipes marquent"] * len(groups)
    else:
        parts = [part.strip() for part in market.split("+")]
        checked(len(parts) == len(groups), "combi_market_leg_count_conflict")
        labels = []
        for part, group in zip(parts, groups):
            contextual = re.fullmatch(r"(.+?)\s+[—–-]\s+(.+?)\s*:\s*(.+)", part)
            if contextual:
                checked([team_key(contextual[1]), team_key(contextual[2])] == [team_key(group["home"]), team_key(group["away"])], "combi_market_participants_conflict")
                label = contextual[3]
                if re.fullmatch(r"Les (?:2|deux) marquent", label, re.I):
                    label = "Les deux équipes marquent"
            else:
                label = part
            # Winner shorthand must bind to exactly one group participant.
            kind, _ = describe_market(label, [group["home"], group["away"]], "football")
            checked(contextual is not None or kind == "match_winner", "combi_market_context_required")
            labels.append(label)
    # No dates are inferred from 'Wednesday'. The article date/URL must identify
    # the requested edition, and every match must bind to a real prediction page.
    path_date = re.search(r"(?<!\d)(\d{2})-(\d{2})-(\d{4})(?!\d)", urlsplit(page.url).path)
    checked(path_date and f"{path_date[3]}-{path_date[2]}-{path_date[1]}" == edition, "combi_wrong_edition")
    links = _fixture_links(root)
    if not links:
        catalogue = page_root(fetcher.html(SOURCES["rdj_football_analysis"]))
        links = _fixture_links(catalogue)
    legs = []
    for group, label in zip(groups, labels):
        pair = [team_key(group[s]) for s in ("home", "away")]
        checked(all(pair), "combi_participant_unknown")
        matched = []
        for url in links[:30]:
            # Decode source slugs only to bound requests; never use them as names.
            slug = urlsplit(url).path.rsplit("/", 1)[-1].rsplit("-", 1)[0].replace("-", " ")
            if not all(_slug_candidate(slug, group[s]) for s in ("home", "away")):
                continue
            p = fetcher.html(url)
            checked(MATCH_PATH.fullmatch(urlsplit(p.url).path) is not None and MATCH_PATH.fullmatch(urlsplit(p.url).path).group(1) == MATCH_PATH.fullmatch(urlsplit(url).path).group(1), "prediction_redirected_to_other_id")
            detail = rdj._detail(p)
            if [team_key(detail[s]) for s in ("home", "away")] != pair:
                continue
            if source_event_day(detail["kickoff"]).isoformat() != edition:
                continue
            clock = re.fullmatch(r"(?:(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+)?([01]?\d|2[0-3])[:h]([0-5]\d)", rdj.folded(group["displayClock"]).strip())
            checked(clock is not None, "combi_displayed_time_conflict")
            checked(clock[1] is None or clock[1] == rdj.WEEKDAYS[date.fromisoformat(edition).weekday()], "combi_displayed_weekday_conflict")
            # Author clock and detail may independently display UTC or Paris.
            # Reconcile BOTH to the same verified provider instant, including DST.
            author = datetime.combine(date.fromisoformat(edition), datetime.min.time()).replace(hour=int(clock[2]), minute=int(clock[3]))
            fixture = {"home": detail["home"], "away": detail["away"], "sport": "football", "competition": detail["competition"], "source_url": p.url, "journal_source_url": page.url}
            try:
                verified, _ = rdj._utc(fixture, author, detail["kickoff"], date.fromisoformat(edition), resolver)
            except ValueError as exc:
                raise ParseError("combi_displayed_time_conflict") from exc
            matched.append((p, detail, iso(verified)))
        checked(len(matched) == 1, "combi_match_identity_unresolved")
        p, detail, kickoff = matched[0]
        # Shorthand 'Stuttgart' is retained in the FR label; names in the match
        # identity remain the source detail's full, verified team names.
        leg = match_item(detail, p, source, edition, resolver=resolver, pick=label, odds=None, kickoff=kickoff)
        leg["selection"]["betType"] = describe_market(label, [detail["home"], detail["away"]], "football")[0]
        leg["analysis"] = paragraphs(group["paragraphs"], "Analyse du match")
        legs.append(leg)
    start = min(iso(n["startsAtUtc"]) for n in legs)
    title = rdj.one(rdj.find(root, lambda n: n.tag == "h1"), "combi title").plain()
    if source == "rdj_football_duo":
        checked(len(legs) == 2 and 2 <= total <= 4, "duo_requires_two_legs_and_total_2_to_4")
    if source == "rdj_football_goals":
        checked(2 <= len(legs) <= 3 and all(leg["selection"]["betType"] in GOAL_TYPES for leg in legs), "goals_requires_two_or_three_goal_markets")
    checked(len({leg["sourceId"] for leg in legs}) == len(legs), "duplicate_combine_fixture")
    return {"source": source, "sourceId": identity.group("id"), "sourceUrl": page.url,
            "editionDate": edition, "kind": "combine", "title": {"fr": {"rdj_football_duo": "Le Duo du Jour", "rdj_football_goals": "Combiné Buts"}.get(source, "Combiné football")},
            "summary": {"fr": " · ".join(n["title"]["fr"] for n in legs)}, "startsAtUtc": utc_text(start),
            "sport": {"key": "football", "name": "Football"}, "competition": {"name": "Combiné football"},
            "analysis": paragraphs(["Analyse de chaque rencontre ci-dessous."], "Le ticket"),
            "selection": {"label": {"fr": market}, "odds": None, "totalOdds": total, "betType": "combine" if source == "rdj_football_combine" else "accumulator"},
            "curation": {"kind": "publisher_ticket", "publisher": "RDJ", "bookmaker": bookmaker, "sourceUrl": page.url},
            "legs": legs, "status": "upcoming"}


def team_key(value):
    # Spellings explicitly observed in the same 21 October RDJ COMBI article
    # and its linked match pages. Finite aliases, never fuzzy identity matching.
    value = _provider_name(value, True)
    return {"come": "como", "manu": "manchesterunited", "stuttgat": "stuttgart", "vfbstuttgart": "stuttgart", "mgladbach": "borussiamonchengladbach"}.get(value, value)


def _slug_candidate(slug, name):
    raw = re.sub(r"[^a-z0-9]", "", rdj.folded(slug))
    key = team_key(name)
    aliases = {"stuttgart": ("stuttgart",), "borussiamonchengladbach": ("mgladbach", "monchengladbach"), "manchesterunited": ("manchesterunited", "manu"), "como": ("como", "come")}
    return any(part in raw for part in aliases.get(key, (key,)))


def ticket_fingerprint(item):
    """Server-compatible, versioned composition; IDs/odds/prose are not identity."""
    legs = []
    for leg in item.get("legs", []):
        teams = [leg["teams"][side]["name"] for side in ("home", "away")]
        kind, english = describe_market(leg["selection"]["label"]["fr"], teams, "football")
        checked(kind == leg['selection'].get('betType'), 'ticket_market_type_conflict')
        def decimal(value):
            whole, dot, fraction = value.replace(',', '.').partition('.')
            return (whole.lstrip('0') or '0') + ('.' + fraction.rstrip('0') if fraction.rstrip('0') else '')
        if kind == 'btts':
            selection = [kind, 'no' if english.endswith('No') else 'yes']
        elif kind == 'over_under_goals':
            match = re.fullmatch(r'(Over|Under) (\d+(?:\.\d+)?) goals', english)
            checked(match is not None, 'ticket_market_unverifiable')
            selection = [kind, match[1].lower(), decimal(match[2])]
        elif kind == 'team_goals':
            match = re.fullmatch(r'(.+) (over|under) (\d+(?:\.\d+)?) goals', english)
            checked(match is not None, 'ticket_market_unverifiable')
            selection = [kind, team_key(match[1]), match[2], decimal(match[3])]
        elif kind == 'match_winner':
            checked(english.endswith(' to win'), 'ticket_market_unverifiable')
            selection = [kind, team_key(english[:-7])]
        elif kind == 'draw':
            selection = [kind]
        else:
            raise ParseError('ticket_market_unverifiable')
        moment = iso(leg['startsAtUtc'])
        checked(moment.microsecond == 0, 'ticket_start_precision_invalid')
        legs.append([utc_text(moment), *[team_key(name) for name in teams], *selection])
    checked(2 <= len(legs) <= 3, 'ticket_composition_invalid')
    checked(len({tuple(leg[:3]) for leg in legs}) == len(legs), 'ticket_duplicate_event')
    packed = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    legs.sort(key=packed)
    return hashlib.sha256(packed(['rdj-ticket-v1', legs]).encode()).hexdigest()


def collect_combine(edition, fetcher, *, now, resolver, lead=30, limit=2, source="rdj_football_combine", exclude_ids=None, exclude_ticket_fingerprints=None, pinned_ticket=None):
    links, issues, items = [], [], []
    roots = []
    if pinned_ticket is not None:
        # Published Duo identity survives index reorder, a later better ticket,
        # disappearance from the listing, and a fresh worker state directory.
        try:
            checked(source == 'rdj_football_duo', 'pinned_ticket_source_conflict')
            url = source_url(pinned_ticket['sourceUrl'])
            match = COMBI_PATH.fullmatch(urlsplit(url).path)
            checked(match is not None and match['id'] == pinned_ticket['sourceId'], 'pinned_ticket_identity_conflict')
            item = parse_combine(fetcher.html(url), edition, fetcher, resolver, source=source)
            checked(item['sourceId'] == pinned_ticket['sourceId'] and ticket_fingerprint(item) == pinned_ticket['fingerprint'], 'published_ticket_composition_changed')
            checked(ticket_fingerprint(item) not in (exclude_ticket_fingerprints or set()), 'ticket_reserved_in_other_family')
            checked(not any(leg['sourceId'] in (exclude_ids or set()) for leg in item['legs']), 'ticket_contains_free_fixture')
            if eligible(item, edition, now, lead) and all(eligible(leg, edition, now, lead) for leg in item['legs']):
                items.append(item)
            return {'status': 'ready' if items else 'source_absent', 'items': items, 'issues': []}
        except (ValueError, OSError, KeyError, TypeError) as exc:
            return {'status': 'source_incomplete', 'items': [], 'issues': [{'code': 'published_duo_unavailable_or_changed', 'detail': str(exc)[:100]}]}
    # A current article in the news index does not imply that PMU's independent
    # current ticket is present there. Always inspect these three bounded lists;
    # the shared fetcher reuses each GET across all three compatible adapters.
    for index in COMBINE_INDEXES:
        try:
            roots.append(page_root(fetcher.html(index)))
        except (ValueError, OSError) as exc:
            issues.append({"url": index, "code": str(exc)[:100]})
    for root in roots:
        for url in _dated_combine_links(root, edition):
            if url not in links:
                links.append(url)
    for url in links[:4]:
        try:
            item = parse_combine(fetcher.html(url), edition, fetcher, resolver, source=source)
            checked(not any(leg["sourceId"] in (exclude_ids or set()) for leg in item["legs"]), "ticket_contains_free_fixture")
            checked(ticket_fingerprint(item) not in (exclude_ticket_fingerprints or set()), "ticket_reserved_in_other_family")
            if eligible(item, edition, now, lead) and all(eligible(leg, edition, now, lead) for leg in item["legs"]):
                items.append(item)
            if source != "rdj_football_duo" and len(items) >= limit:
                break
        except (ValueError, OSError) as exc:
            issues.append({"url": url, "code": getattr(exc, "code", str(exc)[:100])})
    if source == "rdj_football_duo":
        # Among equally verified publisher tickets prefer a mixed/result ticket,
        # then deterministic event time and publisher ID. Never force a quota.
        items.sort(key=lambda item: (all(leg["selection"].get("betType") in GOAL_TYPES for leg in item["legs"]), item["startsAtUtc"], int(item["sourceId"])))
        items = items[:1]
    # Duplicate article links or copied tickets never fill the same family twice.
    distinct = {}
    for item in items:
        distinct.setdefault(ticket_fingerprint(item), item)
    items = list(distinct.values())
    return {"status": "ready" if items else "source_absent" if roots else "source_incomplete", "items": items, "issues": issues}


def _dated_combine_links(root, edition):
    links = []
    for link in rdj.find(root, lambda n: n.tag == "a" and n.attrs.get("href")):
        try:
            url = source_url(link.attrs["href"])
        except ValueError:
            continue
        path = urlsplit(url).path
        match = re.search(r"(\d{2})-(\d{2})-(\d{4})", path)
        if (COMBI_PATH.fullmatch(path) and re.search(r"\bcombi(?:ne)?\b", rdj.folded(path.rsplit("/", 1)[-1]))
                and match and f"{match[3]}-{match[2]}-{match[1]}" == edition and url not in links):
            links.append(url)
    return links


def collect(source, edition, fetcher, *, now, lead=30, exclude_ids=None, exclude_ticket_fingerprints=None, pinned_ticket=None):
    checked(source in SOURCES, "unknown_source")
    checked(date.fromisoformat(edition).isoformat() == edition and now.tzinfo is not None, "date_or_clock_invalid")
    resolver = VerifiedKickoffs(fetch_json=fetcher.json)
    kwargs = {"now": now, "resolver": resolver, "lead": lead}
    if source in {"rdj_football_analysis", "rdj_multisport_analysis", "rdj_football_duo", "rdj_football_goals", "rdj_football_combine"}:
        kwargs["exclude_ids"] = exclude_ids
    adapters = {"rdj_petit_journal": collect_petit, "rdj_turf_quinte": collect_turf,
                "rdj_football_analysis": collect_football, "rdj_football_combine": collect_combine,
                "rdj_football_duo": collect_combine, "rdj_football_goals": collect_combine,
                "rdj_multisport_analysis": collect_multisport}
    if source in {"rdj_football_duo", "rdj_football_goals"}:
        kwargs["source"] = source
    if source in {"rdj_football_duo", "rdj_football_goals"}:
        kwargs["exclude_ticket_fingerprints"] = exclude_ticket_fingerprints
    if source == 'rdj_football_duo':
        kwargs['pinned_ticket'] = pinned_ticket
    refused_before = len(getattr(fetcher, 'budget_refusals', []))
    try:
        result = adapters[source](edition, fetcher, **kwargs)
    except (ValueError, OSError) as exc:
        result = {"status": "source_incomplete", "items": [], "issues": [{"code": getattr(exc, "code", str(exc)[:140])}]}
    refused = getattr(fetcher, 'budget_refusals', [])[refused_before:]
    if refused:
        # Scope this decision to refusals DURING this source call. A subsequent
        # source fully satisfied from memory is still complete and may proceed.
        return {'status': 'source_incomplete', 'items': [], 'issues': [*result['issues'],
            {'code': 'source_public_budget_refused', 'source': source, 'limits': refused}]}
    return result
