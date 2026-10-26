WINTIPS — WORKER ÉDITORIAL RDJ

POLITIQUE DE PUBLICATION — 26 OCTOBRE 2026
La traduction ne bloque plus une source valide. La publication et la preview
--translate utilisent translate_batch(..., best_effort=True). Gemini traduit
les marchés inconnus ; les diagnostics de noms/chiffres/style sont consultables,
sans refuser une traduction imparfaite. Sans résultat exploitable, le fragment
FR est conservé dans son champ EN. Clé absente ou quota épuisé ne suppriment
aucun pronostic. Source, date, heure, schéma, droits et déduplication restent
contrôlés. Les modes locaux sont historiques : leurs refus de qualité internes
sont également convertis en repli FR par le runner de publication.

PRÉPARATION LOCALE, ACTIVATION SÉPARÉE
Aucun service ou timer n'est installé automatiquement. L'installateur explicite
décrit ci-dessous laisse toujours les unités non armées. Aucun import, index, mapping
ou push réel n'est effectué pendant ses tests ou ses prévisualisations. Les
exemples restent volontairement en dry-run. La revue de qualité anglaise réelle
et le GO utilisateur précèdent toute publication ; la recette sur deux appareils
FR/EN précède la généralisation. Ne pas confondre succès des tests et activation.

PRÉREQUIS
Python 3.10+. La collecte seule et les tests hors réseau utilisent la bibliothèque
standard : pas de navigateur, requests ou BeautifulSoup. Europe/Paris est résolu
par ZoneInfo ; le petit TZif IANA fourni avec provenance/licences sert uniquement
de repli quand la base système manque, notamment sous Windows.

La publication complète les champs FR/EN au mieux. Azure F0 utilise la bibliothèque
standard et une clé privée, sans modèle local : lire AZURE-F0.txt. Les modes
locaux suivants sont historiques et optionnels. Le mode Marian int8 nécessite
CTranslate2 et SentencePiece déjà installés dans le répertoire opérateur, plus les
poids locaux vérifiés par editorial_worker/assets/mt/opus-mt-fr-en-20200226-int8.json.
Le paquet ne les installe, ne les convertit ni ne les télécharge. Le manifeste
contient leur provenance, licence, tailles et SHA256. Le benchmark local de
38 phrases et quatre items a mesuré 10,61 secondes et un pic RSS de 160,7 Mo,
avec un thread CPU. Cette mesure ne garantit pas la charge du futur tour complet :
garder la limite 1 Gio du worker et contrôler son RSS réel avant activation.
Les dépendances ne sont pas
installées par requirements.txt, limité à la collecte standard-library.

Dans les modes locaux historiques, les secours Qwen et TranslateGemma utilisent le runtime Ollama local
existant. Il faut vérifier leurs modèles préinstallés, l'endpoint local, le service et les
deux verrous partagés avant déploiement. Aucun compte cloud n'est créé par ce paquet.

EXÉCUTION EXPLICITE
Depuis tools/wintips-editorial-worker :

  python3 -B -m editorial_worker --dry-run --output ./var/preview
  python3 -B -m editorial_worker --dry-run --translate --output ./var/bilingual-preview

Le mode par défaut est dry-run, même si ce drapeau est omis. Sans --translate,
la prévisualisation peut conserver le français seul. Avec --translate, la même
politique de traduction au mieux que la publication est utilisée, mais
aucun POST d'import ou notification n'est exécuté.

Sans --api-base, les sept adaptateurs sont inspectés. Avec --api-base (ou
WINTIPS_EDITORIAL_API_BASE), GET /api/internal/editorial/config sélectionne les
seules sources affectées par le BO à des catégories actives. Cette route et les
POST internes utilisent Bearer WINTIPS_EDITORIAL_WORKER_TOKEN ; aucun compte admin
n'est nécessaire. Le jeton reste dans un fichier d'environnement protégé hors Git,
jamais dans une commande, un cache HTTP public ou une sortie de journal.

Après validation et GO seulement :

  python3 -B -m editorial_worker --publish --max-requests 80 --max-seconds 240 --output /var/lib/wintips-editorial-worker

