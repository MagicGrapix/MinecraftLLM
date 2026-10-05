# Scénarios Minecraft de bout en bout

Le lanceur dans `tests/e2e/` démarre un controller OP et un nouveau processus du bot pour chaque essai.
Les agents, tools, skills et prompts sont ceux de production. La demande passe par le chat Minecraft.
Les critères de test ne sont jamais injectés dans le contexte LLM. Aucun LLM supplémentaire ne juge les résultats.

## Lancer une campagne

Le serveur Minecraft et Ollama doivent déjà tourner. Le lanceur ne redémarre pas le serveur.
Dans la console du serveur, une seule fois :

```text
op test_controller
```

Depuis la racine du projet :

```powershell
npm.cmd run test:scenarios -- --list
npm.cmd run test:scenarios -- --scenario craft_table
npm.cmd run test:scenarios -- --scenario collect_two_logs --timeout 300 --repeat 3
npm.cmd run test:scenarios -- --scenario collect_four_logs --timeout 300
npm.cmd run test:scenarios -- --scenario place_block_in_front
npm.cmd run test:scenarios -- --scenario craft_wooden_pickaxe --repeat 5
npm.cmd run test:scenarios -- --repeat 5
npm.cmd run test:scenarios
```

La dernière commande lance les onze scénarios une fois chacun. `--repeat 5` les répète cinq fois chacun
(55 essais pour la suite entière). Les répétitions d'un scénario sont consécutives, avec reset complet à chaque fois.
Le reset modifie l'arène configurée du world builder
(par défaut X/Z -48..48, Y -64..-30), y compris ses blocs souterrains et ses entités hors joueurs.
Le profil restauré est bedrock -64, terre -63/-62, herbe -61, air au-dessus.
Éviter les interventions manuelles et les autres bots actifs dans cette zone pendant une campagne.
Ne pas démarrer manuellement les pseudos dédiés `test_bot` / `test_controller`.
Seul le controller doit être OP ; ne pas donner OP à `test_bot`.

Les constantes se règlent dans `tests/e2e/config.ts` ; les scénarios dans `tests/e2e/scenarios.ts`.
Les options de connexion Minecraft et Ollama restent celles du projet. Le délai propre à un scénario
est son `timeoutMs`, avec 300 000 ms par défaut ; `--timeout` surcharge ce délai en secondes.
Un message de scénario est limité à 220 caractères, sans slash initial ni saut de ligne, pour rester
une seule demande dans le chat actuel. `--help` et `--list` ne contactent ni Minecraft ni Ollama.

Scénarios disponibles :

- `craft_table` : quatre planches fournies ; obtenir une table de craft dans l'inventaire.
- `collect_two_logs` : inventaire vide, un chêne fixe ; gagner au moins deux bûches.
- `collect_four_logs` : inventaire vide, trois chênes aux positions X/Z (5, 0), (-5, 4), (3, 9) ;
  gagner au moins quatre bûches. Les arbres contiennent chacun quatre blocs de tronc. Le bot peut
  récolter un seul arbre ou plusieurs ; casser les blocs sans ramasser leur loot ne suffit pas.
- `place_block_in_front` : une planche de chêne fournie ; la poser au sol juste devant la position
  initiale du bot. Il démarre face au sud (+Z), donc la cible est (0, surfaceY+1, 1), soit (0, -60, 1)
  par défaut. Le critère vérifie le passage air → `oak_planks` à cet endroit **et** la consommation
  d'un bloc d'inventaire. Tourner ou se déplacer ne déplace pas la cible ; jeter l'objet ne valide pas le test.
- `craft_wooden_pickaxe` : table posée à (3, surfaceY+1, 0), trois planches et deux bâtons fournis ;
  obtenir une pioche en bois et conserver la table en place. Isole le craft 3×3 de la récolte et de la pose de table.
- `collect_dropped_logs` : quatre bûches au sol à (5.5, surfaceY+1, 0.5), sans arbre ; les ramasser.
  Le loot de test ne disparaît pas avec le temps. Sa disparition seule ne suffit pas : il faut gagner quatre bûches.
