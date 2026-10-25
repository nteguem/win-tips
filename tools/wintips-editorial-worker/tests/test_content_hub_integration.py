"""Opt-in shared HTTP integration, with no network/provider/publication calls."""
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from editorial_worker import content_hub
from editorial_worker.http import FetchError, PublicFetcher


class Shared:
    def __init__(self): self.values = {}
    def fetch(self, url, builder):
        if url not in self.values: self.values[url] = builder()
        return self.values[url]


class Response:
    url = 'https://www.ruedesjoueurs.com/article.html'
    status = 200
    headers = None
    def __init__(self): self.headers = self
    def get_content_type(self): return 'text/html'
    def get_content_charset(self): return 'utf-8'
    def read(self, _limit): return b'<p>Source exact</p>'
    def __enter__(self): return self
    def __exit__(self, *_args): pass


class HubIntegrationTests(unittest.TestCase):
    def test_disabled_feature_does_not_load_external_code(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(content_hub.module())
            self.assertIsNone(content_hub.open_hub())

    def test_configured_hub_requires_a_verified_absolute_code_root(self):
        with TemporaryDirectory() as directory:
            for code in ['', 'relative/code', str(Path(directory) / 'missing')]:
                with self.subTest(code=code), patch.dict(os.environ, {'RDJ_CONTENT_HUB_DIR': directory, 'RDJ_HUB_CODE_ROOT': code}):
                    with self.assertRaises(ValueError): content_hub.module()

    def test_two_fetchers_share_one_physical_get_and_preserve_evidence(self):
        with TemporaryDirectory() as directory, patch.object(content_hub, 'open_hub', return_value=Shared()):
            first = PublicFetcher(Path(directory) / 'a')
            second = PublicFetcher(Path(directory) / 'b')
            with (patch.object(first.opener, 'open', return_value=Response()) as physical,
                    patch.object(second.opener, 'open', side_effect=AssertionError('No second HTTP request'))):
                a = first.html(Response.url)
                b = second.html(Response.url)
            self.assertEqual((a.url, a.html, a.status), (b.url, b.html, b.status))
            self.assertEqual(physical.call_count, 1)
            self.assertEqual((first.requests, second.requests), (1, 0))
            self.assertEqual(first.records, second.records)
            self.assertFalse(list((Path(directory) / 'a').glob('*.json')))

    def test_refused_physical_budget_is_still_structured(self):
        with TemporaryDirectory() as directory, patch.object(content_hub, 'open_hub', return_value=Shared()):
            reader = PublicFetcher(directory, max_requests=0)
            with patch.object(reader.opener, 'open', side_effect=AssertionError('Budget must precede HTTP')):
                with self.assertRaises(FetchError): reader.html(Response.url)
            self.assertEqual(reader.budget_refusals[0]['code'], 'public_request_budget_exceeded')


if __name__ == '__main__': unittest.main()
