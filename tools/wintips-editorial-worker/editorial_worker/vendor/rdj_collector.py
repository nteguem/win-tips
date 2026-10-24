"""Read-only RDJ journal collection. No translation, rendering or publishing.

The journal card owns its pick/odds pair. Linked prediction pages provide names,
sport, analysis and artwork; their alternative prices are retained as evidence.
Naive RDJ clocks are never interpreted as publication-time offsets. An injected
verified-schedule resolver is required unless the event itself has an offset.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
import hashlib
import json
import re
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zoneinfo import ZoneInfoNotFoundError
from ..calendar import paris_timezone

INDEX_URL = "https://www.ruedesjoueurs.com/paris-sportifs/le-petit-journal.html"
EDITION_TIMEZONE = "Europe/Paris"  # Edition calendar only; NOT an event clock policy.
MAX_BYTES = 3_000_000
MAX_TEASER_CHARS = 140
RDJ_HOSTS = {"www.ruedesjoueurs.com", "ruedesjoueurs.com"}
MONTHS = {name: index for index, name in enumerate(
    ("janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"), 1)}
WEEKDAYS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
SPORTS = {"football": "football", "foot": "football", "tennis": "tennis", "basket": "basketball", "basketball": "basketball",
          "basket-ball": "basketball", "rugby": "rugby", "handball": "handball", "volleyball": "volleyball",
          "volley": "volleyball", "volley-ball": "volleyball", "hockey": "hockey", "badminton": "badminton", "football americain": "american_football"}


def text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def folded(value: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", value.casefold()) if not unicodedata.combining(c)).replace("’", "'")


class SourceError(ValueError):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code


@dataclass
class Node:
    tag: str
    attrs: dict[str, str | None] = field(default_factory=dict)
    children: list = field(default_factory=list)
    parent: Node | None = field(default=None, repr=False)

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def content(self) -> str:
        if self.tag in {"script", "style", "noscript"}:
            return ""
        return " ".join(c if isinstance(c, str) else c.content() for c in self.children)

    def plain(self) -> str:
        return text(self.content())

    def has_class(self, name: str) -> bool:
        return name in (self.attrs.get("class") or "").split()


class Document(HTMLParser):
    def __init__(self, html: str):
        super().__init__(convert_charrefs=True)
        self.root = Node("document")
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs), parent=self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if self.stack[-1].tag == tag:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def find(root: Node, predicate) -> list[Node]:
    return [node for node in root.walk() if predicate(node)]


def one(nodes: list[Node], label: str) -> Node:
    if len(nodes) != 1:
        raise SourceError("structure_ambiguous", f"{label}: expected one element, found {len(nodes)}")
    return nodes[0]


def rdj_url(value: str, base: str = INDEX_URL) -> str:
    try:
        parts = urlsplit(urljoin(base, value))
        valid = parts.scheme == "https" and parts.hostname in RDJ_HOSTS and not parts.username and not parts.password and parts.port in {None, 443}
    except (ValueError, TypeError) as exc:
        raise SourceError("untrusted_source_url", "Invalid source URL") from exc
    if not valid:
        raise SourceError("untrusted_source_url", "Only HTTPS RDJ source pages are followed")
    return urlunsplit(("https", "www.ruedesjoueurs.com", parts.path, parts.query, ""))


@dataclass(frozen=True)
class FetchedPage:
    url: str
    html: str
    status: int = 200


class _RDJRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, rdj_url(newurl, req.full_url))


def fetch_page(url: str) -> FetchedPage:
    """Bounded HTTP GET, no credentials/cookies, redirects restricted to RDJ."""
    request = Request(rdj_url(url), headers={"User-Agent": "Mozilla/5.0 (compatible; JournalWorker/1.0; read-only source collector)", "Accept": "text/html"})
    try:
        with build_opener(_RDJRedirect()).open(request, timeout=30) as response:
            if response.headers.get_content_type() not in {"text/html", "application/xhtml+xml"}:
                raise SourceError("unexpected_content_type", "RDJ page is not HTML")
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise SourceError("source_too_large", "RDJ page exceeds the bounded download limit")
            return FetchedPage(rdj_url(response.url), body.decode(response.headers.get_content_charset() or "utf-8"), response.status)
    except HTTPError as exc:
        return FetchedPage(url, "", exc.code)
    except (URLError, UnicodeError, TimeoutError) as exc:
        raise SourceError("source_unavailable", type(exc).__name__) from exc


def _fetch(fetcher, url: str, records: list) -> FetchedPage:
    try:
        page = fetcher(url)
    except SourceError:
        raise
    except Exception as exc:
        raise SourceError("source_unavailable", "Source fetch failed: " + type(exc).__name__) from exc
    if isinstance(page, str):
        page = FetchedPage(url, page)
    if not isinstance(page, FetchedPage):
        raise SourceError("fetch_contract", "fetcher must return FetchedPage or HTML string")
    rdj_url(page.url)
    records.append({"requested_url": url, "final_url": page.url, "status": page.status,
                    "sha256_utf8": hashlib.sha256(page.html.encode("utf-8")).hexdigest()})
    if page.status != 200:
        raise SourceError("http_" + str(page.status), "RDJ returned HTTP " + str(page.status))
    if len(page.html.encode("utf-8")) > MAX_BYTES:
        raise SourceError("source_too_large", "RDJ page exceeds the bounded download limit")
    return page


def dates_in(value: str, *, weekday_check: bool = True) -> set[date]:
    value = folded(value).replace("-", " ")
    result = set()
    pattern = r"(?:(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+)?(\d{1,2})(?:er)?\s+(" + "|".join(MONTHS) + r")\s+(\d{4})"
    try:
        for match in re.finditer(pattern, value):
            day = date(int(match[4]), MONTHS[match[3]], int(match[2]))
            if weekday_check and match[1] and WEEKDAYS[day.weekday()] != match[1]:
                raise SourceError("weekday_mismatch", "Written weekday conflicts with the calendar date")
            result.add(day)
        for match in re.finditer(r"(?<!\d)(\d{1,2})/(\d{1,2})/(\d{4})(?!\d)", value):
            result.add(date(int(match[3]), int(match[2]), int(match[1])))
    except ValueError as exc:
        if isinstance(exc, SourceError):
            raise
        raise SourceError("invalid_source_date", "Invalid calendar date in source") from exc
    return result


def only_date(value: str) -> date:
    days = dates_in(value)
    if len(days) != 1:
        raise SourceError("date_ambiguous", "Expected exactly one explicit source calendar date")
    return days.pop()


def _utc_instant(value: datetime) -> datetime:
    try:
        return value.astimezone(timezone.utc)
    except (ValueError, OverflowError) as exc:
        raise SourceError("invalid_kickoff", "Event offset exceeds the supported datetime range") from exc


def _event_representations(instant: datetime, explicit: datetime | None = None) -> dict[str, datetime]:
    """Compare source clocks against a proven instant, never assign them a zone.

    RDJ exposes both UTC clocks and Europe/Paris displays. DST is resolved from
    the UTC instant, so an ambiguous/nonexistent Paris wall clock never chooses
    an instant by itself. Publication timestamps are deliberately not involved.
    """
    try:
        paris = paris_timezone()
    except ZoneInfoNotFoundError as exc:
        raise SourceError("kickoff_timezone_data_missing", "Europe/Paris timezone data is unavailable") from exc
    try:
        values = {"UTC": _utc_instant(instant).replace(tzinfo=None),
                  EDITION_TIMEZONE: instant.astimezone(paris).replace(tzinfo=None)}
    except (ValueError, OverflowError) as exc:
        if isinstance(exc, SourceError):
            raise
        raise SourceError("invalid_kickoff", "Event timezone conversion exceeds the supported datetime range") from exc
    if explicit is not None:
        values["explicit_event_offset"] = explicit.replace(tzinfo=None)
    return values


def _event_datetime(root: Node) -> tuple[datetime, str]:
    """Use offset-aware event <time>, otherwise preserve the naive local clock."""
    event_times = find(root, lambda n: n.tag == "time" and bool(n.attrs.get("datetime")))
    if event_times:
        values = {n.attrs["datetime"] for n in event_times}
        if len(values) != 1:
            raise SourceError("kickoff_ambiguous", "Conflicting event datetimes")
        raw = values.pop()
        try:
            if "T" not in raw:
                raise ValueError("event datetime has no explicit time")
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError as exc:
            raise SourceError("invalid_kickoff", "Malformed event datetime") from exc
        displayed_dates = dates_in(root.plain())
        displayed_clocks = {(int(h), int(m)) for h, m in re.findall(r"(?<!\d)(\d{1,2})\s*[:h]\s*(\d{2})(?!\d)", root.plain(), re.I)}
        representations = ([parsed.replace(tzinfo=None)] if parsed.utcoffset() is None
                           else list(_event_representations(parsed, parsed).values()))
        # Dates and clocks must belong to the SAME representation. Checking
        # them independently would allow a made-up day/time around midnight.
        if (len(displayed_dates) > 1 or len(displayed_clocks) > 1 or not any(
                (not displayed_dates or displayed_dates == {value.date()})
                and (not displayed_clocks or displayed_clocks == {(value.hour, value.minute)})
                for value in representations)):
            raise SourceError("kickoff_display_mismatch", "Event datetime attribute conflicts with its displayed date or clock")
        return parsed, raw
    raw = root.plain()
    day = only_date(raw)
    clocks = set(re.findall(r"(?<!\d)(\d{1,2})\s*[:h]\s*(\d{2})(?!\d)", raw, re.I))
    if len(clocks) != 1:
        raise SourceError("kickoff_ambiguous", "Expected one explicit event clock")
    hour, minute = map(int, clocks.pop())
    try:
        return datetime.combine(day, datetime.min.time()).replace(hour=hour, minute=minute), raw
    except ValueError as exc:
        raise SourceError("invalid_kickoff", "Invalid event clock") from exc


def _discover(edition: date, fetcher, records: list, max_index_pages: int) -> str | None:
    url, visited = INDEX_URL, set()
    for _ in range(max_index_pages):
        if url in visited:
            break
        visited.add(url)
        page = _fetch(fetcher, url, records)
        root = Document(page.html).root
        candidates = set()
        journal_links = find(root, lambda n: n.tag == "a" and bool(re.search(r"/paris-sportifs/le-petit-journal/\d+[^?#]*\.html", n.attrs.get("href") or "")))
        if not journal_links and "petit journal" not in folded(root.plain()):
            raise SourceError("index_unrecognized", "Journal index markers missing")
        for link in journal_links:
            target = rdj_url(link.attrs["href"], page.url)
            url_days = dates_in(urlsplit(target).path, weekday_check=False)
            label_days = dates_in(link.plain(), weekday_check=False)
            if edition not in url_days | label_days:
                continue
            dates_in(urlsplit(target).path)
            dates_in(link.plain())
            if url_days and label_days and url_days != label_days:
                raise SourceError("index_date_mismatch", "Journal index label and URL disagree")
            candidates.add(target)
        if len(candidates) > 1:
            raise SourceError("edition_ambiguous", "Multiple different journal URLs match the edition")
        if candidates:
            return candidates.pop()
        next_links = find(root, lambda n: n.tag == "a" and "next" in (n.attrs.get("rel") or "").split())
        next_urls = {rdj_url(n.attrs["href"], page.url) for n in next_links if n.attrs.get("href")}
        next_urls = {n for n in next_urls if urlsplit(n).path == urlsplit(INDEX_URL).path}
        if len(next_urls) != 1:
            break
        url = next_urls.pop()
    return None


def _journal_cards(page: FetchedPage, edition: date) -> list[Node]:
    root = Document(page.html).root
    heading = one(find(root, lambda n: n.tag == "h1" and "petit journal" in folded(n.plain())), "journal h1")
    if only_date(heading.plain()) != edition or only_date(urlsplit(page.url).path) != edition:
        raise SourceError("edition_stale", "Journal heading or final URL does not match requested edition")
    body = one(find(root, lambda n: n.attrs.get("id") == "articleMainContent"), "articleMainContent")
    banner = re.search(r"petit journal du parieur\s+(\d{1,2}/\d{1,2}/\d{4})", folded(body.plain()[:300]))
    if banner and only_date(banner[1]) != edition:
        raise SourceError("edition_banner_mismatch", "Journal banner disagrees with its edition heading")
    scope = one(find(body, lambda n: n.tag == "section" and n.attrs.get("id") == "tab-pronostics"), "tab-pronostics")
    articles = find(scope, lambda n: n.tag == "article")
    cards = []
    for article in articles:
        links = find(article, lambda n: n.tag == "a")
        editorial_marker = ("notre prono" in folded(article.plain()) or bool(find(
            article, lambda n: folded(n.attrs.get("aria-label") or "") == "match")) or any(
            "/pronostic/" in (link.attrs.get("href") or "") or "analyse complete" in folded(link.plain()) for link in links))
        # RDJ intersperses fully sponsored promotional <article> blocks. Only
        # this positive ad proof may exclude an article from the card count.
        if not editorial_marker and links and all("sponsored" in (link.attrs.get("rel") or "").split() for link in links):
            continue
        cards.append(article)
    if not cards:
        raise SourceError("journal_no_selections", "No supported prediction cards in the journal")
    if len(cards) > 20:
        raise SourceError("journal_card_limit", "Unexpectedly many journal cards")
    if any(find(card, lambda n: n is not card and n.tag == "article") for card in cards):
        raise SourceError("journal_card_structure", "Nested journal articles cannot be counted unambiguously")
    if any("notre prono" not in folded(card.plain()) and not find(
            card, lambda n: n.tag == "a" and "analyse complete" in folded(n.plain())) for card in cards):
        raise SourceError("journal_card_unrecognized", "An editorial article has no supported prediction markers")
    return cards


def _card_market(card: Node) -> tuple[str, Decimal]:
    odds_nodes = find(card, lambda n: n.tag in {"div", "span", "p"} and bool(re.fullmatch(r"@\s*\d+[,.]\d+", n.plain()))
                      and not any(isinstance(c, Node) and re.fullmatch(r"@\s*\d+[,.]\d+", c.plain()) for c in n.children))
    odds_node = one(odds_nodes, "journal card odds")
    siblings = [n for n in odds_node.parent.children if isinstance(n, Node)]
    index = next(i for i, n in enumerate(siblings) if n is odds_node)
    if index != 1 or len(siblings) != 2 or not siblings[0].plain():
        raise SourceError("market_pair_ambiguous", "Cannot bind card market to its quoted price")
    try:
        odds = Decimal(odds_node.plain().lstrip("@ ").replace(",", "."))
    except InvalidOperation as exc:
        raise SourceError("invalid_odds", "Invalid decimal odds") from exc
    if not odds.is_finite() or odds <= 1:
        raise SourceError("invalid_odds", "Decimal odds must be finite and greater than one")
    return siblings[0].plain(), odds


def _analysis(root: Node) -> tuple[str, list[str]]:
    headings = find(root, lambda n: n.tag in {"h2", "h3"} and re.fullmatch(r"l'?\s*etat de forme(?:\s+.*)?", folded(n.plain())))
    heading = one(headings, "state of form analysis heading")
    siblings = heading.parent.children
    start = next(i for i, node in enumerate(siblings) if node is heading)
    paragraphs, pending = [], []

    def flush():
        paragraph = text(" ".join(pending))
        if paragraph:
            paragraphs.append(paragraph)
        pending.clear()

    def inline_content(node):
        if isinstance(node, str):
            return node
        if node.tag in {"script", "style", "noscript", "img"} or (node.tag == "a" and "sponsored" in (node.attrs.get("rel") or "").split()):
            return ""
        if node.tag not in {"p", "a", "span", "strong", "b", "i", "em", "u", "sup", "sub", "br"}:
            raise SourceError("analysis_structure_unknown", "Unexpected block inside editorial paragraph")
        return " ".join(inline_content(child) for child in node.children)

    for node in siblings[start + 1:]:
        if isinstance(node, str):
            pending.append(node)
            continue
        if re.fullmatch(r"h[1-6]", node.tag):
            break
        if node.tag in {"script", "style", "noscript"} or node.attrs.get("id") == "blocBleu":
            flush()
            continue
        if node.tag == "p":
            flush()
            paragraph = text(inline_content(node))
            if paragraph:
                paragraphs.append(paragraph)
        elif node.tag == "br":
            flush()
        elif node.tag in {"a", "span", "strong", "b", "i", "em", "u", "sup", "sub"}:
            pending.append(inline_content(node))
        else:
            raise SourceError("analysis_structure_unknown", "Unknown block in editorial form section")
    flush()
    if not paragraphs:
        raise SourceError("analysis_missing", "No paragraphs beneath the supported form heading")
    return "\n\n".join(paragraphs), paragraphs


def _logo_ids(root: Node) -> list[str]:
    identities = []
    for image in find(root, lambda n: n.tag == "img"):
        value = image.attrs.get("data-src") or image.attrs.get("src") or ""
        parts = urlsplit(value)
        match = re.fullmatch(r"/img/(\d+)-[^/]+\.(?:png|jpe?g|webp)", parts.path, re.I)
        if match and parts.hostname == "img.ruedesjoueurs.com" and match[1] not in identities:
            identities.append(match[1])
    return identities


def _expert_headline(root: Node) -> dict:
    """Read the explicit expert 1N2 headline; absence is not a source failure."""
    headings = find(root, lambda n: n.tag == "h2" and folded(n.plain()) == "pronostic de nos experts"
                    and n.parent is not None and n.parent.has_class("table") and n.parent.has_class("bloc"))
    if len(headings) != 1:
        return {"reason": "expert_headline_missing_or_ambiguous"}
    block = headings[0].parent
    paragraphs = find(block, lambda n: n.tag == "p" and n.parent is block and n.has_class("grey") and n.has_class("line-height-1"))
    boxes = find(block, lambda n: n.has_class("box1n2"))
    active = [node for node in boxes if node.has_class("active")]
    if len(paragraphs) != 1 or len(boxes) != 3 or {node.plain() for node in boxes} != {"1", "N", "2"} or len(active) != 1:
        return {"reason": "expert_headline_missing_or_ambiguous"}
    return {"text": paragraphs[0].plain(), "outcome_1n2": active[0].plain()}


def _short_teaser(home: str, away: str, pick: str, expert: dict, source_url: str) -> tuple[str, dict]:
    """Keep a whole authentic matching-win headline, otherwise exact team names.

    A 1N2 headline is never substituted for a scorer, handicap or double-chance
    journal pick. Long team names remain intact rather than inventing shorthand.
    """
    label = home + " — " + away
    proof = {"method": "teams_label", "reason": expert.get("reason", "journal_market_not_plain_1n2"),
        "source_url": source_url, "selector": "div.table.bloc > h2 = Pronostic de nos experts; p.grey.line-height-1; .box1n2.active",
        "source_excerpt_fr": expert.get("text"), "outcome_1n2": expert.get("outcome_1n2")}
    winner, expected = None, None
    for team, outcome in ((home, "1"), (away, "2")):
        if folded(text(pick)) == folded("Victoire " + team):
            winner, expected = team, outcome
            break
    candidate = expert.get("text")
    if winner is None:
        proof["reason"] = "journal_market_not_plain_1n2"
    elif not candidate:
        pass
    elif expert.get("outcome_1n2") != expected:
        proof["reason"] = "expert_market_differs_from_journal"
    elif len(candidate) > MAX_TEASER_CHARS:
        proof["reason"] = "editorial_headline_too_long"
    elif not re.search(r"(?<!\w)" + re.escape(folded(winner)) + r"(?!\w)", folded(candidate)):
        proof["reason"] = "editorial_participant_not_explicit"
    else:
        label = candidate
        proof.update(method="rdj_expert_1n2_headline", reason="same_participant_and_plain_1n2_market")
    proof["characters"] = len(label)
    return label, proof


def _detail(page: FetchedPage) -> dict:
    root = Document(page.html).root
    match = one(find(root, lambda n: n.has_class("fichematch")), "fichematch")
    teams = find(match, lambda n: n.has_class("equipe"))
    if len(teams) != 2:
        raise SourceError("teams_ambiguous", "Expected two participant blocks")
    names = [one(find(team, lambda n: n.tag == "strong"), "participant name").plain() for team in teams]
    if not all(names) or names[0] == names[1]:
        raise SourceError("teams_ambiguous", "Missing or identical participant names")
    participant_logos = [one_id[0] if len(one_id) == 1 else None for one_id in (_logo_ids(team) for team in teams)]
    if not all(participant_logos):
        raise SourceError("participant_logos_missing", "Cannot identify both participant logos in the prediction page")
    competition = one(find(root, lambda n: n.tag == "h2" and n.has_class("header")), "competition header").plain()
    breadcrumb = find(root, lambda n: n.has_class("breadcrumb") or n.has_class("uk-breadcrumb") or n.attrs.get("aria-label", "").lower() in {"breadcrumb", "fil d'ariane"})
    sport_values = {SPORTS[folded(n.plain())] for scope in breadcrumb for n in scope.walk() if n.tag in {"a", "span", "li"} and folded(n.plain()) in SPORTS}
    if len(sport_values) != 1:
        raise SourceError("sport_ambiguous", "Sport is not explicitly identified in the prediction breadcrumb")
    kickoff_node = one(find(match, lambda n: n.tag == "p" and n.has_class("m_title")), "event local datetime")
    kickoff, kickoff_raw = _event_datetime(kickoff_node)
    headline = one(find(root, lambda n: n.tag == "h1"), "prediction h1").plain()
    event_dates = ({kickoff.date()} if kickoff.utcoffset() is None else
                   {value.date() for value in _event_representations(kickoff, kickoff).values()})
    if only_date(headline) not in event_dates:
        raise SourceError("prediction_date_mismatch", "Prediction headline and event date disagree")
    analysis, paragraphs = _analysis(root)
    images = find(root, lambda n: n.tag == "meta" and n.attrs.get("property") == "og:image")
    image_url = one(images, "prediction artwork").attrs.get("content", "")
    image_parts = urlsplit(urljoin(page.url, image_url))
    if image_parts.scheme != "https" or image_parts.hostname not in RDJ_HOSTS | {"img.ruedesjoueurs.com"}:
        raise SourceError("artwork_missing", "No supported RDJ artwork URL")
    # All explicit priced prose pairs are evidence only, never replacement picks.
    alternatives = []
    for paragraph in find(root, lambda n: n.tag == "p"):
        raw = paragraph.plain()
        for item in re.finditer(r'["«]([^"»]+)["»]\s*\(cote\s+[aà]\s+(\d+[,.]\d+)', raw, re.I):
            alternatives.append({"pick_fr": item[1], "odds": item[2].replace(",", "."), "excerpt_fr": item[0], "source_url": page.url})
    sport = sport_values.pop()
    gender = None
    if sport == "volleyball":
        gender_text = folded(" ".join((competition, headline, analysis)))
        men = bool(re.search(r"\b(?:men|hommes|masculin(?:s|e|es)?)\b", gender_text))
        women = bool(re.search(r"\b(?:women|femmes|feminin(?:s|e|es)?)\b", gender_text))
        # Country flags and a generic competition name cannot distinguish the
        # men's and women's teams. Never infer gender from a lone date match.
        if men != women:
            gender = "men" if men else "women"
    return {"home": names[0], "away": names[1], "sport": sport, "competition": competition, "gender": gender,
            "headline_fr": headline, "analysis_fr": analysis, "image_url": urlunsplit(image_parts),
            "kickoff": kickoff, "kickoff_raw": kickoff_raw, "analysis_paragraphs": paragraphs,
            "participant_logos": participant_logos, "detail_priced_markets": alternatives,
            "expert_headline": _expert_headline(root)}


def _prediction_id(url: str) -> str | None:
    match = re.fullmatch(r"/pronostic/(?!statistiques/)[^/?#]+-(\d+)\.html", urlsplit(url).path)
    return match[1] if match else None


def _matching_prediction_links(page: FetchedPage, logos: list[str]) -> dict[str, str]:
    """Discover only links visibly bound to the card's ordered participant logos.

    A navigation ancestor containing many games is never a participant proof.
    URL slugs and article IDs are read from RDJ, never constructed from names.
    """
    candidates = {}
    for link in find(Document(page.html).root, lambda n: n.tag == "a" and bool(n.attrs.get("href"))):
        try:
            url = rdj_url(link.attrs["href"], page.url)
        except SourceError:
            continue
        identity = _prediction_id(url)
        if identity is None:
            continue
        scope = link
        for _ in range(3):
            identities = _logo_ids(scope)
            if identities:
                if identities == logos:
                    candidates.setdefault(identity, url)
                break
            scope = scope.parent
            if scope is None:
                break
    return candidates


def _card_detail(page: FetchedPage, target: str, logos: list[str], competition: str,
                 card_time: datetime, edition: date, journal_url: str, resolver,
                 expected_sport: str | None = None) -> tuple[dict, str, dict]:
    if _prediction_id(page.url) != _prediction_id(target):
        raise SourceError("prediction_redirect_mismatch", "Linked prediction redirected to another event")
    detail = _detail(page)
    if len(logos) != 2 or logos != detail["participant_logos"]:
        raise SourceError("participant_mismatch", "Journal and prediction participant logos do not agree in home/away order")
    if folded(detail["competition"]) != folded(competition):
        raise SourceError("competition_conflict", "Journal and detailed prediction name different competitions")
    if expected_sport is not None and detail["sport"] != expected_sport:
        raise SourceError("sport_conflict", "Replacement prediction belongs to another sport")
    fixture = {"id": _prediction_id(target), "source_url": page.url, "journal_source_url": journal_url,
               "kickoff_local": {"journal": card_time.isoformat(), "detail": detail["kickoff"].isoformat(), "timezone": None},
               **{key: detail[key] for key in ("home", "away", "sport", "competition")}}
    if "gender" in detail:
        fixture["gender"] = detail["gender"]
    kickoff, proof = _utc(fixture, card_time, detail["kickoff"], edition, resolver)
    return detail, kickoff, proof


def _resolve_card_detail(target: str, journal: FetchedPage, logos: list[str], competition: str,
                         card_time: datetime, edition: date, resolver, fetcher, records: list):
    """Repair a bad publisher link only with one fully verified RDJ event.

    Search already-read pages first, then at most one explicitly named league
    index. At most eight logo-bound candidate event IDs may be inspected. Any
    unavailable candidate makes uniqueness unproven; no partial result escapes.
    """
    page = None
    expected_sport = None
    try:
        page = _fetch(fetcher, target, records)
        detail, kickoff, proof = _card_detail(page, target, logos, competition, card_time, edition, journal.url, resolver)
        return page, detail, kickoff, proof, None
    except SourceError as original:
        # A missing/ambiguous card identity cannot be repaired by discovery.
        if len(logos) != 2:
            raise original
        if page is not None:
            try:
                parsed = _detail(page)
                expected_sport = parsed["sport"]
                original.detail_clock = parsed["kickoff"].isoformat()
            except SourceError:
                pass
        pages = [journal] + ([page] if page is not None else [])
        candidates = {}
        for document in pages:
            candidates.update(_matching_prediction_links(document, logos))
        candidates.pop(_prediction_id(target), None)
        if not candidates:
            indexes = set()
            for document in pages:
                for link in find(Document(document.html).root, lambda n: n.tag == "a" and bool(n.attrs.get("href"))):
                    label = folded(link.plain())
                    if label not in {folded(competition), "tous les matchs de la " + folded(competition)}:
                        continue
                    try:
                        url = rdj_url(link.attrs["href"], document.url)
                    except SourceError:
                        continue
                    if re.fullmatch(r"/pronostics/[^/?#]+\.html", urlsplit(url).path) and not urlsplit(url).query:
                        indexes.add(url)
            if len(indexes) == 1:
                try:
                    index = _fetch(fetcher, indexes.pop(), records)
                except SourceError:
                    raise original
                candidates.update(_matching_prediction_links(index, logos))
                candidates.pop(_prediction_id(target), None)
        if not candidates:
            raise original
        if len(candidates) > 8:
            raise SourceError("prediction_resolution_limit", "Too many logo-bound replacement events")
        accepted, rejected = [], []
        for identity, candidate in sorted(candidates.items()):
            try:
                candidate_page = _fetch(fetcher, candidate, records)
            except SourceError as exc:
                raise SourceError("prediction_resolution_incomplete", "Cannot verify every logo-bound replacement event") from exc
            try:
                candidate_detail, kickoff, proof = _card_detail(candidate_page, candidate, logos, competition,
                    card_time, edition, journal.url, resolver, expected_sport)
            except SourceError as exc:
                rejected.append({"source_url": candidate, "code": exc.code})
                continue
            accepted.append((candidate_page, candidate_detail, kickoff, proof))
        if len(accepted) > 1:
            raise SourceError("prediction_resolution_ambiguous", "Several replacement events match the card facts")
        if not accepted:
            raise original
        return (*accepted[0], {"method": "rdj_unique_participant_event", "original_source_url": target,
            "original_error": original.code, "resolved_source_url": accepted[0][0].url,
            "participant_logo_ids": logos, "candidate_count": len(candidates), "rejected_candidates": rejected})


def _provider_proof(resolved: dict, parts, fixture: dict, edition: date) -> bool:
    """ESPN is a bounded provider proof, never an official league schedule."""
    match = re.fullmatch(r"/apis/site/v2/sports/(soccer/(fra\.[12]|eng\.1|esp\.1|ita\.1|ger\.1)|tennis/(atp|wta)|basketball/(nba))/scoreboard", parts.path)
    if parts.hostname != "site.api.espn.com" or not match:
        return False
    query = parse_qs(parts.query, keep_blank_values=True)
    if set(query) != {"dates"} or len(query["dates"]) != 1 or not re.fullmatch(r"\d{8}", query["dates"][0]):
        return False
    try:
        requested_day = datetime.strptime(query["dates"][0], "%Y%m%d").date()
    except ValueError:
        return False
    if abs((requested_day - edition).days) > 1:
        return False
    if (resolved.get("provider") != "ESPN" or resolved.get("time_valid") is not True or resolved.get("status") != "pre"
            or resolved.get("matched_participants") != [fixture.get("home"), fixture.get("away")]):
        return False
    if match[2]:
        return (fixture.get("sport") == "football" and resolved.get("orientation") == "home_away"
                and resolved.get("league_id") == match[2])
    if match[4]:
        return (fixture.get("sport") == "basketball" and folded(fixture.get("competition", "")) in {"nba", "national basketball association"}
                and resolved.get("orientation") == "home_away" and resolved.get("league_id") == "nba")
    return (fixture.get("sport") == "tennis" and resolved.get("orientation") in {"same_order", "reversed"}
            and isinstance(resolved.get("tournament_id"), str) and bool(resolved["tournament_id"].strip())
            and isinstance(resolved.get("tournament_name"), str) and bool(resolved["tournament_name"].strip()))


def _utc(fixture: dict, card_time: datetime, detail_time: datetime, edition: date, resolver) -> tuple[str, dict]:
    card_aware, detail_aware = card_time.utcoffset() is not None, detail_time.utcoffset() is not None
    if card_aware and detail_aware:
        if _utc_instant(card_time) != _utc_instant(detail_time):
            raise SourceError("kickoff_conflict", "Explicit journal and prediction event times disagree")
        instant = _utc_instant(card_time)
        return instant.isoformat(), {"method": "explicit_event_offset", "source_url": fixture["journal_source_url"],
                                    "source_clocks": {"journal": card_time.isoformat(), "detail": detail_time.isoformat()}}
    explicit = card_time if card_aware else detail_time if detail_aware else None
    if explicit is not None:
        instant = _utc_instant(explicit)
        evidence = {"method": "explicit_event_offset", "source_url": fixture["journal_source_url"] if card_aware else fixture["source_url"]}
        return instant.isoformat(), _reconcile_clocks(card_time, detail_time, instant, evidence, explicit)
    if resolver is None:
        if card_time != detail_time:
            raise SourceError("kickoff_conflict", "Differing naive event clocks require a verified schedule resolver")
        raise SourceError("kickoff_timezone_missing", "Naive RDJ event clocks require a verified schedule resolver")
    try:
        resolved = resolver(dict(fixture), edition.isoformat())
    except Exception as exc:
        raise SourceError("kickoff_resolution_error", "Schedule resolver failed: " + type(exc).__name__) from exc
    if not isinstance(resolved, dict) or not isinstance(resolved.get("method"), str) or resolved.get("method") not in {"official_schedule", "provider_schedule"} or not isinstance(resolved.get("source_id"), (str, int)) or isinstance(resolved.get("source_id"), bool) or not resolved.get("source_id"):
        raise SourceError("kickoff_unresolved", "Schedule resolver returned no complete proof")
    try:
        if not isinstance(resolved.get("source_url"), str):
            raise ValueError("source URL must be a string")
        parts = urlsplit(resolved["source_url"])
        valid_proof = parts.scheme == "https" and parts.hostname and not parts.username and not parts.password and not parts.fragment and parts.port in {None, 443}
        if valid_proof and resolved["method"] == "official_schedule":
            valid_proof = any(parts.hostname == h or parts.hostname.endswith("." + h) for h in ("uefa.com", "nba.com", "nba.net"))
            if parts.hostname == "en.volleyballworld.com":
                match = re.fullmatch(r"/api/v1/globalschedule/(\d{4}-\d{2}-\d{2})/\1", parts.path)
                valid_proof = (bool(match) and not parts.query and fixture.get("sport") == "volleyball"
                    and resolved.get("provider") == "VolleyballWorld" and resolved.get("status") == "upcoming"
                    and resolved.get("time_valid") is True and resolved.get("orientation") == "home_away"
                    and resolved.get("matched_participants") == [fixture.get("home"), fixture.get("away")]
                    and resolved.get("competition") == fixture.get("competition")
                    and fixture.get("gender") in {"men", "women"} and resolved.get("gender") == fixture.get("gender")
                    and isinstance(resolved.get("tournament_id"), str) and bool(resolved["tournament_id"])
                    and abs((date.fromisoformat(match[1]) - edition).days) <= 1)
        elif valid_proof:
            valid_proof = _provider_proof(resolved, parts, fixture, edition)
    except (ValueError, TypeError) as exc:
        raise SourceError("kickoff_untrusted_proof", "Invalid verified schedule source URL") from exc
    if not valid_proof:
        raise SourceError("kickoff_untrusted_proof", "Kickoff proof is not an approved official schedule or bounded ESPN provider proof")
    try:
        instant = datetime.fromisoformat(resolved["kickoff_utc"].replace("Z", "+00:00"))
    except (ValueError, KeyError, AttributeError, TypeError) as exc:
        raise SourceError("kickoff_unresolved", "Resolver did not return an explicit datetime") from exc
    if instant.tzinfo is None or instant.utcoffset() != timedelta(0):
        raise SourceError("kickoff_unresolved", "Resolver kickoff_utc must be explicitly UTC")
    if any(abs((instant.date() - value.date()).days) > 1 for value in (card_time, detail_time)):
        raise SourceError("kickoff_date_mismatch", "Verified schedule date is too far from the card event date")
    return instant.isoformat(), _reconcile_clocks(card_time, detail_time, instant, dict(resolved))


def _reconcile_clocks(card_time: datetime, detail_time: datetime, instant: datetime,
                      evidence: dict, explicit: datetime | None = None) -> dict:
    representations = _event_representations(instant, explicit)
    clocks = {}
    for label, value in (("journal", card_time), ("detail", detail_time)):
        if value.utcoffset() is not None:
            matches = ["explicit_event_offset"] if _utc_instant(value) == instant else []
        else:
            matches = [zone for zone, candidate in representations.items() if value == candidate]
        if not matches:
            raise SourceError("kickoff_conflict", "Source " + label + " clock conflicts with the proven event instant")
        clocks[label] = {"raw": value.isoformat(), "matching_representations": matches}
    return {**evidence, "source_clock_reconciliation": clocks}


def collect_edition(edition: str, fetcher=None, *, kickoff_resolver=None, now: datetime | None = None,
                    max_index_pages: int = 3) -> dict:
    """Return ready/source_absent/source_incomplete; non-ready has fixtures=[].

    fetcher(url) may return FetchedPage or HTML. kickoff_resolver(fixture, edition)
    returns {kickoff_utc, source_url, source_id, method:'official_schedule'} or None.
    ESPN proof uses method:'provider_schedule' and explicit match-certainty,
    participant, orientation and league/tournament evidence; it is not official.
    The callback receives source-local clocks without an assumed timezone.
    """
    day = date.fromisoformat(edition)
    if day.isoformat() != edition:
        raise ValueError("edition must be an explicit YYYY-MM-DD")
    if not 1 <= max_index_pages <= 10:
        raise ValueError("max_index_pages must be between 1 and 10")
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    records = []
    result = {"status": "source_incomplete", "edition": edition, "timezone": EDITION_TIMEZONE,
              "source_url": None, "fixtures": [], "issues": [], "provenance": {
                  "index_url": INDEX_URL, "collected_at_utc": current.astimezone(timezone.utc).isoformat(),
                  "pages": records, "selection_policy": "Only this dated journal's editorial prediction cards; no fallback matches",
                  "market_policy": "Journal card pick and odds stay paired; detailed-page alternatives are evidence only",
                  "event_clock_policy": "No timezone inferred from RDJ publication metadata or HTTP headers"}}
    fetcher = fetcher or fetch_page
    try:
        journal_url = _discover(day, fetcher, records, max_index_pages)
        if journal_url is None:
            result.update(status="source_absent", issues=[{"code": "edition_not_indexed", "detail": "Requested edition absent from the bounded index pages"}])
            return result
        result["source_url"] = journal_url
        journal = _fetch(fetcher, journal_url, records)
        cards = _journal_cards(journal, day)
        fixtures, seen = [], set()
        result["provenance"]["expected_card_count"] = len(cards)
        for index, card in enumerate(cards):
            source_clocks = {}
            try:
                links = find(card, lambda n: n.tag == "a" and "analyse complete" in folded(n.plain()))
                target = rdj_url(one(links, "card complete-analysis link").attrs.get("href") or "", journal.url)
                if not re.fullmatch(r"/pronostic/(?!statistiques/)[^?#]+-\d+\.html", urlsplit(target).path):
                    raise SourceError("prediction_link_invalid", "Card does not link to a supported prediction page")
                competition = one(find(card, lambda n: n.tag == "h2"), "card competition").plain()
                match_block = one(find(card, lambda n: folded(n.attrs.get("aria-label") or "") == "match"), "card event time block")
                card_time, card_raw = _event_datetime(match_block)
                source_clocks["journal"] = card_time.isoformat()
                event_dates = ({card_time.date()} if card_time.utcoffset() is None else
                               {value.date() for value in _event_representations(card_time, card_time).values()})
                if not any(0 <= (event_day - day).days <= 1 for event_day in event_dates):
                    raise SourceError("card_date_outside_edition", "Card is neither edition day nor its following night")
                pick, odds = _card_market(card)
                card_logos = _logo_ids(match_block)
                page, detail, kickoff, kickoff_proof, resolution = _resolve_card_detail(target, journal,
                    card_logos, competition, card_time, day, kickoff_resolver, fetcher, records)
                source_clocks["detail"] = detail["kickoff"].isoformat()
                if _prediction_id(page.url) in seen:
                    raise SourceError("duplicate_card", "Several journal cards resolve to the same event")
                seen.add(_prediction_id(page.url))
                summaries = [n.plain() for n in find(card, lambda n: n.tag == "p") if len(n.plain().split()) >= 15]
                if not summaries:
                    raise SourceError("card_summary_missing", "No authentic journal teaser paragraph")
                fixture = {"id": _prediction_id(page.url),
                    **{key: detail[key] for key in ("home", "away", "sport", "competition", "headline_fr", "analysis_fr", "image_url", "gender")},
                    "pick_fr": pick, "odds": float(odds), "source_url": page.url, "journal_source_url": journal.url,
                    "card_summary_fr": "\n\n".join(summaries),
                    "kickoff_local": {"journal": card_time.isoformat(), "detail": detail["kickoff"].isoformat(), "timezone": None},
                    "provenance": {"card_index": index, "card_scope": "#articleMainContent #tab-pronostics article",
                        "market_source_url": journal.url, "market_excerpt_fr": pick + " @" + str(odds),
                        "odds_decimal": str(odds), "kickoff_journal_raw": card_raw, "kickoff_detail_raw": detail["kickoff_raw"],
                        "analysis_section": "L’état de forme", "analysis_paragraphs_fr": detail["analysis_paragraphs"],
                        "analysis_sha256_utf8": hashlib.sha256(detail["analysis_fr"].encode()).hexdigest(),
                        "card_price_differs_from_detail": any(folded(m["pick_fr"]) == folded(pick) and Decimal(m["odds"]) != odds for m in detail["detail_priced_markets"]),
                        "participant_logo_ids": card_logos,
                        "detail_priced_markets": detail["detail_priced_markets"]}}
                fixture["teaser_fr"], fixture["provenance"]["teaser"] = _short_teaser(detail["home"], detail["away"], pick, detail["expert_headline"], page.url)
                fixture["kickoff_utc"], fixture["provenance"]["kickoff_resolution"] = kickoff, kickoff_proof
                if resolution is not None:
                    fixture["provenance"]["prediction_link_resolution"] = resolution
                fixtures.append(fixture)
            except (SourceError, OSError) as exc:
                if getattr(exc, "detail_clock", None):
                    source_clocks["detail"] = exc.detail_clock
                result["issues"].append({"code": getattr(exc, "code", "source_unavailable"), "card_index": index,
                                         "detail": str(exc), "source_clocks": source_clocks})
        result["provenance"]["parsed_card_count"] = len(fixtures)
        if result["issues"]:
            return result
        result.update(status="ready", fixtures=fixtures)
        return result
    except (SourceError, OSError) as exc:
        code = getattr(exc, "code", "source_unavailable")
        result["status"] = "source_absent" if code in {"http_404", "http_410"} else "source_incomplete"
        result["issues"].append({"code": code, "detail": str(exc)})
        return result


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--edition", required=True, help="Explicit edition calendar date, YYYY-MM-DD (Europe/Paris)")
    args = parser.parse_args()
    print(json.dumps(collect_edition(args.edition), ensure_ascii=False, indent=2))