- `chest_withdraw` : coffre avec quatre bûches, inventaire vide ; retirer exactement deux bûches et fermer le coffre.
- `chest_deposit` : coffre vide, quatre bûches en inventaire ; en déposer exactement deux et fermer le coffre.
  Pour les deux tests, les variations des deux inventaires doivent être opposées et le coffre doit rester en place.
- `navigate_around_wall` : mur de pierre de cinq blocs de large et trois de haut, centré en Z=3 ;
  se tenir sur le marqueur cobblestone au sol en (0, surfaceY, 6), mur intact.
- `navigate_with_scaffolding` : pilier de deux blocs en X=6/Z=0 avec sommet cobblestone, douze terres fournies ;
  se tenir sur le sommet sans détruire le pilier. Vérifie aussi une nouvelle terre posée autour du pilier et une
  consommation de terre. L'agent choisit ses actions ; le test ne force pas un tool ou un itinéraire particulier.
- `eat_food` : un steak fourni, faim réduite pendant la préparation ; le consommer et augmenter la faim.
  Aucun scénario de craft impossible/prérequis manquant n'est inclus.

Les scénarios supplémentaires sont répartis dans `InteractionScenarios.ts` et `NavigationScenarios.ts`,
réexportés par `scenarios.ts`. Les fixtures utilisent des positions fixes et s'adaptent à `surfaceY`.
Les agents et leurs prompts ne sont pas modifiés par ces scénarios.

Commencer par un scénario avec `--scenario ID`, puis ajouter `--repeat 5` pour comparer plusieurs essais.
À 300 secondes par essai, 55 essais pourraient prendre 4 h 35 **hors préparation** s'ils atteignaient tous
leur limite. La répétition par défaut reste donc 1. Aucun de ces lancements n'est automatique.

Pour une série périodique, sans chevauchement :

```powershell
npm.cmd run test:scenarios -- --campaigns 3 --interval 60
```

Cela lance trois campagnes, espacées de 60 secondes **après la fin** de la précédente.
Le programme doit rester ouvert. Ce n'est pas une tâche système ni un service en arrière-plan.
Ctrl+C annule la campagne, ferme ses processus et conserve les résultats déjà écrits.
Un échec de critère, un timeout ou une erreur isolée (préparation, workflow, observation IPC)
est enregistré, puis la campagne passe à l'essai suivant après nettoyage confirmé. Chaque essai
garde son propre verdict ; une erreur ne masque pas les scénarios suivants.
La campagne s'arrête seulement si le controller/serveur n'est plus utilisable, si la sortie du
processus ou la déconnexion du joueur ne peut pas être confirmée, si les sources changent ou sur Ctrl+C.
Ces arrêts restent bloquants : le prochain reset ne doit pas commencer sans isolation garantie.
Le code de sortie est 0 si tous les essais réussissent, 1 sinon.

## Cycle et isolation

1. Vérification OP du controller et des chunks de l'arène.
2. Reset du terrain, bot de test déconnecté. Vérification de toutes les cellules de l'arène.
3. Pose de la fixture, puis vérification des blocs attendus et du reste de l'arène.
   Ensuite seulement, remplissage des coffres et apparition des drops, puis vérification de leur contenu.
4. Nouveau processus Node du bot, nouveau contexte des agents et fichier de landmarks propre à l'essai.
5. Inventaire vidé et alimenté, effets retirés, santé/faim restaurées, XP remis à zéro, mode survival,
   position (0.5, surfaceY+1, 0.5), orientation sud, slot de barre rapide 0. Temps réglé au jour, météo claire.
6. Vérification de l'inventaire, santé, faim, effets, position, orientation, sol et absence d'action physique.
   `eat_food` termine la préparation entre 6 et 16 points de faim, sans effet actif ; les autres restent à 20.
7. Activation du chat, demande du controller, confirmation structurée de prise en charge, chronométrage.
8. Observations toutes les 200 ms. Après l'événement de fin du workflow, demander un nouvel instantané.
   Cet état frais + exécuteur libre + critère satisfait = réussite. Un snapshot demandé avant la fin,
   même reçu après, ne peut pas décider du verdict final.
   Pour les coffres, deux lectures consécutives après la fin doivent donner les mêmes inventaires,
   blocs suivis et état de fenêtre. Ce contrôle de stabilité ne promet pas une transaction atomique entre clients.
