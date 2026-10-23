"""Manual public fixture refresh. Never invoked by the offline test suite.

Saves reduced source DOM fragments and hashes of the full public response.
No advertising scripts, credentials, models or full news article dumps.
"""
from datetime import datetime, timezone
from html import escape
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from editorial_worker.http import PublicFetcher
from editorial_worker.sources import jsonld
from editorial_worker.vendor import rdj_collector as rdj

BASE = "https://www.ruedesjoueurs.com"
URLS = {
    "turf-2026-10-23": BASE + "/turf/pronostic-turf/course/23-10-2026/R1/C4/prix-orionis.html",
    "football-2026-10-22": BASE + "/pronostic/lech-poznan-sunderland-6112320.html",
    "football-lille-2026-10-21": BASE + "/pronostic/lille-galatasaray-6106312.html",
    "football-como-2026-10-21": BASE + "/pronostic/como-manchester-united-6106410.html",
    "football-dinamo-2026-10-22": BASE + "/pronostic/dinamo-zagreb-nec-nimegue-6112293.html",
    "combine-2026-10-21": BASE + "/actualites/paris-sportifs/74744-combine-21-10-2026.html",
    "petit-index": BASE + "/paris-sportifs/le-petit-journal.html",
    "petit-journal-2026-10-22": BASE + "/paris-sportifs/le-petit-journal/74762-le-petit-journal-du-parieur-jeudi-22-octobre-2026.html",
}


def html(node):
    if isinstance(node, str):
        return escape(node, quote=False)
    attrs = "".join(" " + key + ("" if value is None else '="' + escape(value, quote=True) + '"') for key, value in node.attrs.items())
    opening = "<" + node.tag + attrs + ">"
    if node.tag in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
        return opening
    content = "".join(html(c) for c in node.children)
    return opening + content + "</" + node.tag + ">"


def reduced(key, raw):
    root = rdj.Document(raw).root
    if key == "petit-index":
        links = rdj.find(root, lambda n: n.tag == "a" and "/paris-sportifs/le-petit-journal/" in (n.attrs.get("href") or ""))
        return "<h1>Le Petit Journal du Parieur</h1>" + "".join(html(n) for n in links)
    if key.startswith("petit-journal"):
        return html(rdj.one(rdj.find(root, lambda n: n.tag == "h1"), "h1")) + html(rdj.one(rdj.find(root, lambda n: n.attrs.get("id") == "articleMainContent"), "journal body"))
    if key.startswith("turf"):
        nodes = [rdj.one(rdj.find(root, lambda n: n.tag == "h1"), "h1")]
        nodes += [rdj.one(rdj.find(root, lambda n: n.attrs.get("id") == key), key) for key in ("nospronos", "partants")]
        # SportsEvent is the event offset proof, separate from publication times.
        data = [row for row in jsonld(root) if row.get("@type") == "SportsEvent"]
        return "".join(html(n) for n in nodes) + '<script type="application/ld+json">' + json.dumps(data, ensure_ascii=False) + "</script>"
    if key.startswith("football"):
        detail = rdj._detail(rdj.FetchedPage(URLS[key], raw))
        nodes = []
        for pred in (lambda n: n.tag == "h1", lambda n: n.tag == "h2" and n.has_class("header"),
                     lambda n: n.tag == "meta" and n.attrs.get("property") == "og:image"):
            nodes.append(rdj.one(rdj.find(root, pred), "football fixture block"))
        match = rdj.one(rdj.find(root, lambda n: n.has_class("fichematch")), "fichematch")
        identity = rdj.find(match, lambda n: n.has_class("equipe"))
        identity.append(rdj.one(rdj.find(match, lambda n: n.tag == "p" and n.has_class("m_title")), "kickoff"))
        fixture_identity = '<div class="fichematch">' + "".join(html(n) for n in identity) + "</div>"
        expert = rdj.one(rdj.find(root, lambda n: n.tag == "h2" and rdj.folded(n.plain()) == "pronostic de nos experts"), "expert")
        nav = '<nav class="breadcrumb"><a>Football</a></nav>'
        form = '<section><h2>L’état de forme</h2>' + "".join("<p>" + escape(p) + "</p>" for p in detail["analysis_paragraphs"]) + "</section>"
        return nav + "".join(html(n) for n in nodes) + fixture_identity + html(expert.parent) + form
    article = rdj.one(rdj.find(root, lambda n: n.tag == "article" and n.has_class("news-article")), "article")
    return html(article)


def main():
    if sys.argv[1:] not in (["--capture"], ["--from-cache"]):
        raise SystemExit("Explicit --capture or --from-cache required; ordinary tests are offline")
    destination = Path(__file__).resolve().parent / "fixtures"
    destination.mkdir(exist_ok=True)
    fetcher = PublicFetcher(destination.parent / ".fixture-http-cache", ttl=0, max_requests=10)
    manifest = []
    for key, url in URLS.items():
        if sys.argv[1:] == ["--from-cache"]:
            cached = fetcher.cache_dir / (hashlib.sha256(url.encode()).hexdigest() + ".json")
            fetched = json.loads(cached.read_text("utf-8"))
        else:
            fetched = fetcher.get(url)
        if fetched["status"] != 200:
            raise ValueError("Fixture source unavailable")
        body = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>" + reduced(key, fetched["body"]) + "</body></html>"
        filename = key + ".html"
        # Git fixtures are explicitly LF on every platform. Keep the full
        # response's raw hash separate from this reduced canonical fragment.
        fixture = body.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
        (destination / filename).write_bytes(fixture)
        manifest.append({"file": filename, "sourceUrl": url, "retrievedAtUtc": datetime.fromtimestamp(fetched["saved"], timezone.utc).isoformat(),
                         "rawUtf8Sha256": fetched["sha256"], "fixtureSha256": hashlib.sha256(fixture).hexdigest(),
                         "note": "Reduced source DOM; source text retained; not a full source document."})
    (destination / "provenance.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({"fixturesCaptured": len(manifest), "fullArticlePrinted": False}))


if __name__ == "__main__":
    main()