L'origine HTTPS et le jeton doivent être configurés ; importEnabled doit être vrai.
Le client interne refuse proxy, redirection et toute route hors de son allowlist :
GET config, POST import et POST notifications/drain uniquement.

Le budget de production est explicite :80requêtes publiques/240secondes par
passage, partagé entre les sources. Un refus effectif de quota ou de délai
pendant une source rend tout son lot source_incomplete avec zéro item ; il ne
devient ni une absence normale ni un lot partiel publiable. La trace expose
seulement code/limites/compteurs/durée, jamais URL, réponse ou donnée sensible.
Une source suivante satisfaite intégralement en mémoire reste autorisée, même
après un refus précédent ; atteindre exactement le maximum sans nouveau refus
ne suffit pas à bloquer. Les erreurs HTTP ordinaires et secours vérifiés ne sont
pas assimilés aux refus de budget. Le préflight froid isolé garde40requêtes.

LES TROIS PHASES D'UN TOUR
1. Collecter les sources publiques, vérifier identités/date/heure et sauvegarder
   les lots FR. La collecte HTTP se termine avant l'inférence : le temps de
   traduction ne consomme pas son budget de quatre minutes.
2. Traduire au mieux les lots FR/EN, conserver les audits privés et
   libérer un éventuel runtime local détenu avant les imports et l'attente FCM.
   Une source absente ne publie rien. Une source invalide reste bloquée ; une
   traduction indisponible conserve le FR original dans les champs EN.
3. Revalider l'édition courante et le délai avant chaque POST import. L'API
   conserve l'autorité sur les catégories, les gates et les droits VIP. Puis,
   quand les notifications sont autorisées, POST notifications/drain avec
   {"dryRun":false}, même si aucune nouvelle source n'a produit d'item.

Une interruption ne déclenche pas une publication de la veille. Un refus conserve
son motif dans le rapport. Les fichiers FR/EN, cache et audits restent privés dans
le répertoire d'état ; ils ne doivent pas entrer dans Git ni être exposés sur HTTP.

TRADUCTION AZURE F0 PRÉPARÉE, ACTIVATION SÉPARÉE
WINTIPS_EDITORIAL_TRANSLATOR=azure sélectionne l'adaptateur cloud indépendant.
Paragraphes entiers, requêtes groupées, HTML construit/notranslate pour les noms
structurés et valeurs présentes, sortie texte simple, FR/faits inchangés. Les
marchés et libellés connus restent déterministes. Le garde lexical/ordre global
du LLM local n'est pas utilisé dans ce mode. Aucune qualité sémantique parfaite
n'est garantie : une première vraie revue reste nécessaire après réception d'une clé.
30 secondes/requête, 180 secondes globales, quotas durables UTC jour/mois avant
chaque tentative, markup et retries inclus ; maximum mensuel autorisé 2000000.
Sans clé ou quota, pas d'appel ni repli local : les champs EN conservent le FR. Le mode
Azure ne prend aucun verrou BigWin et ignore l'admission du modèle local, même
si une ancienne configuration contient MANAGE_MODEL=true. Lire AZURE-F0.txt
pour les paramètres privés, le cache, les limites et les prérequis du tarif F0.
Les exemples d'environnement/unité choisissent Azure et restent non armés.

MODES LOCAUX HISTORIQUES — QWEN / TRANSLATEGEMMA
WINTIPS_EDITORIAL_TRANSLATOR=marian conserve le nom historique du provider.
WINTIPS_EDITORIAL_QWEN_PRIMARY=true est obligatoire dans cette factory : toute
phrase libre commence désormais par Qwen, y compris une analyse dont un ancien
cache Marian prétendait être valide. Aucun texte libre MT n'est accepté et aucun
transport Marian n'est exécuté dans ce mode. Les libellés connus et les marchés
bornés sont traduits de façon déterministe, sans modèle. Un cache MT exact déjà
refusé peut uniquement restituer le diagnostic factuel qui permet de retrouver
une vraie réponse Qwen réparée ; il ne fournit jamais le texte EN du résultat.
Si Qwen est rejeté pour son contenu, TranslateGemma 4B offre un secours sous les
mêmes gardes. Une erreur réseau Qwen ne déclenche pas ce secours. Aucun texte n'est assemblé manuellement
pour faire passer une fixture. Un cache exact déjà valide ne démarre pas Ollama.
Une erreur de configuration, de source, de cache corrompu ou de budget ne contourne
pas les garde-fous. Le budget global et les validations restent identiques.

