WINTIPS — WORKER ÉDITORIAL RDJ

PRÉPARATION LOCALE, ACTIVATION SÉPARÉE
Aucun service ou timer n'est installé par ce paquet. Aucun import, index, mapping
ou push réel n'est effectué pendant ses tests ou ses prévisualisations. Les
exemples restent volontairement en dry-run. La revue de qualité anglaise réelle
et le GO utilisateur précèdent toute publication ; la recette sur deux appareils
FR/EN précède la généralisation. Ne pas confondre succès des tests et activation.

PRÉREQUIS
Python 3.10+. La collecte seule et les tests hors réseau utilisent la bibliothèque
standard : pas de navigateur, requests ou BeautifulSoup. Europe/Paris est résolu
par ZoneInfo ; le petit TZif IANA fourni avec provenance/licences sert uniquement
de repli quand la base système manque, notamment sous Windows.

La publication exige un vrai contenu bilingue. Le mode Marian int8 nécessite
CTranslate2 et SentencePiece déjà installés dans le répertoire opérateur, plus les
poids locaux vérifiés par editorial_worker/assets/mt/opus-mt-fr-en-20200226-int8.json.
Le paquet ne les installe, ne les convertit ni ne les télécharge. Le manifeste
contient leur provenance, licence, tailles et SHA256. Le benchmark local de
38 phrases et quatre items a mesuré 10,61 secondes et un pic RSS de 160,7 Mo,
avec un thread CPU. Cette mesure ne garantit pas la charge du futur tour complet :
garder la limite 1 Gio du worker et contrôler son RSS réel avant activation.
Les dépendances ne sont pas
installées par requirements.txt, limité à la collecte standard-library.

Les secours Qwen et TranslateGemma utilisent uniquement le runtime Ollama local
existant. Il faut vérifier leurs modèles préinstallés, l'endpoint local, le service et les
deux verrous partagés avant déploiement. Aucun fournisseur IA payant n'est appelé.

EXÉCUTION EXPLICITE
Depuis tools/wintips-editorial-worker :

  python3 -B -m editorial_worker --dry-run --output ./var/preview
  python3 -B -m editorial_worker --dry-run --translate --output ./var/bilingual-preview

Le mode par défaut est dry-run, même si ce drapeau est omis. Sans --translate,
la prévisualisation peut conserver le français seul. Avec --translate, la même
traduction et les mêmes gardes bilingues que la publication sont exigées, mais
aucun POST d'import ou notification n'est exécuté.

Sans --api-base, les quatre adaptateurs sont inspectés. Avec --api-base (ou
WINTIPS_EDITORIAL_API_BASE), GET /api/internal/editorial/config sélectionne les
seules sources affectées par le BO à des catégories actives. Cette route et les
POST internes utilisent Bearer WINTIPS_EDITORIAL_WORKER_TOKEN ; aucun compte admin
n'est nécessaire. Le jeton reste dans un fichier d'environnement protégé hors Git,
jamais dans une commande, un cache HTTP public ou une sortie de journal.

Après validation et GO seulement :

  python3 -B -m editorial_worker --publish --output /var/lib/wintips-editorial-worker

L'origine HTTPS et le jeton doivent être configurés ; importEnabled doit être vrai.
Le client interne refuse proxy, redirection et toute route hors de son allowlist :
GET config, POST import et POST notifications/drain uniquement.

LES TROIS PHASES D'UN TOUR
1. Collecter les sources publiques, vérifier identités/date/heure et sauvegarder
   les lots FR. La collecte HTTP se termine avant l'inférence : le temps de
   traduction ne consomme pas son budget de quatre minutes.
2. Traduire et valider les lots complets FR/EN, conserver les audits privés et
   libérer le runtime Qwen détenu par cette tâche avant les imports et l'attente FCM.
   Une source absente ne publie rien. Une source invalide ou traduction rejetée
   est bloquée sans envoyer son lot FR seul ; les autres sources restent isolées.
3. Revalider l'édition courante et le délai avant chaque POST import. L'API
   conserve l'autorité sur les catégories, les gates et les droits VIP. Puis,
   quand les notifications sont autorisées, POST notifications/drain avec
   {"dryRun":false}, même si aucune nouvelle source n'a produit d'item.

Une interruption ne déclenche pas une publication de la veille. Un refus conserve
son motif dans le rapport. Les fichiers FR/EN, cache et audits restent privés dans
le répertoire d'état ; ils ne doivent pas entrer dans Git ni être exposés sur HTTP.

