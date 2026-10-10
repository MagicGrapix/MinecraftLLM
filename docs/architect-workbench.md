# Atelier Architect

## Lancer

Depuis la racine : `npm.cmd run dev:architect`, puis http://127.0.0.1:3004/.
Le serveur LLM sélectionné dans `src/agent/AgentConfig.ts` doit être disponible pour lancer un essai.
`LLM_BACKEND = "llamacpp"` utilise le serveur existant sur le port 8080 ; `"ollama"` revient au 9B.
Ce choix est partagé avec le bot ; redémarrer l'atelier après modification. Ouvrir la page ne fait aucun appel LLM.
Minecraft, le coordinateur, l'actionneur et le world controller ne sont ni lancés ni rejoints.
Le port est la valeur par défaut dans `scripts/dev/architect/Server.ts`, indépendante du debug du bot (3001).

## Essais

- Choisir « Layer by layer » (sélection initiale dans la page) ou « Complete drawing » (mode inchangé du bot).
  Le choix concerne cet essai uniquement, pas la configuration globale. L'API sans `mode` garde le mode `complete`.
- Saisir la demande ; éventuellement fournir une instruction de délégation, des contraintes et des observations.
  La demande et les compléments sont regroupés dans un seul message user ; une instruction identique à la demande n’est pas répétée.
- Choisir le plafond de sortie (256 à 32768) et le `reasoning_effort`. Le défaut vient de `AgentConfig`.
  Le backend décide de la prise en charge de ces niveaux ; ils ne garantissent pas cinq budgets distincts.
  Le budget de sortie peut inclure la réflexion du modèle. Cela ne change pas sa fenêtre de contexte.