Le cache v5 conserve des RÉPONSES exactes, jamais une autorisation réutilisable.
La clé lie le source et le prompt UTF-8 complets, le modèle demandé, l'endpoint,
les options, les ancres et l'empreinte de tous les faits FR de l'item et de ses
jambes, ainsi que les versions du contrat. Seuls les champs EN sont retirés du
contexte factuel. Une cote, un horaire, un acteur, le prompt ou le modèle modifié
exige une nouvelle réponse. La version du garde est conservée dans l'audit,
distincte de la clé : toute réponse retrouvée passe encore le garde courant.
Un ancien passed n'est jamais accepté aveuglément. Les caches d'ancien format
ne sont pas migrés ou réétiquetés sous de nouveaux prompts. Une configuration
opérateur qui remplace les poids sous un même nom de modèle doit invalider ce
nom/version de cache ; le transport ne télécharge aucun modèle automatiquement.

La cascade transmet au moteur suivant un retour factuel structuré du garde
(faits attendus et manquants, erreurs), avec la phrase FR originale entière.
Ce retour ne contient aucune analyse EN écrite manuellement. Le prompt de
réparation et son feedback ont une identité cache distincte ; les mêmes gardes
s'appliquent encore. Une réponse de base valide est cherchée en premier. Une
réponse refusée n'est pas recalculée à l'identique sous un prompt déterministe.
Une réparation déjà refusée passe au prochain moteur, puis bloque la source
si aucun candidat n'est validé. Les erreurs techniques et budgets ne deviennent
pas des demandes de réparation. Le plafond de segments compte chaque phrase
source une fois, tandis que le temps global borne toute la cascade.

Dans le mode primaire, si Qwen puis Gemma ont tous deux réellement échoué sur
le contenu, un seul ultime essai Qwen reçoit le FR original entier, les faits
attendus du garde et la véritable réponse refusée, explicitement non fiable.
Ce candidat n'est jamais une vérité à recopier. Le prompt et ce feedback ont
une clé distincte ; les mêmes gardes restent obligatoires. Il n'y a pas de
quatrième appel de réparation. Erreurs réseau, JSON, cache, déchargement ou
budget ne déclenchent pas cet ultime essai. La route complète des caches est
relue avant tout transport, y compris ce dernier cache réparé : un résultat
natif déjà valide peut donc être repris sans démarrer un modèle.

WINTIPS_EDITORIAL_MT_ROOT désigne les poids existants ; WINTIPS_EDITORIAL_MT_DEPS
leur installation CTranslate2/SentencePiece. WINTIPS_EDITORIAL_MODEL_ENDPOINT et
WINTIPS_EDITORIAL_MODEL désignent Qwen ; WINTIPS_EDITORIAL_FALLBACK_MODEL désigne
le secours (par défaut translategemma:4b, valeur vide pour le désactiver).
Avant de changer de modèle local, la cascade décharge seulement le précédent
qu'elle a demandé, afin de ne pas garder deux modèles en RAM. Chaque cache est
lié à l'identité exacte de son modèle et revalidé. Le mode explicite ollama
reste possible ; voir translation.example.json. Il nécessite une revue séparée
des chemins de verrous ReadWritePaths ; l'unité exemple Azure n'en a pas besoin.

WINTIPS_EDITORIAL_MANAGE_MODEL=true permet au superviseur de prendre les deux
verrous existants, vérifier le job partagé inactif, puis démarrer le service modèle
seulement lorsque nécessaire. Verrous :
  /var/lib/journal-parieur-worker/daily-run/worker.lock
  /var/lib/journal-parieur-worker/worker.lock