9. `stop` dans le chat, arrêt du workflow, attente de libération du verrou physique, fermeture du processus
   et confirmation de départ du joueur par le controller avant le prochain reset.

`TrialCleanup.ts` applique cette barrière de nettoyage indépendamment du verdict du test.
Elle confirme également l'absence du joueur après une erreur de préparation sans processus enfant.

Le controller est créé avec `physicsEnabled: false` et placé en spectateur au-dessus de l'arène.
Il n'applique pas de gravité locale pendant que le reset supprime le sol. Le bot agent garde sa physique normale.
Une mort du controller est une erreur d'infrastructure, jamais une observation valide après respawn.

La vérification du terrain/fixture conserve l'attente de dix secondes pour les mises à jour serveur.
Au timeout, le message précise la première anomalie du **dernier scan** : position, bloc attendu,
bloc observé (`unknown` si indisponible), ou entité non-joueur encore présente. Une seule entrée
`world.verification_failed` est écrite dans les événements de campagne avec ce diagnostic et l'état
du controller. L'erreur apparaît aussi dans `result.json`, le rapport HTML et la console ; chaque poll
n'écrit pas un log. Annuler la campagne ne génère pas ce diagnostic de timeout.

`ResetArenaGenerator.generateTerrainReset` ne cible pas un joueur connecté.
Après le nettoyage, il pose toute la couche d'herbe, puis les deux couches de terre du haut vers le bas,
puis la bedrock. La terre est ainsi couverte dès sa pose, même lorsque les `/fill` sont découpés,
pour éviter une propagation d'herbe pendant le reset. La vérification exacte des blocs reste inchangée.
Le reset manuel existant combine toujours terrain, joueur, temps et météo.
Les arbres de scénario ont une géométrie fixe et des feuilles persistantes, posées avec deux `/fill` par arbre.
La génération naturelle `/place feature` reste disponible dans le world builder manuel.

Le bot de test accepte le chat normalement. Le worker détecte une demande acceptée d'un autre émetteur
ou différente de la demande attendue comme une contamination. Il n'ajoute aucun contrôle de propriétaire
au bot normal. Une intervention physique d'un joueur n'est pas automatiquement détectée.

Le profil `hungry` applique `hunger` pendant quatre secondes (amplificateur 255), après la restauration
habituelle de santé/saturation. Le lanceur attend l'expiration de l'effet et vérifie la faim effectivement
observée avant de transmettre la demande. Il ne modifie pas la difficulté du serveur ; le mode peaceful
est refusé explicitement pour ce scénario. Le serveur actuel est configuré en normal.

L'IPC du worker transporte uniquement readiness, événements de workflow, observations et fermeture.
Un snapshot peut demander une liste de cellules fixes (64 maximum), lues avec `blockAt` dans les chunks
reçus du serveur. Une cellule indisponible vaut `null`, pas `air` ; la préparation attend leur disponibilité.
Les mêmes positions sont relues pendant l'essai et conservées dans `blocks` des observations.
Pour les coffres, `BlockNbtReader` utilise les paquets `query_block_nbt` / `nbt_query_response` du controller OP,
appariés par numéro de transaction, avec timeout et nettoyage des listeners. Aucune fenêtre n'est ouverte
pour cette lecture et aucune commande chat n'est envoyée à chaque poll. Un coffre manquant ou des données
illisibles donnent un inventaire `null`, jamais vide ; un timeout de lecture est une erreur d'infrastructure.
L'observation ajoute une erreur structurée (`code`, `message`, chemin NBT et extrait borné si pertinent).
Après un échec de préparation, `world.environment_verification_failed` conserve la dernière observation.
Pendant un essai, un coffre impossible à observer classe l'essai en `error`, pas en échec de l'agent.
Le paquet Java 1.21.11 ne contient pas nécessairement `id` : son absence est acceptée seulement si le
controller observe bien un bloc `chest` à cet endroit avant et après la lecture. Un `id` présent mais
incompatible reste invalide. `Items` doit être une liste explicite, même pour un coffre vide.
La lecture NBT cible Java 1.21.11 et utilise les stacks `id` / `count` du
[format moderne documenté par Mojang](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-20-5).
`EnvironmentObservations` ajoute `containers` / `drops` aux snapshots côté lanceur ; le worker fournit aussi
`windowOpen`. Les drops sont observés depuis les entités et leurs métadonnées reçues par le controller.
Cette instrumentation de test ne donne aucun outil, coordonnée cible ou critère supplémentaire aux agents.
Les objectifs viennent du controller via Minecraft, jamais d'une commande IPC d'action.
La déconnexion seule n'efface pas les données joueur côté serveur ; le reset du joueur est donc obligatoire.
Les recettes/découvertes/advancements du compte serveur ne sont pas effacés.

