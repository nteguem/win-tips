"""Bounded public GETs. Never follows an unreviewed redirect or sends credentials."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener

PUBLIC_HOSTS = {"www.ruedesjoueurs.com", "ruedesjoueurs.com", "match.uefa.com",
                "site.api.espn.com", "cdn.nba.com", "en.volleyballworld.com"}


class FetchError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def public_url(value):
    try:
        u = urlsplit(value)
        if u.scheme != "https" or u.hostname not in PUBLIC_HOSTS or u.port not in (None, 443) or u.username or u.password:
            raise ValueError()
    except (ValueError, TypeError):
        raise FetchError("untrusted_public_url")
    return value


class Redirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, public_url(newurl))


class PublicFetcher:
    def __init__(self, cache_dir, *, max_requests=40, timeout=20, max_seconds=240, ttl=600):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.max_requests, self.timeout, self.max_seconds, self.ttl = max_requests, timeout, max_seconds, ttl
        self.started = time.monotonic()
        self.requests = 0
        self.memory = {}
        self.records = []
        # Separate from HTTP outcomes: adapters can legitimately catch network
        # failures and use verified fallback data, but must not hide a refused
        # global collection budget as an absent or partially complete source.
        self.budget_refusals = []
        self.opener = build_opener(Redirects())

    def _refuse_budget(self, code):
        self.budget_refusals.append({'code': code, 'requests': self.requests,
            'maxRequests': self.max_requests, 'maxSeconds': self.max_seconds,
            'elapsedSeconds': round(max(0, time.monotonic() - self.started), 3)})
        # No URL, response, credential, or exception message enters this trace.
        raise FetchError(code)

    def get(self, url):
        public_url(url)
        if url in self.memory:
            return self.memory[url]
        if time.monotonic() - self.started >= self.max_seconds:
            self._refuse_budget("public_time_budget_exceeded")
        key = hashlib.sha256(url.encode()).hexdigest()
        path = self.cache_dir / (key + ".json")
        entry = None
        if path.is_file() and not path.is_symlink():
            try:
                candidate = json.loads(path.read_text("utf-8"))
                if candidate.get("url") == url and 0 <= time.time() - candidate["saved"] < self.ttl:
                    public_url(candidate["final_url"])
                    if hashlib.sha256(candidate["body"].encode()).hexdigest() == candidate["sha256"]:
                        entry = dict(candidate, cached=True)
            except (ValueError, KeyError, TypeError, OSError):
                pass
        if entry is None:
            if self.requests >= self.max_requests:
                self._refuse_budget("public_request_budget_exceeded")
            self.requests += 1
            headers = {"User-Agent": "WinTipsEditorialWorker/0.1 (public source reader)", "Accept": "text/html,application/json"}
            if urlsplit(url).hostname == "cdn.nba.com":
                headers.update(Referer="https://www.nba.com/", Origin="https://www.nba.com",
                               **{"User-Agent": "Mozilla/5.0 (compatible; WinTipsEditorialWorker/1.0; schedule verification)"})
            req = Request(url, method="GET", headers=headers)
            try:
                with self.opener.open(req, timeout=self.timeout) as response:
                    final_url = public_url(response.url)
                    mime = response.headers.get_content_type()
                    if mime not in ("text/html", "application/xhtml+xml", "application/json"):
                        raise FetchError("unsupported_content_type")
                    blob = response.read(8_000_001)
                    if len(blob) > 8_000_000:
                        raise FetchError("public_response_too_large")
                    body = blob.decode(response.headers.get_content_charset() or "utf-8")
                    entry = {"url": url, "final_url": final_url, "status": response.status, "body": body,
                             "saved": time.time(), "sha256": hashlib.sha256(body.encode()).hexdigest()}
            except HTTPError as exc:
                entry = {"url": url, "final_url": url, "status": exc.code, "body": "", "saved": time.time(),
                         "sha256": hashlib.sha256(b"").hexdigest()}
            if entry["status"] == 200:
                temporary = path.with_suffix(".tmp")
                temporary.write_text(json.dumps(entry, ensure_ascii=False), "utf-8")
                temporary.replace(path)
        self.memory[url] = entry
        self.records.append({k: entry[k] for k in ("url", "final_url", "status", "sha256")})
        return entry

    def html(self, url):
        from .vendor.rdj_collector import FetchedPage
        p = self.get(url)
        if len(p["body"].encode()) > 3_000_000:
            raise FetchError("public_html_too_large")
        return FetchedPage(p["final_url"], p["body"], p["status"])

    def json(self, url):
        p = self.get(url)
        if p["status"] != 200:
            raise FetchError("public_json_unavailable")
        return json.loads(p["body"])