Le runtime Qwen existant est borné séparément à 6,5 Gio et deux CPU. Un runtime déjà
actif et détenu par un autre job n'est ni réutilisé de force ni arrêté. Le finally
arrête seulement celui que cette tâche a démarré. Le processus worker reste borné
par son propre service ; la factory recommandée ne charge pas les poids Marian.
Les fenêtres de validation avec inférence Qwen consomment réellement du CPU et
peuvent demander plusieurs reprises bornées à vingt minutes. Le cache natif
conserve les réponses exactes entre ces reprises. Les durées mesurées sont des
preuves historiques, jamais une garantie de délai pour une prochaine édition.

translate_batch retourne une copie bilingue et un audit séparé. title.en,
summary.en, selection.label.en et analysis.en sont complétés, y compris chaque
rencontre d'un combiné. Les paragraphes FR et faits structurés ne sont pas modifiés.
Un intitulé connu peut avoir une traduction déterministe ; Gemini traduit les
analyses et les marchés nouveaux. Le repli FR est explicitement audité.
Les diagnostics contrôlent notamment noms, chiffres, résultats et chronologie,
y compris en cache. Une sortie imparfaite est conservée ; une sortie inexploitable
utilise le FR sans bloquer le lot. Les audits restent disponibles pour revue.

SOURCES ET LIMITES D'ADAPTATEUR
rdj_petit_journal : /paris-sportifs/le-petit-journal.html
L'article daté décide des rencontres, du marché et de sa cote ; les fiches liées
fournissent équipes, blasons et analyses. SourceId est l'ID RDJ réel du match.
Pas de remplacement par l'édition précédente, ni de nombre de matchs inventé.

rdj_turf_quinte : /turf/pronostic-turf.html
La vraie fiche RnCn datée décide des conditions, partants et horaire. La sélection
vient de #nospronos ol.picks, sans substituer le choix Genybet de #api-tip.
L'événement JSON-LD doit fournir un fuseau explicite et un statut programmé.
Casaques : URL réellement présentes sur RDJ, parfois media.genybet.fr. Les champs
jockey/entraîneur sont omis s'ils ne sont pas prouvés. Aucune cote totale inventée
ou produit ZE5ORDRE promotionnel renommé artificiellement Quinté+.

rdj_football_analysis : /pronostics/foot.html
Seulement les fiches éditoriales réelles /pronostic/<slug>-<ID>.html, sans mélanger
résultats/live. Choix explicite de l'expert ; cote absente si le couple texte/cote
n'est pas prouvé. Les matchs connus du Petit Journal du jour sont exclus du VIP.
Le VIP peut être traité seul si le Petit Journal est absent.

rdj_football_combine : /actualites/paris-sportifs.html
Clé historique conservée. Articles COMBI/COMBINÉ récents avec identités vérifiées,
de deux à cinq rencontres et cote totale publiée. La découverte inspecte aussi
/paris-sportifs/sport-news/news-pmu-sport.html et /paris-sportifs.html, car les vrais
tickets PMU ne sont pas toujours liés par l'index /actualites/paris-sportifs.html.
Les formats BTTS et les jambes explicites victoire/BTTS/buts sont identifiés par
une grammaire finie, jamais par l'IA. Les cotes de jambes restent nulles si seul
le total est annoncé. Le premier départ ferme le ticket. Les horaires contenant
plusieurs heures ou un qualificatif non géré (UTC, etc.) sont refusés, non tronqués.

rdj_football_duo : Le Duo du Jour
Seulement un vrai ticket RDJ de DEUX événements distincts avec total publié entre
2 et 4 inclus. Le champ curation identifie publisher_ticket, RDJ, l'article source
et le bookmaker explicitement cité. Aucun produit de meilleures cotes de plusieurs
opérateurs, aucun faux ticket construit. Une journée sans ticket adapté reste vide.
Un seul Duo est retenu par édition. À validité égale, un ticket mixte/résultat
précède un ticket uniquement buts ; ce dernier reste utilisable s'il est le seul
candidat. L'ordre de collecte impose cette priorité même si le BO envoie les
sources inversées. L'empreinte des événements, horaires et sélections exclut du
Combiné Buts une copie du même ticket, même sous un autre article. Si seul Buts
est actif, aucun Duo artificiel ne le prive de contenu.