TRADUCTION MARIAN → QWEN → TRANSLATEGEMMA, SECOURS PARESSEUX
WINTIPS_EDITORIAL_TRANSLATOR=marian active la cascade recommandée : une traduction
locale Marian légère, un thread CPU et poids int8 ; les gardes de sens et de faits
valident la sortie. Si cette traduction est réellement rejetée, Qwen est sollicité
comme secours. Si Qwen est lui-même rejeté pour son contenu, TranslateGemma 4B
offre un troisième essai générique sous les mêmes gardes. Une erreur réseau Qwen
ne déclenche pas ce troisième moteur. Aucun texte n'est assemblé manuellement
pour faire passer une fixture. Un cache exact déjà valide ne démarre pas Ollama.
Une erreur de configuration, de source, de cache corrompu ou de budget ne contourne
pas les garde-fous. Le budget global et les validations restent identiques.

WINTIPS_EDITORIAL_MT_ROOT désigne les poids existants ; WINTIPS_EDITORIAL_MT_DEPS
leur installation CTranslate2/SentencePiece. WINTIPS_EDITORIAL_MODEL_ENDPOINT et
WINTIPS_EDITORIAL_MODEL désignent Qwen ; WINTIPS_EDITORIAL_FALLBACK_MODEL désigne
le troisième modèle (par défaut translategemma:4b, valeur vide pour le désactiver).
Avant de changer de modèle local, la cascade décharge seulement le précédent
qu'elle a demandé, afin de ne pas garder deux modèles en RAM. Chaque cache est
lié à l'identité exacte de son modèle et revalidé. Le mode explicite ollama
reste possible ; voir translation.example.json et deploy/environment.example.

WINTIPS_EDITORIAL_MANAGE_MODEL=true permet au superviseur de prendre les deux
verrous existants, vérifier le job partagé inactif, puis démarrer le service modèle
seulement lorsque nécessaire. Verrous :
  /var/lib/journal-parieur-worker/daily-run/worker.lock
  /var/lib/journal-parieur-worker/worker.lock
Le runtime Qwen existant est borné séparément à 6,5 Gio et deux CPU. Un runtime déjà
actif et détenu par un autre job n'est ni réutilisé de force ni arrêté. Le finally
arrête seulement celui que cette tâche a démarré. Le processus worker reste borné
par son propre service ; l'arrêt du processus libère sa mémoire Marian.

translate_batch retourne une copie bilingue et un audit séparé. title.en,
summary.en, selection.label.en et analysis.en sont complétés, y compris chaque
rencontre d'un combiné. Les paragraphes FR et faits structurés ne sont pas modifiés.
Un intitulé connu peut avoir une traduction déterministe ; les vraies analyses
sont traduites par les modèles locaux. Rien n'est simplement étiqueté anglais.
Les gardes contrôlent notamment noms, chiffres, résultats, négations et chronologie,
y compris les réponses en cache. Une sortie partielle ou rejetée bloque le lot.
Ces gardes ne prouvent pas toutes les nuances : la revue des textes FR/EN réels
reste nécessaire, particulièrement avant la première activation.

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
Articles COMBI/COMBINÉ récents avec liens de matchs vérifiés. Le format pris en
charge est « Les deux équipes marquent », de deux à cinq rencontres, et cote totale
explicitement donnée. Aucun autre marché n'est deviné par l'IA. Les cotes de
rencontres restent nulles si seul le total est annoncé ; aucun produit calculé.
Le premier départ du combiné gouverne sa fermeture. Alias finis, pas de recherche
approximative pouvant mélanger deux équipes ou une rencontre d'une autre date.

DATES ET CONTRAT API
L'édition est celle du calendrier RDJ Europe/Paris, changements d'heure inclus.
Les départs restent des instants UTC vérifiés ; une date de publication n'est
jamais réutilisée comme coup d'envoi. Les fiches sans offset explicite exigent un
calendrier UEFA/NBA/ESPN avec identité et compétition prouvées, sinon le match est
bloqué. Chaque nouveau match, course et rencontre de combiné doit être programmé
au moins trente minutes après l'instant de publication. L'API revérifie ce délai,
l'identité, le schéma et la correspondance des dates présentes dans les URL.

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
Les exemples systemd sont à revoir avant installation : dossier réel API, jeton,
modèles et dépendances existants, droits et restrictions. Le service exemple fait
--dry-run --translate. Le passage explicite à --publish et l'activation du timer
horaire ne sont faits qu'après GO. La tâche est du VPS, indépendante des apps et
du navigateur. Elle ne laisse pas un modèle chargé entre ses tours.

Conserver les catégories legacy jusqu'à disponibilité du nouveau mobile. Avant de
basculer une ancienne catégorie RDJ, le pont WINTIPS_EDITORIAL_LEGACY_BRIDGE=true
peut conserver ses vrais imports legacy et externalSources : anciens clients sans
header lisent ces coupons ; nouveau client x-wintips-editorial:1 lit RDJ, sans
doublons. Le pont est explicite, silencieux et temporaire ; aucune conversion en
faux coupon. Sa désactivation doit attendre une décision sur l'adoption mobile.

SANTÉ ET CHARGE
Un verrou empêche deux tours simultanés. Bornes par défaut : quarante GET publics,
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