Si l'annulation ne termine pas les opérations physiques dans les dix secondes de grâce, le lanceur
termine uniquement son enfant Node et note `forcedShutdown`. La confirmation serveur reste requise.
Le timeout garde son statut, mais un essai autrement réussi devient une erreur si sa fermeture échoue.
Un verrou exclusif `logs/scenarios/.running.lock` empêche deux lanceurs de modifier l'arène en parallèle.
Après un crash du lanceur, vérifier que ses processus sont arrêtés avant de retirer un verrou résiduel.

## Résultats et mesures

Chaque campagne écrit `logs/scenarios/campaign_<date>_<id>/report.html`, consultable sans serveur.
Le rapport est réécrit après chaque essai. Il n'impose aucun rafraîchissement pendant la lecture.
Ouvrir/recharger le fichier pour voir les nouveaux résultats.
L'inspecteur affiche une liste d'appels défilante, un panneau de détail et une chronologie défilante.
Cliquer une carte ou une barre sélectionne le même appel et le surligne. Pour un LLM, le détail présente
les messages exacts du prompt, les tools transmis et la réponse ; pour un tool, les arguments et le résultat.
Les contenus JSON sont formatés pour la lecture et les données brutes restent accessibles. Les erreurs sont rouges.
Le tableau et l'histogramme par outil comptent les appels démarrés de l'essai sélectionné, avec les échecs distingués.

`Statistics.ts` conserve le corps de `llm.request` avec la réponse et les éventuelles erreurs.
Un ancien rapport sans cette requête l'indique explicitement ; les traces originales permettent de le régénérer.
Les sources UI sont dans `tests/e2e/report/`, incorporées par `Report.ts` dans un unique HTML autonome.

- `campaign.json` : configuration effective, scénarios, révision Git et empreinte source ; clé API exclue.
- `prompts/` : copie utilisée réellement par les workers, même si les prompts originaux sont édités ensuite.
- `skills/`, `source/`, `working-tree.patch` : copie de référence du code, des skills et changements locaux.
- `results.json` : essais et statistiques cumulés, consommables ultérieurement par une autre UI.
- `<essai>/scenario.json` : demande, délai, inventaire initial, profil de faim, coffres et drops prévus.
- `<essai>/events.jsonl` : événements du lanceur et observations de l'inventaire/état/cellules/coffres/drops suivis.
- `<essai>/trace_<session>.jsonl` : requêtes LLM, réponses brutes et appels de tools de production.
- `<essai>/result.json` : verdict, critère, observations initiale/finale, temps et statistiques.
- `<essai>/process.log`, `log_<session>.log`, `agent_summary_<session>.md` : sorties et checklist.
- `<essai>/landmarks.json` : mémoire de lieux isolée, conservée pour inspection.

Chaque ligne JSONL conserve `timestamp`, `event`, `data`.
Les événements `trial.observation` ont aussi un identifiant, l'instant de demande/réception relatif au
début de l'essai, et `afterWorkflowFinish` pour distinguer une lecture finale d'une requête plus ancienne.
Le journal de tools contient le numéro, le rôle, le tool-call ID, les arguments, le résultat et les inventaires avant/après si suivis.
Les numéros sont uniques dans une session du bot ; chaque nouveau processus repart de 1.
Ils ne sont donc pas des identifiants globaux de campagne. Utiliser essai/session + numéro.

