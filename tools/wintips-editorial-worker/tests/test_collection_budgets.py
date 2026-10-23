"""A refused limit is scoped to one source; HTTP fallback remains independent."""
import json
import tempfile
import time
import unittest
from unittest.mock import patch
from editorial_worker.http import PublicFetcher, FetchError
from editorial_worker import sources as s, runner
from test_worker import page, fixture_clock, args

NOW=s.iso('2026-10-21T08:00:00Z')

def entry(url,body='',status=200):
    return {'url':url,'final_url':url,'body':body,'status':status,'sha256':'test-only-memory'}

class CollectionBudgetTests(unittest.TestCase):
    def source(self,fetcher,key='rdj_football_analysis'):
        with patch.object(s,'VerifiedKickoffs',return_value=fixture_clock):
            return s.collect(key,'2026-10-21',fetcher,now=NOW)

    def partial(self,folder):
        fetcher=PublicFetcher(folder,max_requests=0)
        first,second=page('football-lille-2026-10-21'),page('football-como-2026-10-21')
        listing=s.SOURCES['rdj_football_analysis']
        fetcher.memory[listing]=entry(listing,'<a href="'+first.url+'">Lire l’analyse</a><a href="'+second.url+'">Lire l’analyse</a>')
        fetcher.memory[first.url]=entry(first.url,first.html)
        fetcher.opener.open=lambda *a,**k:self.fail('No live network in budget tests')
        return fetcher

    def test_refused_request_budget_is_incomplete_not_absent(self):
        with tempfile.TemporaryDirectory() as out:
            fetcher=PublicFetcher(out,max_requests=0)
            result=self.source(fetcher)
            self.assertEqual(result['status'],'source_incomplete');self.assertEqual(result['items'],[])
            self.assertEqual(result['issues'][-1]['limits'][0]['code'],'public_request_budget_exceeded')
            self.assertEqual(fetcher.requests,0)

    def test_actual_partial_fixture_collection_cannot_be_published_as_ready(self):
        with tempfile.TemporaryDirectory() as out:
            raw=s.collect_football('2026-10-21',self.partial(out+'/adapter'),now=NOW,resolver=fixture_clock)
            self.assertEqual(raw['status'],'ready');self.assertEqual(len(raw['items']),1)
            result=self.source(self.partial(out))
            self.assertEqual(result['status'],'source_incomplete');self.assertEqual(result['items'],[])
            self.assertEqual(result['issues'][-1]['code'],'source_public_budget_refused')

    def test_exactly_at_limit_without_any_refusal_preserves_genuine_absence(self):
        with tempfile.TemporaryDirectory() as out:
            fetcher=PublicFetcher(out,max_requests=1);fetcher.requests=1
            url=s.SOURCES['rdj_football_analysis'];fetcher.memory[url]=entry(url,'<h1>Football</h1>')
            result=self.source(fetcher)
            self.assertEqual(result['status'],'source_absent');self.assertEqual(fetcher.budget_refusals,[])

    def test_previous_refusal_does_not_poison_next_source_fully_in_memory(self):
        with tempfile.TemporaryDirectory() as out:
            fetcher=self.partial(out);self.assertEqual(self.source(fetcher)['status'],'source_incomplete')
            for url in s.MULTISPORT_INDEXES:fetcher.memory[url]=entry(url,'<h1>Sport</h1>')
            before=len(fetcher.budget_refusals)
            result=self.source(fetcher,'rdj_multisport_analysis')
            self.assertEqual(result['status'],'source_absent');self.assertEqual(len(fetcher.budget_refusals),before)

    def test_elapsed_budget_refusal_is_scoped_but_memory_hits_remain_valid(self):
        with tempfile.TemporaryDirectory() as out:
            fetcher=PublicFetcher(out,max_seconds=1);fetcher.started=time.monotonic()-2
            self.assertEqual(self.source(fetcher)['status'],'source_incomplete')
            self.assertEqual(fetcher.budget_refusals[-1]['code'],'public_time_budget_exceeded')
            url=s.SOURCES['rdj_football_analysis'];fetcher.memory[url]=entry(url,'<h1>No current fixture</h1>')
            self.assertEqual(self.source(fetcher)['status'],'source_absent')

    def test_ordinary_http_failure_with_verified_fallback_is_not_a_budget_refusal(self):
        with tempfile.TemporaryDirectory() as out:
            fetcher=PublicFetcher(out,max_requests=0)
            first='https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json'
            fallback='https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261021'
            fetcher.memory[first]=entry(first,status=403);fetcher.memory[fallback]=entry(fallback,json.dumps({'testOnlyVerifiedFallback':True}))
            def adapter(*a,**kw):
                try:fetcher.json(first)
                except FetchError:self.assertTrue(fetcher.json(fallback)['testOnlyVerifiedFallback'])
                return {'status':'ready','items':[{'testOnly':True}],'issues':[]}
            with patch.object(s,'collect_multisport',side_effect=adapter):
                result=self.source(fetcher,'rdj_multisport_analysis')
            self.assertEqual(result['status'],'ready');self.assertEqual(len(result['items']),1);self.assertEqual(fetcher.budget_refusals,[])

    def test_refusal_trace_never_contains_url_query_or_exception_data(self):
        with tempfile.TemporaryDirectory() as out:
            fetcher=PublicFetcher(out,max_requests=0)
            with self.assertRaises(FetchError):fetcher.get('https://www.ruedesjoueurs.com/test.html?private=TEST_ONLY_SECRET')
            encoded=json.dumps(fetcher.budget_refusals)
            self.assertNotIn('TEST_ONLY_SECRET',encoded);self.assertNotIn('https',encoded)

    def test_partial_source_reaches_neither_translator_nor_import(self):
        class Api:
            def __init__(self):self.calls=[]
            def request(self,route,payload=None):
                self.calls.append(route);selftest.assertIsNone(payload)
                return {'date':'2026-10-21','importEnabled':True,'notificationsEnabled':False,'sources':[{'key':'rdj_football_analysis','categoryIds':['test']}]}
        selftest=self;api=Api()
        with tempfile.TemporaryDirectory() as out,patch.object(s,'VerifiedKickoffs',return_value=fixture_clock),patch.object(runner,'make_translator',side_effect=AssertionError('No model for incomplete source')):
            report=runner.run(args(out,edition='2026-10-21',source=['rdj_football_analysis'],api_base='http://localhost:4300',publish=True),fetcher=self.partial(out),now=NOW,clock=lambda:NOW,api_client=api)
        self.assertEqual(api.calls,['/api/internal/editorial/config']);self.assertFalse(report['published']);self.assertTrue(report['blocked'])

if __name__=='__main__':unittest.main()
