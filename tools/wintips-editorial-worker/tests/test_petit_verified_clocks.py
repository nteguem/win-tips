"""Typed WinTips adapter regressions; synthetic HTML/provider, zero live I/O."""
from datetime import date,datetime,timezone
import unittest
from urllib.parse import parse_qs,urlsplit

from editorial_worker import sources as s
from editorial_worker.vendor.timing import OfficialKickoffs

DAY='2026-10-23'
JOURNAL=s.HOST+'/paris-sportifs/le-petit-journal/74775-le-petit-journal-du-parieur-vendredi-23-octobre-2026.html'
CASES=(('5749718','Torino','Monza','Serie A','ita.1','18h45','20h45','18:45',2.0),
       ('5803295','Nancy','Laval','Ligue 2','fra.2','20h00','20h00','18:00',1.57))


def url(row):return s.HOST+'/pronostic/'+row[1].lower()+'-'+row[2].lower()+'-'+row[0]+'.html'


def card(row,index):
    identity,home,away,competition,league,journal_clock,detail_clock,utc,odds=row
    return ('<article><p>Notre prono</p><h2>'+competition+'</h2><div aria-label="Match">'
        +'<img src="https://img.ruedesjoueurs.com/img/'+str(index*10+1)+'-1.png">'
        +'<img src="https://img.ruedesjoueurs.com/img/'+str(index*10+2)+'-1.png">23 octobre 2026 '+journal_clock+'</div>'
        +'<p>Cette analyse de test est une fixture synthétique indépendante et sert uniquement à contrôler la conservation des faits du collecteur.</p>'
        +'<div><div>Victoire '+home+'</div><div>@'+str(odds)+'</div></div>'
        +'<a href="'+url(row)+'">Lire l’analyse complète</a></article>')


def detail(row,index):
    identity,home,away,competition,league,journal_clock,detail_clock,utc,odds=row
    return ('<html><head><meta property="og:image" content="https://img.ruedesjoueurs.com/test-match.webp"></head><body>'
        +'<h1>Pronostic '+home+' - '+away+' du 23 octobre 2026</h1><nav class="breadcrumb"><a>Football</a></nav>'
        +'<h2 class="header">'+competition+'</h2><div class="fichematch">'
        +'<div class="equipe"><strong>'+home+'</strong><img src="https://img.ruedesjoueurs.com/img/'+str(index*10+1)+'-1.png"></div>'
        +'<div class="equipe"><strong>'+away+'</strong><img src="https://img.ruedesjoueurs.com/img/'+str(index*10+2)+'-1.png"></div>'
        +'<p class="m_title">23 octobre 2026 '+detail_clock+'</p></div>'
        +'<section><h2>L’état de forme</h2><p>Texte intégral de test : score 2-1, conserver exactement la négation ne perd pas.</p>'
        +'<p>Second paragraphe synthétique, conservé sans raccourci dans le schéma WinTips.</p></section></body></html>')


class Offline:
    def __init__(self,rows=CASES):
        self.calls=[];self.rows=rows
        self.pages={s.SOURCES['rdj_petit_journal']:'<a href="'+JOURNAL+'">Le Petit Journal du vendredi 23 octobre 2026</a>',
            JOURNAL:'<h1>Le Petit Journal du Parieur vendredi 23 octobre 2026</h1><div id="articleMainContent"><section id="tab-pronostics">'
                +''.join(card(row,index) for index,row in enumerate(rows,1))+'</section></div>'}
        self.pages.update({url(row):detail(row,index) for index,row in enumerate(rows,1)})

    def html(self,url):return s.rdj.FetchedPage(url,self.pages[url])

    def json(self,url):
        self.calls.append(url)
        query=parse_qs(urlsplit(url).query)
        league='fra.2' if '/fra.2/' in url else 'ita.1'
        events=[]
        if query['dates']==['20261023']:
            for row in self.rows:
                if row[4]!=league:continue
                names=('AS Nancy Lorraine','Stade Laval') if league=='fra.2' else row[1:3]
                moment=DAY+'T'+row[7]+':00Z'
                events.append({'id':'TEST-'+row[0],'competitions':[{'id':'TEST-'+row[0],'date':moment,'startDate':moment,
                    'timeValid':True,'status':{'type':{'state':'pre','name':'STATUS_SCHEDULED'}},
                    'competitors':[{'type':'team','homeAway':side,'team':{'id':'TEST-'+side,'displayName':name}}
                                   for side,name in zip(('home','away'),names)]}]})
        return {'leagues':[{'slug':league}],'events':events}


class PetitVerifiedClockTests(unittest.TestCase):
    def test_real_observed_torino_and_ligue2_clock_shapes_keep_typed_contract(self):
        fetch=Offline()
        result=s.collect('rdj_petit_journal',DAY,fetch,now=datetime(2026,10,23,10,tzinfo=timezone.utc))
        self.assertEqual(result['status'],'ready',result['issues'])
        self.assertEqual([item['sourceId'] for item in result['items']],['5749718','5803295'])
        self.assertEqual([item['startsAtUtc'] for item in result['items']],[DAY+'T18:45:00Z',DAY+'T18:00:00Z'])
        self.assertTrue(all(item['sourceUrl']==JOURNAL and item['kind']=='match' for item in result['items']))
        self.assertEqual(result['items'][1]['teams']['home']['name'],'Nancy')
        self.assertEqual(result['items'][1]['teams']['away']['name'],'Laval')
        self.assertEqual(result['items'][1]['selection']['label']['fr'],'Victoire Nancy')
        self.assertEqual(len(result['items'][1]['analysis']['fr'][0]['paragraphs']),2)
        self.assertIn('ne perd pas',result['items'][0]['analysis']['fr'][0]['paragraphs'][0])
        self.assertEqual(len(fetch.calls),6)
        self.assertTrue(any('/fra.2/' in called for called in fetch.calls))

    def test_arbitrary_clock_gap_is_not_repaired_to_fit_verified_schedule(self):
        broken=list(CASES)
        broken[0]=(*CASES[0][:6],'21h45',*CASES[0][7:])
        result=s.collect('rdj_petit_journal',DAY,Offline(broken),now=datetime(2026,10,23,10,tzinfo=timezone.utc))
        self.assertEqual(result['status'],'source_incomplete')
        self.assertEqual(result['items'],[])
        self.assertIn('kickoff_conflict',{issue['code'] for issue in result['issues']})

    def test_paris_dst_reconciliation_uses_package_timezone_without_system_database(self):
        fixture={'id':'TEST','home':'Torino','away':'Monza','sport':'football',
                 'journal_source_url':JOURNAL,'source_url':url(CASES[0])}
        proof={'method':'official_schedule','source_id':'TEST-DST','source_url':'https://match.uefa.com/v5/matches',
               'kickoff_utc':'2026-10-27T18:45:00Z'}
        actual,_=s.rdj._utc(fixture,datetime(2026,10,27,18,45),datetime(2026,10,27,19,45),date(2026,10,27),lambda *a:proof)
        self.assertEqual(actual,'2026-10-27T18:45:00+00:00')


if __name__=='__main__':unittest.main()
