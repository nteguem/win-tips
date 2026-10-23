"""Four explicit RDJ adapters; missing or ambiguous data never creates a ticket."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
import math
import re
from urllib.parse import urljoin, urlsplit

from .vendor import rdj_collector as rdj
from .vendor.timing import OfficialKickoffs, _provider_name
from .calendar import edition_day, source_event_day

HOST = "https://www.ruedesjoueurs.com"
SOURCES = {
    "rdj_petit_journal": HOST + "/paris-sportifs/le-petit-journal.html",
    "rdj_turf_quinte": HOST + "/turf/pronostic-turf.html",
    "rdj_football_analysis": HOST + "/pronostics/foot.html",
    "rdj_football_combine": HOST + "/actualites/paris-sportifs.html",
}
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
                       "competition": detail["competition"], "source_url": page.url, "journal_source_url": page.url}
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
    return {"source": source, "sourceId": MATCH_PATH.fullmatch(urlsplit(page.url).path).group(1),
            "sourceUrl": page.url, "editionDate": edition, "kind": "match",
            "title": {"fr": detail["home"] + " — " + detail["away"]},
            "summary": {"fr": expert.get("text") or detail["headline_fr"]},
            "startsAtUtc": utc_text(kickoff), "sport": {"key": detail["sport"], "name": detail["sport"].capitalize()},
            "competition": {"name": detail["competition"]}, "teams": teams,
            "analysis": paragraphs(detail["analysis_paragraphs"]),
            "selection": {"label": {"fr": pick}, "odds": odds}, "status": "upcoming"}


def eligible(item, edition, now, lead=30):
    instant = iso(item["startsAtUtc"])
    return edition_day(instant).isoformat() == edition and instant >= now + timedelta(minutes=lead)


def collect_petit(edition, fetcher, *, now, resolver, lead=30, limit=8):
    packet = rdj.collect_edition(edition, fetcher=fetcher.html, kickoff_resolver=resolver, now=now, max_index_pages=2)
    if packet["status"] != "ready":
        return {"status": packet["status"], "items": [], "issues": packet.get("issues", [])}
    items = []
    for fixture in packet["fixtures"]:
        p = fetcher.html(fixture["source_url"])
        detail = rdj._detail(p)
        item = match_item(detail, p, "rdj_petit_journal", edition, resolver=resolver,
                          pick=fixture["pick_fr"], odds=fixture["odds"], kickoff=iso(fixture["kickoff_utc"]))
        item["sourceUrl"] = fixture["journal_source_url"]
        if not eligible(item, edition, now, lead):
            return {"status": "outside_publication_window", "items": [], "issues": []}
        items.append(item)
    checked(len(items) <= limit, "petit_card_limit")
    return {"status": "ready", "items": items, "issues": []}


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


def collect_football(edition, fetcher, *, now, resolver, lead=30, limit=6, exclude_ids=None):
    root = page_root(fetcher.html(SOURCES["rdj_football_analysis"]))
    # Prefer editorial analysis links. The live/results sidebar is outside this scope.
    editorial = rdj.find(root, lambda n: n.tag == "a" and "lire l'analyse" in rdj.folded(n.plain()))
    links = []
    for n in editorial:
        href = source_url(n.attrs.get("href") or "")
        if MATCH_PATH.fullmatch(urlsplit(href).path) and href not in links:
            links.append(href)
    issues, items = [], []
    for url in links[:20]:
        match_id = MATCH_PATH.fullmatch(urlsplit(url).path).group(1)
        if match_id in (exclude_ids or set()):
            continue
        try:
            p = fetcher.html(url)
            detail = rdj._detail(p)
            if detail["sport"] != "football" or source_event_day(detail["kickoff"]).isoformat() != edition:
                continue
            item = match_item(detail, p, "rdj_football_analysis", edition, resolver=resolver)
            if eligible(item, edition, now, lead):
                items.append(item)
            if len(items) >= limit:
                break
        except (ValueError, OSError) as exc:
            issues.append({"url": url, "code": getattr(exc, "code", str(exc)[:100])})
    return {"status": "ready" if items else "source_absent", "items": items, "issues": issues}


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


def parse_turf(page, edition):
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
            "selection": {"label": {"fr": "Sélection Quinté+ RDJ"}, "odds": None, "betType": "quinte_selection",
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
    items = [parse_turf(fetcher.html(url), edition) for url in links]
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
    h = rdj.one(rdj.find(body, lambda n: n.tag == "h2" and rdj.folded(n.plain()).replace("'", "").startswith("lanalyse du combine")), "combi analysis heading")
    children = h.parent.children
    start = next(i for i, n in enumerate(children) if n is h)
    blocks = []
    for n in children[start + 1:]:
        if isinstance(n, str):
            if rdj.text(n):
                blocks.append(rdj.text(n))
            continue
        if n.tag == "h2":
            break
        checked(n.tag in {"p", "strong", "b", "br", "div"}, "combi_analysis_structure_unknown")
        if n.tag != "br" and n.plain():
            checked(not rdj.find(n, lambda a: "sponsored" in (a.attrs.get("rel") or "")), "combi_analysis_contains_ad")
            blocks.append(n.plain())
    checked(bool(blocks), "combi_analysis_empty")
    return body, blocks


def parse_combine(page, edition, fetcher, resolver):
    root = page_root(page)
    identity = COMBI_PATH.fullmatch(urlsplit(page.url).path)
    checked(identity is not None, "invalid_combi_url")
    _article_date(root)  # Validates metadata, but its offset never resolves kickoff.
    body, blocks = _analysis_blocks(root)
    explicit = []
    for n in rdj.find(body, lambda n: n.tag == "p"):
        raw = n.plain()
        match = re.search(r'pari combin[eé]\s+["«](.+?)["»]\s+est cot[eé]\s+[aà]\s+(\d+[,.]\d+)\s+chez\s+', raw, re.I)
        if match:
            explicit.append((match[1], float(match[2].replace(",", "."))))
    checked(len(set(explicit)) == 1, "one_explicit_combine_market_and_price_required")
    market, total = explicit[0]
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
    prefix = re.match(r"les (?:2|deux) [eé]quipes marquent\s+", market, re.I)
    checked(prefix is not None, "combi_market_requires_new_explicit_adapter")
    market_pairs = []
    for part in market[prefix.end():].split("+"):
        sides = re.fullmatch(r"\s*(.+?)\s+[—–-]\s+(.+?)\s*", part)
        checked(sides is not None, "combi_market_participants_ambiguous")
        market_pairs.append([team_key(sides[1]), team_key(sides[2])])
    checked(market_pairs == [[team_key(g["home"]), team_key(g["away"])] for g in groups], "combi_market_participants_conflict")
    # No dates are inferred from 'Wednesday'. The article date/URL must identify
    # the requested edition, and every match must bind to a real prediction page.
    path_date = re.search(r"(?<!\d)(\d{2})-(\d{2})-(\d{4})(?!\d)", urlsplit(page.url).path)
    checked(path_date and f"{path_date[3]}-{path_date[2]}-{path_date[1]}" == edition, "combi_wrong_edition")
    links = _fixture_links(root)
    if not links:
        catalogue = page_root(fetcher.html(SOURCES["rdj_football_analysis"]))
        links = _fixture_links(catalogue)
    legs = []
    for group in groups:
        pair = [team_key(group[s]) for s in ("home", "away")]
        checked(all(pair), "combi_participant_unknown")
        matched = []
        for url in links[:30]:
            # Decode source slugs only to bound requests; never use them as names.
            slug = urlsplit(url).path.rsplit("/", 1)[-1].rsplit("-", 1)[0].replace("-", " ")
            if not all(any(part in rdj.folded(slug) for part in re.findall(r"[a-z]{3,}", rdj.folded(group[s]))) for s in ("home", "away")):
                continue
            p = fetcher.html(url)
            detail = rdj._detail(p)
            if [team_key(detail[s]) for s in ("home", "away")] != pair:
                continue
            if source_event_day(detail["kickoff"]).isoformat() != edition:
                continue
            clock = re.search(r"(?<!\d)(\d{1,2})[:h](\d{2})(?!\d)", group["displayClock"])
            checked(clock is not None and (detail["kickoff"].hour, detail["kickoff"].minute) == (int(clock[1]), int(clock[2])),
                    "combi_displayed_time_conflict")
            matched.append((p, detail))
        checked(len(matched) == 1, "combi_match_identity_unresolved")
        p, detail = matched[0]
        # Only this explicitly supported market maps unambiguously to every leg.
        label = "Les deux équipes marquent"
        leg = match_item(detail, p, "rdj_football_combine", edition, resolver=resolver, pick=label, odds=None)
        leg["analysis"] = paragraphs(group["paragraphs"], "Analyse du match")
        legs.append(leg)
    start = min(iso(n["startsAtUtc"]) for n in legs)
    title = rdj.one(rdj.find(root, lambda n: n.tag == "h1"), "combi title").plain()
    return {"source": "rdj_football_combine", "sourceId": identity.group("id"), "sourceUrl": page.url,
            "editionDate": edition, "kind": "combine", "title": {"fr": "Combiné football RDJ"},
            "summary": {"fr": " · ".join(n["title"]["fr"] for n in legs)}, "startsAtUtc": utc_text(start),
            "sport": {"key": "football", "name": "Football"}, "competition": {"name": "Combiné football"},
            "analysis": paragraphs(["Analyse de chaque rencontre ci-dessous."], "Le ticket"),
            "selection": {"label": {"fr": market}, "odds": None, "totalOdds": total, "betType": "combine"},
            "legs": legs, "status": "upcoming"}


def team_key(value):
    # Spellings explicitly observed in the same 21 October RDJ COMBI article
    # and its linked match pages. Finite aliases, never fuzzy identity matching.
    value = _provider_name(value, True)
    return {"come": "como", "manu": "manchesterunited"}.get(value, value)


def collect_combine(edition, fetcher, *, now, resolver, lead=30, limit=2):
    root = page_root(fetcher.html(SOURCES["rdj_football_combine"]))
    links, issues, items = [], [], []
    for tile in rdj.find(root, lambda n: n.tag == "article" and n.has_class("news-tile")):
        headings = rdj.find(tile, lambda n: n.tag in {"h2", "h3"})
        if not headings or not re.search(r"\bcombi(?:ne)?\b", rdj.folded(headings[0].plain())):
            continue
        for link in rdj.find(headings[0], lambda n: n.tag == "a" and n.attrs.get("href")):
            url = source_url(link.attrs["href"])
            m = re.search(r"(\d{2})-(\d{2})-(\d{4})", urlsplit(url).path)
            if COMBI_PATH.fullmatch(urlsplit(url).path) and m and f"{m[3]}-{m[2]}-{m[1]}" == edition:
                if url not in links:
                    links.append(url)
    for url in links[:4]:
        try:
            item = parse_combine(fetcher.html(url), edition, fetcher, resolver)
            if eligible(item, edition, now, lead) and all(eligible(leg, edition, now, lead) for leg in item["legs"]):
                items.append(item)
            if len(items) >= limit:
                break
        except (ValueError, OSError) as exc:
            issues.append({"url": url, "code": getattr(exc, "code", str(exc)[:100])})
    return {"status": "ready" if items else "source_absent", "items": items, "issues": issues}


def collect(source, edition, fetcher, *, now, lead=30, exclude_ids=None):
    checked(source in SOURCES, "unknown_source")
    checked(date.fromisoformat(edition).isoformat() == edition and now.tzinfo is not None, "date_or_clock_invalid")
    resolver = OfficialKickoffs(fetch_json=fetcher.json)
    kwargs = {"now": now, "resolver": resolver, "lead": lead}
    if source == "rdj_football_analysis":
        kwargs["exclude_ids"] = exclude_ids
    adapters = {"rdj_petit_journal": collect_petit, "rdj_turf_quinte": collect_turf,
                "rdj_football_analysis": collect_football, "rdj_football_combine": collect_combine}
    try:
        return adapters[source](edition, fetcher, **kwargs)
    except (ValueError, OSError) as exc:
        return {"status": "source_incomplete", "items": [], "issues": [{"code": getattr(exc, "code", str(exc)[:140])}]}