- Lancer un seul essai à la fois. Le vrai `ArchitectAgent` utilise huit appels maximum en dessin complet,
  seize en mode couches (initialisation, jusqu'à cinq couches, corrections et finalisation).
  La compression et la limite d'entrée de 20k restent communes aux deux modes.
  Le plafond d’appels reste interne, absent du prompt.
- Stop annule la génération et attend la fin du travail en cours, y compris les écritures non annulables.
  Le créneau n'est pas libéré prématurément. Une soumission reçue après annulation n'est pas acceptée.
- Un nouvel essai crée un agent, un historique et un store neufs. Aucun historique d'essai précédent
  n'est transmis. Les fichiers `architect.md` ou `architect-layers.md`, et `context-summary.md`, du répertoire de prompts configuré
  sont relus à ce moment ; les textes lus sont à la fois archivés et utilisés, sans deuxième lecture.

L'interface, ses exemples, les prompts et les libellés de contexte générés sont en anglais.
Les demandes, instructions, contraintes et observations saisies restent dans leur langue d'origine :
aucune traduction automatique ni modification des anciens essais ou des réponses du modèle.

La boucle LLM, le store et la validation sont ceux de production. Le mode couches ajoute un prompt et
trois outils expérimentaux, non activés dans le bot. Ce n'est pas un test de délégation par le coordinateur :
les entrées sont choisies manuellement ici. Aucun succès d'outil n'est simulé.

## Dessin complet

Un seul champ `drawing`, texte multiligne : `A` = oak_planks, `.` = air requis.
Une ligne vide sépare les couches, du bas vers le haut. Dimensions déduites, maximum 8×8×5.
Pas de palette, matériaux à choisir, portes, titre ou dimensions à générer. Le format interne
Blueprint reste inchangé pour le Builder et les anciens dessins. `lookup_material` reste disponible
aux autres agents, pas à l’Architect. Le system contient uniquement règles, légende et limites en listes.
Les observations/contraintes restent dans le message user, jamais dans ce system.

## Couche par couche

Le prompt est `prompts/architect-layers.md`. La conversation reste native assistant/tool, chronologique.

1. `start_blueprint({ width, depth, height, description })` initialise un brouillon aux dimensions explicites.
   `description` est un petit plan libre (500 caractères maximum), pas une liste de champs par couche.
   Les couches sont des gabarits X : X = non défini, A = oak_planks, point = air requis.
2. `set_blueprint_layer({ layer, drawing })` remplace une couche entière, numérotée à partir de 1 en bas.
   L'agent peut revenir sur toute couche. Il faut exactement depth lignes de width caractères A/point,
   sans ligne vide ni commentaire. CRLF/LF sont équivalents. Aucun caractère n'est réparé automatiquement.
3. `finish_blueprint({})` refuse les couches manquantes et les dessins sans bloc, puis passe le dessin complet
   au même parseur et au même store que l'ancien mode. Seule cette réussite enregistre une référence et termine.

Chaque résultat contient le brouillon courant complet (dimensions, description, progression et couches),
même après une erreur d'arguments. La dernière paire assistant/tool protégée par le compactor suffit donc
à retrouver le dessin exact. Il n'est pas dupliqué dans le system. Les erreurs de grille présentent la
tentative annotée avec `# Row ...` séparément : une tentative refusée ne remplace jamais une couche valide.
Les annotations sont bornées, les arguments exacts restent dans les traces.
Le contenu des messages tool reçus par le LLM est du texte réellement multiligne, sans sérialisation JSON
des grilles. Le résultat structuré reste conservé séparément dans l'inspecteur et les traces techniques.

Rappeler start avec les mêmes dimensions met à jour la description sans effacer les couches. Des dimensions
différentes sont refusées : un nouvel essai est nécessaire. Le brouillon est remis à zéro à chaque délégation.
Les limites géométriques restent 8×8×5 ; la limite d'appels expérimentale est `ARCHITECT_LIMITS.layeredMaxCalls`.
La validation finale ne contrôle pas l'habitabilité, l'alignement architectural ou le sens de la demande.
Le format stocké, le builder et les agents Minecraft restent inchangés.

## Lire les résultats

- Conversation : chaque message dans son rôle réel ; système découpé en sections pour la lecture,
  avec le texte intégral également disponible ; tools séparés, descriptions et JSON Schema ;
  contenu assistant, réflexion renvoyée par le backend, arguments, feedback du validateur.
- Blueprints : toutes les tentatives `submit_blueprint`, même refusées ou non exécutées ; couches ASCII,
  dessin brut en texte, légende fixe et quantités calculées pour le dessin accepté. L'aperçu visuel est borné
  (16 couches, 32 lignes, 64 caractères), les arguments complets restent accessibles.
  En mode couches : initialisation, couches soumises, retours annotés et pile courante après chaque outil.
  Conversation affiche aussi le feedback texte déplié ; le JSON exact reste disponible séparément.
- Sources & inputs : version des templates utilisée et paramètres de délégation.
- Exact JSON : corps réellement envoyé à l'API, réponse brute avant parsing, round de l'inspecteur
  et téléchargement de l'essai entier. Pas de clé API dans ces données.

Les cartes d'appels portent les erreurs en rouge. Une réponse `finish_reason: length` est signalée
même si son parsing échoue ensuite. La réponse n'est pas streamée : on peut voir la requête pendant
la génération, puis la réponse entière à son arrivée. Le panneau de lecture n'est jamais remplacé
par un rafraîchissement automatique : sélectionner un appel/onglet ou « Refresh this detail » pour
charger les nouveautés. Les listes d'essais/appels peuvent évoluer sans interrompre cette lecture.

Un blueprint accepté prouve la validation du format, des matériaux et des dépendances prises en charge.
Cela ne prouve pas que le dessin répond à l'intention, possède une maison habitable, ou soit accessible
au builder dans un monde donné. L'atelier ne pose aucun bloc.

## Fichiers et frontière

### Vérification du 6 octobre 2026

Trois essais ponctuels avec Qwen 3.5 9B, plafond de sortie 4096 (pas une mesure de fiabilité) :

- Plancher 3×3, effort medium : un appel, 8,5 s, une couche et neuf planches, conforme.
- Abri 5×5×4, effort medium : un appel, 32,9 s, sortie tronquée à 4096 tokens avant soumission.
- Même abri, effort none : deux appels, 1,5 s. Le premier n’a pas appelé l’outil ; le rappel de format
  a obtenu une soumission valide au second. Les quatre couches répétées ne respectent toutefois
  ni l’intérieur 3×3 ni l’entrée demandés. Format accepté, objectif architectural non atteint.

Ces essais sont dans `logs/architect-workbench/session_1791302089790_3e8a7dd3-3f13-422f-81f5-612b0bb2484e/`.
Le paramètre none concernait seulement le dernier essai ; aucun réglage global ni monde Minecraft modifié.

### Vérification du 7 octobre 2026 — couches

Essais ponctuels avec Qwen 3.5 9B, sortie limitée à 4096 tokens ; ils ne mesurent pas la fiabilité :

- Première version du feedback (grilles sérialisées en JSON), effort medium : 42,4 s, deux appels.
  Initialisation réussie, puis sortie tronquée avant modification d'une couche.
- Même version, effort none : 51,5 s, seize appels. Corrections répétées, limite atteinte sans finalisation.
- Feedback final en texte multiligne, effort none : 30,3 s, onze appels, trois modifications refusées
  puis corrigées, retour sur des couches déjà soumises et `finish_blueprint` accepté.
  Le dessin 5×5×4 contient 72 planches mais ne respecte pas la demande : plancher et toit troués,
  ouverture au nord plutôt que porte à l'est et fenêtre 1×1. La boucle fonctionne ; la géométrie reste à améliorer.

Les deux premiers essais sont dans
`logs/architect-workbench/session_1791385562778_172533ad-a6b8-4db2-98ba-d2487e7289db/`.
Le dernier est dans
`logs/architect-workbench/session_1791385935743_5ee2e52b-51fa-4287-a57b-4ea58381b426/trial_1791385978546_7d982ab9-718d-42f4-85c0-5b257be0dbfa/`.
Ces échantillons ne suffisent pas à attribuer une amélioration au format du feedback.
Les 494 tests automatisés passent, dont les régressions du brouillon, des outils et de l'atelier.
Aucun monde Minecraft ni réglage global du modèle n'a été modifié.

### Organisation

`scripts/dev/architect/Workbench.ts` assemble les composants existants ; `Server.ts` fournit le serveur HTTP
et `ui/` une page sans dépendance supplémentaire. `main.ts` charge la configuration LLM habituelle.
Les tests de régression sont dans `tests/unit/dev/ArchitectWorkbench.test.ts` (transport LLM scripté).

Chaque processus crée `logs/architect-workbench/session_…/trial_…/` :

- `trace.jsonl` : entrées, sources, requêtes/réponses exactes et résultats, écrits au fil de l'essai ;
- `trial.json` : document final consultable/exportable, avec les rounds et sources ;
- `blueprints/` : dessins acceptés par le vrai store, indépendants de `data/blueprints/`.

Les essais terminés sont relus sur disque ; leurs transcriptions ne restent pas toutes en RAM.
La liste web recense la session du serveur actuel, pas les sessions antérieures. Les anciens fichiers
restent sur disque. Les traces contiennent les prompts et réponses : ne pas les partager sans vérification.
Le serveur écoute uniquement sur 127.0.0.1, refuse les Host/Origin étrangers et les corps JSON trop gros.
Les routes n'acceptent pas de chemin de fichier arbitraire. Ce n'est pas un service à exposer sur Internet.

Pour retirer l'atelier : supprimer son dossier de scripts, le script npm associé et ses tests/docs.
Il n'est ni importé ni empaqueté par le runtime du bot. Aucun changement de prompt de production n'est requis.
