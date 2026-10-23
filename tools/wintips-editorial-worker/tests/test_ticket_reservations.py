"""Actual fixture parsing; synthetic extra article only tests poll ordering."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from editorial_worker import sources as s, runner
import test_catalogue_markets as catalogue_fixtures
from test_worker import args, Offline

class TicketReservationTests(unittest.TestCase):
    def context(self):
        p,fetch,clock=catalogue_fixtures.TicketFilteringTests().real_pmu()
        url=p.url.replace('/74768-','/99999-')
        a=s.rdj.FetchedPage(url,p.html.replace('Victoire Stuttgart + Brest - Nice : Les 2 marquent','Les deux équipes marquent VfB Stuttgart - M Gladbach + Brest - Nice'))
        fetch.pages[a.url]=a;fetch.pages[p.url]=p
        for index in s.COMBINE_INDEXES:fetch.pages[index]=s.rdj.FetchedPage(index,'<a href="'+a.url+'">COMBI</a>')
        return a,p,fetch,clock

    def test_two_polls_keep_published_goals_duo_when_a_new_mixed_ticket_arrives(self):
        a,b,fetch,clock=self.context();kwargs={'now':s.iso('2026-10-23T08:00:00Z'),'resolver':clock}
        first=s.collect_combine('2026-10-23',fetch,source='rdj_football_duo',**kwargs)['items'][0]
        pin={key:first[key] for key in ('sourceId','sourceUrl')};pin['fingerprint']=s.ticket_fingerprint(first)
        for index in s.COMBINE_INDEXES:fetch.pages[index]=s.rdj.FetchedPage(index,'<a href="'+b.url+'">COMBI</a><a href="'+a.url+'">COMBI</a>')
        fresh=s.collect_combine('2026-10-23',fetch,source='rdj_football_duo',pinned_ticket=pin,**kwargs)
        self.assertEqual([item['sourceId'] for item in fresh['items']],['99999'])
        goals=s.collect_combine('2026-10-23',fetch,source='rdj_football_goals',exclude_ticket_fingerprints={pin['fingerprint']},**kwargs)
        self.assertEqual(goals['items'],[])
        # Removing the pin reproduces the original unsafe reselection.
        self.assertEqual(s.collect_combine('2026-10-23',fetch,source='rdj_football_duo',**kwargs)['items'][0]['sourceId'],'74768')

    def test_pin_is_fetched_directly_even_when_no_longer_linked_and_never_replaced_if_changed(self):
        a,b,fetch,clock=self.context();kwargs={'now':s.iso('2026-10-23T08:00:00Z'),'resolver':clock}
        first=s.parse_combine(a,'2026-10-23',fetch,clock,source='rdj_football_duo')
        pin={'sourceId':first['sourceId'],'sourceUrl':first['sourceUrl'],'fingerprint':s.ticket_fingerprint(first)}
        for index in s.COMBINE_INDEXES:fetch.pages.pop(index)
        self.assertEqual(s.collect_combine('2026-10-23',fetch,source='rdj_football_duo',pinned_ticket=pin,**kwargs)['items'][0]['sourceId'],'99999')
        pin['fingerprint']='0'*64
        changed=s.collect_combine('2026-10-23',fetch,source='rdj_football_duo',pinned_ticket=pin,**kwargs)
        self.assertEqual(changed['status'],'source_incomplete');self.assertEqual(changed['items'],[])

    def test_prior_goals_ownership_excludes_that_candidate_from_new_duo(self):
        a,b,fetch,clock=self.context();first=s.parse_combine(a,'2026-10-23',fetch,clock,source='rdj_football_goals')
        for index in s.COMBINE_INDEXES:fetch.pages[index]=s.rdj.FetchedPage(index,'<a href="'+a.url+'">COMBI</a><a href="'+b.url+'">COMBI</a>')
        result=s.collect_combine('2026-10-23',fetch,source='rdj_football_duo',now=s.iso('2026-10-23T08:00:00Z'),resolver=clock,exclude_ticket_fingerprints={s.ticket_fingerprint(first)})
        self.assertEqual([item['sourceId'] for item in result['items']],['74768'])

    def test_server_pin_applies_to_goals_only_run_without_any_local_cache(self):
        a,b,fetch,clock=self.context();first=s.parse_combine(a,'2026-10-23',fetch,clock,source='rdj_football_duo')
        pin={key:first[key] for key in ('sourceId','sourceUrl')};pin['fingerprint']=s.ticket_fingerprint(first)
        config={'date':'2026-10-23','importEnabled':False,'sources':[{'key':'rdj_football_goals','categoryIds':['test']}],'ticketState':{'ready':True,'version':'rdj-ticket-v1','editionDate':'2026-10-23','duo':pin,'goals':[]}}
        class Api:
            def request(self,route,payload=None):
                selftest.assertIsNone(payload);return config
        selftest=self
        def collect(source,edition,fetcher,**kw):
            return s.collect_combine(edition,fetcher,resolver=clock,source=source,**kw)
        with tempfile.TemporaryDirectory() as out,patch.object(runner,'collect',side_effect=collect):
            report=runner.run(args(out,source=['rdj_football_goals'],api_base='http://localhost:4300'),fetcher=fetch,now=s.iso('2026-10-23T08:00:00Z'),api_client=Api())
        self.assertEqual(report['sources'][0]['itemCount'],0);self.assertFalse(report['published'])

    def test_missing_unready_or_previous_edition_state_blocks_tickets_before_fetch(self):
        for state in [None,{'ready':False}, {'ready':True,'version':'rdj-ticket-v1','editionDate':'2026-10-22','duo':None,'goals':[]}]:
            config={'date':'2026-10-23','importEnabled':False,'sources':[{'key':'rdj_football_duo','categoryIds':['test']}],'ticketState':state}
            class Api:
                def request(self,*args):return config
            with tempfile.TemporaryDirectory() as out,patch.object(runner,'collect',side_effect=AssertionError('No ticket fetch on unknown ownership')):
                report=runner.run(args(out,source=['rdj_football_duo'],api_base='http://localhost:4300'),fetcher=Offline(),now=s.iso('2026-10-23T08:00:00Z'),api_client=Api())
            self.assertEqual(report['sources'][0]['status'],'source_blocked');self.assertTrue(report['blocked'])

if __name__=='__main__':unittest.main()
