# Déploiement éditorial WinTips

Le collecteur importe uniquement avec le validateur du commit Git réellement
déployé. Copier des fichiers API sans mettre à jour ce commit peut faire
fonctionner les écrans HTTP tout en bloquant les publications suivantes.
Le contrôle d'import compare toujours les neuf fichiers validés, octet par octet,
à `HEAD`. Il ne faut ni le désactiver ni accepter un fichier modifié hors commit.

## Préparer et publier un commit revu

1. Préparer les modifications dans un checkout de livraison isolé. Exécuter les
   tests API/collecteur concernés. Ajouter seulement la liste de fichiers revue ;
   exclure les environnements, sauvegardes de secrets, journaux et données runtime.
   Ne pas utiliser `git add --all` sur le serveur.
2. Créer le commit de livraison, relever son SHA complet de 40 caractères, puis
   publier ce commit sur `origin/main`. Le commit publié doit comprendre à la fois
   l'API et les changements de collecteur dont elle dépend.
3. Sur le serveur, vérifier `git status --short`. Si des fichiers de livraison y
   sont déjà modifiés, arrêter la procédure et réconcilier cette ancienne livraison
   à partir de la liste revue. Préserver les autres modifications et fichiers
   privés. Aucun `reset --hard`, nettoyage global ou commit global n'est requis.
4. Avancer le checkout déployé avec `git pull --ff-only origin main`. Une divergence
   doit être résolue explicitement ; ne pas forcer le changement de branche.

## Contrôle obligatoire avant rechargement et activation

Depuis `/var/www/wintips/api`, dans un shell qui s'arrête à la première erreur :

```sh
set -e
release_sha='REMPLACER_PAR_LE_SHA_COMPLET_REVU'
git pull --ff-only origin main
node tools/wintips-editorial-worker/verify-deployment.cjs --expected-commit "$release_sha"
```

La commande est en lecture seule. Elle n'ouvre aucune connexion API ou base de
données, ne lit aucun secret et ne lance ni collecte, modèle, publication ou
notification. Elle réutilise exactement `checkout()` du précontrôle d'import.
Elle vérifie les neuf fichiers validés et le commit attendu. Un code de sortie
non nul interdit de déclarer la livraison réussie ou de passer à son activation.
Les noms de fichiers et leurs empreintes peuvent figurer dans la preuve ; leur
contenu et les erreurs internes de Git ne sont jamais affichés.

Après réussite, recharger le processus API WinTips prévu par la procédure
d'exploitation, puis vérifier sa santé. Rejouer le contrôle avec le même SHA
avant toute activation/réactivation des timers éditoriaux ou de leurs services.
Ne jamais lancer une publication ou une notification de test pour valider ce
contrôle de déploiement. Les timers existants reprennent ensuite leur parcours
normal ; les imports gardent leurs protections d'identité et de déduplication.

Ce contrôle porte sur les neuf fichiers épinglés par l'import et sur `HEAD` ; il
ne remplace ni les tests des autres fichiers de la livraison ni le contrôle de
santé HTTP. Un fichier runtime ou un ancien lockfile sans rapport avec ces neuf
fichiers peut rester modifié et n'est jamais ajouté, effacé ou réécrit par l'outil.

## Vérification locale sans installation supplémentaire

Le test du contrôle requiert seulement Node.js et Git, sans `npm install` :

```sh
node --test tests/editorial-deployment.node-test.cjs
```

Il crée ses propres dépôts Git temporaires avec des identités de test locales,
sans hooks ni conversion de fins de ligne. Il vérifie le refus des neuf fichiers
modifiés, l'acceptation d'un commit cohérent, le refus d'un SHA inattendu et la
préservation des fichiers extérieurs au périmètre. Aucune commande Git du test
ne modifie le checkout de travail ou celui du serveur.

Pour un diagnostic de checkout courant, le paramètre est facultatif :

```sh
node tools/wintips-editorial-worker/verify-deployment.cjs
```

Pour une livraison, fournir toujours `--expected-commit` avec le SHA revu.
