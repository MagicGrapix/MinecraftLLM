# Atelier Architect

## Lancer

Depuis la racine : `npm.cmd run dev:architect`, puis http://127.0.0.1:3004/.
Ollama doit être disponible pour lancer un essai. Ouvrir la page ne fait aucun appel LLM.
Minecraft, le coordinateur, l'actionneur et le world controller ne sont ni lancés ni rejoints.
Le port est la valeur par défaut dans `scripts/dev/architect/Server.ts`, indépendante du debug du bot (3001).

## Essais

- Saisir la demande ; éventuellement fournir une instruction de délégation, des contraintes et des observations.
  La demande et les compléments sont regroupés dans un seul message user ; une instruction identique à la demande n’est pas répétée.
- Choisir le plafond de sortie (256 à 32768) et le `reasoning_effort`. Le défaut vient de `AgentConfig`.
  Le backend décide de la prise en charge de ces niveaux ; ils ne garantissent pas cinq budgets distincts.
  Le budget de sortie peut inclure la réflexion du modèle. Cela ne change pas sa fenêtre de contexte.
- Lancer un seul essai à la fois. Le vrai `ArchitectAgent` conserve sa boucle limitée à huit appels,
  son seul tool `submit_blueprint({ drawing })`, la compression et la limite d’entrée de 20k.
  Le plafond d’appels reste interne, absent du prompt.
- Stop annule la génération et attend la fin du travail en cours, y compris les écritures non annulables.
  Le créneau n'est pas libéré prématurément. Une soumission reçue après annulation n'est pas acceptée.
- Un nouvel essai crée un agent, un historique et un store neufs. Aucun historique d'essai précédent
  n'est transmis. Les fichiers `architect.md` et `context-summary.md` du répertoire de prompts configuré
  sont relus à ce moment ; les textes lus sont à la fois archivés et utilisés, sans deuxième lecture.

Ce sont les prompts et le comportement de production, pas une imitation de l'Architect. Ce n'est toutefois
pas un test de la délégation par le coordinateur : les entrées sont choisies manuellement ici.
Aucun succès d'outil n'est simulé. L'atelier n'altère pas les plafonds des agents de production.

## Format actuel

Un seul champ `drawing`, texte multiligne : `A` = oak_planks, `.` = air requis.
Une ligne vide sépare les couches, du bas vers le haut. Dimensions déduites, maximum 8×8×5.
Pas de palette, matériaux à choisir, portes, titre ou dimensions à générer. Le format interne
Blueprint reste inchangé pour le Builder et les anciens dessins. `lookup_material` reste disponible
aux autres agents, pas à l’Architect. Le system contient uniquement règles, légende et limites en listes.
Les observations/contraintes restent dans le message user, jamais dans ce system.

## Lire les résultats

- Conversation : chaque message dans son rôle réel ; système découpé en sections pour la lecture,
  avec le texte intégral également disponible ; tools séparés, descriptions et JSON Schema ;
  contenu assistant, réflexion renvoyée par le backend, arguments, feedback du validateur.
- Blueprints : toutes les tentatives `submit_blueprint`, même refusées ou non exécutées ; couches ASCII,
  dessin brut en texte, légende fixe et quantités calculées pour le dessin accepté. L'aperçu visuel est borné
  (16 couches, 32 lignes, 64 caractères), les arguments complets restent accessibles.
- Sources & entrées : version des templates utilisée et paramètres de délégation.
- JSON exact : corps réellement envoyé à l'API, réponse brute avant parsing, round de l'inspecteur
  et téléchargement de l'essai entier. Pas de clé API dans ces données.

Les cartes d'appels portent les erreurs en rouge. Une réponse `finish_reason: length` est signalée
même si son parsing échoue ensuite. La réponse n'est pas streamée : on peut voir la requête pendant
la génération, puis la réponse entière à son arrivée. Le panneau de lecture n'est jamais remplacé
par un rafraîchissement automatique : sélectionner un appel/onglet ou « Actualiser ce détail » pour
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