La priorité reste stable entre les passages horaires : GET config fournit
ticketState (version rdj-ticket-v1, édition, Duo publié et compositions Buts).
Le worker relit directement l'article du Duo déjà publié, vérifie sa composition,
et ne le remplace jamais par un candidat arrivé plus tard. Une source modifiée,
absente ou un registre indisponible bloque le ticket concerné sans inventer de
remplacement. Buts exclut aussi le Duo persistant lorsque seul Buts est collecté ;
un nouveau Duo exclut les compositions déjà publiées dans Buts.

L'API protège les deux sens dans Mongo, indépendamment du worker : le document
editorialticketstates de l'édition sérialise les réservations et les écritures de
contenu dans une même transaction. Les anciennes lignes sont relues sans être
réécrites ; un historique contradictoire exige une revue. L'index explicite
editorial_ticket_edition_unique (editionDate unique) doit être préparé via
tools/editorial-indexes.cjs avant activation. Aucun GET/import ne crée d'index.
Une copie d'article, un changement de cote ou l'ordre des jambes ne peuvent pas
contourner l'identité événements UTC + équipes + marchés + choix normalisés.

rdj_football_goals : Combiné Buts
Seulement deux ou trois jambes dont TOUS les marchés sont btts,
over_under_goals ou team_goals, avec total explicitement publié par RDJ. Un ticket
victoire Stuttgart + Brest/Nice BTTS peut devenir un Duo, jamais un Combiné Buts.
La construction de tickets WinTips à partir de cotes individuelles n'est pas armée :
elle exigerait un contrat séparé prouvant même opérateur et horodatages compatibles.

rdj_multisport_analysis : Expert Multisports
Analyses éditoriales /pronostics/basket.html et /pronostics/volleyball.html : NBA et
volley quand une sélection, l'identité, la compétition et le départ sont prouvés.
Les pannes de tous les index donnent source_incomplete, pas une journée vide normale.
Le Petit Journal gratuit conserve ses sports d'origine et ses propres sélections ;
les IDs gratuits connus sont exclus du VIP. Aucun quota quotidien promis.
Le calendrier NBA public est prioritaire ; un secours ESPN NBA est limité aux
matchs scheduled, timeValid, aux deux participants ordonnés et à la bonne ligue.
Volleyball World /api/v1/globalschedule/date/date vérifie seulement les événements
réellement renvoyés par son calendrier (VNL et certains clubs). Ce n'est pas une
couverture universelle CEV/volley. Statut0, identité unique, tournoi et heureUTC
sont exigés ; classement mondial historique et matchs en cours/terminés sont exclus.
Une absence de preuve diffère la publication, elle n'invente jamais une heure.
Victoire, écart, points d'équipe/joueur et scores/totaux de sets ont des traductions
déterministes lorsqu'ils correspondent à la grammaire supportée. Aucune inclusion
des prolongations n'est déduite de la simple étiquette NBA.

DATES ET CONTRAT API
L'édition est celle du calendrier RDJ Europe/Paris, changements d'heure inclus.
Les départs restent des instants UTC vérifiés ; une date de publication n'est
jamais réutilisée comme coup d'envoi. Les fiches sans offset explicite exigent un
calendrier UEFA/NBA/ESPN/Volleyball World avec identité et compétition prouvées, sinon le match est
bloqué. Chaque nouveau match, course et rencontre de combiné doit être programmé
au moins trente minutes après l'instant de publication. L'API revérifie ce délai,
l'identité, le schéma et la correspondance des dates présentes dans les URL.
Exception explicite NBA : une éditionD peut inclure la nuit suivante AVANT midi
Europe/Paris en D+1, avec changements d'heure. La date d'éditionD et l'instantUTC
restent intacts. editionConvention=nba_following_night et scheduleProof sont
obligatoires, avec preuveNBA/ESPN exacte ; pas de WNBA, autre sport, D+2 ou midi.
Cette exception couvre aussi la carte NBA nocturne du Petit Journal gratuit.
Le budget de collecte reste borné à80GET au maximum par passage et240secondes par
défaut ; les trois sources de tickets partagent les pages du même fetcher. Seules
les sources actives dans le BO sont collectées en exploitation avec --api-base.