Statuts : `passed`, `failed` (workflow terminé mais critère faux), `timeout`, `error` (préparation,
workflow en erreur, observation perdue ou infrastructure). Un « success » du modèle ne valide rien seul.
Les critères de craft/récolte mesurent des gains d'inventaire depuis l'état initial, pas seulement une présence.
Le placement compare aussi la cellule cible observée au début et à la fin, sans faire confiance au rapport du modèle.
Les tests de navigation vérifient la position finale et les blocs suivis, pas chaque mouvement intermédiaire
ni chaque cellule du monde. Une nouvelle terre posée et consommée est requise pour le scénario de scaffolding.
Un objectif atteint sans workflow terminé avant le délai reste un timeout, avec `goalReachedAtMs` renseigné.
Le temps de setup est séparé du temps de demande. Les observations et IPC ont une granularité de quelques
centaines de millisecondes ; un état observé après le délai ne transforme pas un timeout en réussite.

La timeline distingue LLM/tools, rôles, erreurs et appels interrompus. Les comptes se basent sur les débuts
d'appels, avec des fins appariées. `run_step` englobe des appels enfants : ne pas sommer ces durées
comme une durée totale de travail. Les tokens sont ceux fournis par le backend, lorsqu'ils existent.
La copie des prompts et le monde initial fixe ne rendent pas le LLM déterministe ; répéter les essais.
La compilation/lancement Node et le reset sont hors délai, mais un éventuel chargement à froid du modèle
pendant la demande est inclus. Pas de mesure GPU, préremplissage ou token/s dédiée.

Le serveur inspecteur 3001 du bot habituel n'est pas démarré par les workers. Le rapport de campagne
est indépendant des processus de test et conserve les anciennes sessions.
Une modification de `src/`, `skills/` ou `tests/e2e/` pendant une campagne l'invalide et arrête la suite.
Les paramètres globaux jour/météo restent dans l'état réglé par le dernier reset, comme le reset manuel.

## Vérifier et étendre

`npm.cmd test` compile également `tests/e2e/` et exécute ses tests unitaires (cycle, timeout,
inventaire, fixtures, statistiques, HTML et IPC avec un faux worker sans Minecraft/Ollama).
Les vrais scénarios ne sont jamais exécutés par cette commande.

Pour vérifier le protocole sur un serveur local déjà lancé, sans LLM :

```powershell
node -r ts-node/register scripts/smoke/minecraft-observations.ts
```

Ce smoke utilise `test_controller` OP et `audit_bot` non OP. Il refuse des cellules occupées ou déchargées
aux positions (-39,-60,-40) et (-40,-60,-39), puis pose un coffre et une bûche temporaires, lit le coffre
vide/rempli, casse la bûche avec confirmation serveur et teste un déplacement. Il retire ses blocs à la fin ;
il ne reset pas l'arène et ne lance aucun agent LLM. Ne pas intervenir dans ce coin pendant le test.

Le smoke de construction est séparé : `npm.cmd run smoke:build`.
Il teste deux blocs puis un abri 5x5 de 80 blocs, interruption/reprise et vérification par le controller, sans LLM.
`npm.cmd run smoke:doors` ajoute les quatre orientations de porte et la maison de 81 placements,
avec ouverture, entrée, sortie, fermeture et nouvelle vérification indépendante de toute la structure.
Il utilise `build_test_bot` et une petite zone vide autour de (-24,-60,-24), nettoyée ensuite.
Voir [les prérequis et limites](blueprints.md#smoke-minecraft-explicite). Ce n'est pas encore un scénario conversationnel avec Architect.

Pour ajouter un scénario, définir un `Scenario` dans `scenarios.ts` avec demande, inventaire,
fixture bornée facultative, liste de blocs attendus et `verify(initial, current)`.
`expectedBlocks` décrit la fixture à vérifier avant l'essai ; `observeBlocks(config)` sélectionne,
si nécessaire, les cellules à suivre pendant l'essai. Les critères restent de petites fonctions
déterministes, basées sur l'inventaire, l'état du bot et ces observations explicites de blocs.
`containers(config)` décrit des coffres déjà présents dans la fixture et les items à y mettre ;
`drops(config)` décrit les piles au sol (position, item, count). Leur préparation et observation restent
exclusivement dans la couche de test/controller. `hungry: true` sélectionne le profil de faim décrit ci-dessus.