L'import exige par défaut FR+EN complet : WINTIPS_EDITORIAL_REQUIRE_EN reste true
en production. Les analyses sont affichées développées ; le choix et la cote
arrivent après chaque analyse. Aucun faux pays, blason, indice de confiance ou
rang n'est ajouté. Les noms officiels de clubs, chevaux et courses restent réels.

NOTIFICATIONS ET IDÉMPOTENCE
Importer peut envoyer une notification APRÈS la persistance effective, si l'API
l'autorise. Le worker appelle aussi le drain pour reprendre les rejets récupérables.
Par défaut tout est désactivé :
  WINTIPS_EDITORIAL_IMPORT_ENABLED=false
  WINTIPS_EDITORIAL_NOTIFICATIONS_ENABLED=false
  WINTIPS_EDITORIAL_REQUIRE_EN=true
L'envoi exige APP_ID=wintips, les deux activations et l'absence de coupe-circuit
DISABLE_PUSH_NOTIFICATIONS=true. Les index requis sont créés seulement par la CLI
explicite tools/editorial-indexes.cjs, après revue séparée ; jamais par le worker.

L'import upsert categoryId+source+editionDate+sourceId. Le registre durable des
notifications utilise app+catégorie+source+édition. Un ACK accepté ou un résultat
réseau ambigu ne sont jamais renvoyés de force. Seuls les refus explicites sûrs
peuvent être repris ; review_required exige une revue opérateur. Le rapport compte
les acceptations réelles du fournisseur, pas un nombre d'affichages sur téléphones.
POST /api/internal/editorial/notifications/drain avec {"dryRun":true} est une
prévisualisation serveur en lecture seule ; ne pas confondre avec une vraie reprise.

Les destinataires sont les appareils actifs, consentants et déclarant la capacité
numérique editorialSchemaVersion=1. Les anciens clients ne reçoivent pas ces liens
RDJ. Langue choisie FR/EN prioritaire, puis OS, puis français ; VIP selon les droits
réels de l'abonnement et de la catégorie. Le payload ouvre un détail ou un fil via
action view_editorial/view_editorial_feed, categoryId, editionDate et isVip ; aucun
choix ou contenu d'analyse protégé n'est exposé dans la notification.

DÉPLOIEMENT NON ARMÉ ET COEXISTENCE MOBILE
Depuis le checkout Git API récupéré sur le VPS, faire d'abord :

  python3 -B tools/wintips-editorial-worker/deploy/install.py --check

Après revue du commit et GO installation, uniquement sous root/Linux :

  python3 -B tools/wintips-editorial-worker/deploy/install.py --install --expected-commit <FULL_REVIEWED_API_SHA>

Le HEAD doit correspondre exactement au SHA revu et le dossier worker doit être
propre, sans source locale non suivie (les caches ignorés par Git restent permis).
Une modification historique de yarn.lock hors de
ce dossier est préservée ; aucune branche particulière n'est imposée. Les unités
existantes WinTips doivent être arrêtées et le timer désactivé AVANT installation.
L'installateur n'arrête, ne démarre, ne redémarre et n'active aucun service/timer.
Il vérifie les unités, installe le service en --dry-run --translate, puis recharge
uniquement les définitions systemd lorsque leur contenu a changé.

L'environnement /etc/wintips-editorial-worker.env est créé en 0600 avec un jeton
VIDE à renseigner séparément. Un environnement existant n'est jamais lu, remplacé,
affiché ou chmodé ; un fichier non privé, non root ou un lien est refusé. Le dossier
/var/lib/wintips-editorial-worker est privé en 0700. Aucune donnée ou configuration
BigWin, permission de ses verrous, dépendance ou modèle n'est modifié. Le jeton
dédié doit être synchronisé avec l'API par l'opérateur, sans apparaître dans Git
ni les arguments de commande. Réexécuter l'installation conserve les secrets et
ne réécrit pas des unités identiques. Publication, notifications et activation
du timer restent des étapes séparées après GO ; --check ne crée aucun fichier.

Les exemples systemd sont à revoir avant installation : dossier réel API, jeton,
modèles et dépendances existants, droits et restrictions. Le service exemple fait
--dry-run --translate. Le passage explicite à --publish et l'activation du timer
horaire ne sont faits qu'après GO. La tâche est du VPS, indépendante des apps et
du navigateur. Elle ne laisse pas un modèle chargé entre ses tours.

Le timer est à *:30 UTC, sans rattrapage Persistent. En mode LOCAL runtime géré
(WINTIPS_EDITORIAL_MANAGE_MODEL=true), après la collecte HTTP légère et avant
toute traduction/import/reprise de notification, un garde UTC exige que le budget
de traduction complet plus 300 secondes pour démarrage/cleanup tiennent avant le
prochain BigWin *:07 UTC. Les 60 secondes suivant *:07 sont aussi réservées pour
son délai aléatoire de démarrage. Le garde est revérifié avant les deux verrous
partagés puis immédiatement après leur acquisition. Il ne dort jamais en gardant
un verrou : fenêtre insuffisante = rapport deferred_shared_window, aucun modèle,
import ou push, puis nouvelle tentative au prochain tour. Le runtime ne s'arrête
que s'il a été démarré par ce tour et n'est pas utilisé par BigWin. Un échec de
cleanup interdit aussi toute livraison. Les horaires BigWin et ses unités restent
inchangés ; si son calendrier opérateur change, revoir ce contrat UTC avant
d'activer WinTips. Aucune promesse de latence d'une édition froide n'en découle.

Conserver les catégories legacy jusqu'à disponibilité du nouveau mobile. Avant de
basculer une ancienne catégorie RDJ, le pont WINTIPS_EDITORIAL_LEGACY_BRIDGE=true
peut conserver ses vrais imports legacy et externalSources : anciens clients sans
header lisent ces coupons ; nouveau client x-wintips-editorial:1 lit RDJ, sans
doublons. Le pont est explicite, silencieux et temporaire ; aucune conversion en
faux coupon. Sa désactivation doit attendre une décision sur l'adoption mobile.

SANTÉ ET CHARGE
Un verrou empêche deux tours simultanés. Bornes par défaut : quatre-vingts GET publics,
vingt secondes par réponse, 240 secondes de collecte, cache HTTP dix minutes ; le
budget de traduction séparé est 1200 secondes et reste plafonné par CLI. Réponses
publiques et API ont des limites de taille. Les redirections publiques restent
sur les hôtes permis ; l'API interne refuse toute redirection.

  python3 -B -m editorial_worker.health --output /var/lib/wintips-editorial-worker

La santé exige mode publish, rapport récent et édition courante (grâce limitée
après minuit Paris). Elle signale sources/traduction/import bloqués, drain pending
et review_required vus dans les réponses d'import ou de drain. Pour une preview
non armée, ajouter explicitement --allow-preview. Conserver aussi le suivi du
registre durable et traiter ses états review_required ; une acceptation fournisseur
ne prouve jamais l'affichage ou le clic. Cette CLI n'installe aucune alerte externe.

ACCROCHES DANS LE FIL MOBILE
Le feed /api/editorial/feed expose l'accroche bilingue validée de la source et du
jour dans category.description, champ déjà lu par les téléphones actuels, ainsi
que dans editorialDescription. La langue demandée FR/EN est respectée. Aucune
nouvelle version mobile n'est nécessaire pour cet affichage. Si la copie manque,
est legacy ou n'est plus liée aux contenus exacts, description reprend le texte
de catégorie du BO et editorialDescription est absent. Le texte enregistré dans
le BO, les résumés et les analyses source restent inchangés. Cette présentation
ne régénère pas les copies déjà gelées et ne rejoue aucune notification.

VALIDATION LOCALE
  python3 -B -m unittest discover -s tests -v

Le compteur final est fourni par le reçu après gel. Les tests couvrent adaptateurs,
identité source, absences, horaires/fuseaux, minuit et DST Paris, délai minimal,
traduction et cache, cascade, verrous, budgets, isolation, import/drain et santé.
Ils n'envoient aucun push, ne téléchargent aucun modèle et n'écrivent pas en base.
Les fragments DOM de fixtures portent URL/empreinte dans leur provenance. La
commande manuelle tests/capture_sources.py --capture fait des GET publics et ne
fait pas partie de la suite hors réseau. Un ancien dry-run daté est une preuve
historique, jamais une garantie de disponibilité de source pour l'heure actuelle.
