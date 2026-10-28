# Scénarios Minecraft de bout en bout

Le lanceur dans `tests/e2e/` démarre un controller OP et un nouveau processus du bot pour chaque essai.
Les scénarios LLM utilisent les agents, tools, skills et prompts de production. La demande passe par le chat Minecraft.
Les critères de test ne sont jamais injectés dans le contexte LLM. Aucun LLM supplémentaire ne juge les résultats.
Le scénario `build_small_shelter` isole le constructeur : le même chat déclenche une vraie capability `build`,
avec blueprint fixe et stock fourni, sans créer d'agent ni de client LLM.

## Lancer une campagne

Le serveur Minecraft doit déjà tourner, et le backend LLM configuré (llama-swap ou Ollama) pour les scénarios LLM. Le lanceur ne redémarre pas le serveur.
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
npm.cmd run test:scenarios -- --scenario craft_two_wooden_tools --repeat 1
npm.cmd run test:scenarios -- --scenario collect_cobblestone_from_mound --repeat 1
npm.cmd run test:scenarios -- --scenario craft_stone_pickaxe_from_world --repeat 1
npm.cmd run test:scenarios -- --scenario craft_iron_pickaxe_from_world --repeat 1
npm.cmd run test:scenarios -- --scenario build_small_shelter --repeat 1
npm.cmd run test:scenarios -- --repeat 5
npm.cmd run test:scenarios
```

La dernière commande lance tous les scénarios une fois chacun. `--repeat 5` les répète cinq fois chacun.
`--list` donne la liste actuelle. Les répétitions d'un scénario sont consécutives, avec reset complet à chaque fois.
Le reset modifie l'arène configurée du world builder
(par défaut X/Z -48..48, Y -64..-30), y compris ses blocs souterrains et ses entités hors joueurs.
Le profil restauré est bedrock -64, terre -63/-62, herbe -61, air au-dessus.
Éviter les interventions manuelles et les autres bots actifs dans cette zone pendant une campagne.
Ne pas démarrer manuellement les pseudos dédiés `test_bot` / `test_controller`.
Seul le controller doit être OP ; ne pas donner OP à `test_bot`.

Le controller espace maintenant ses commandes de 500 ms minimum (deux par seconde), y compris entre plans.
Ce débit a tenu 96 lectures consécutives sur le serveur local avec le controller OP ; ce n'est pas une
garantie pour tous les serveurs. `WORLD_COMMANDS_PER_SECOND=1` permet de revenir à une seconde.
La fenêtre de réponse reste à 150 ms ; la vérification des blocs attend toujours les mises à jour réelles.

Les constantes se règlent dans `tests/e2e/config.ts` ; les scénarios dans `tests/e2e/scenarios.ts`.
Les options de connexion Minecraft et Ollama restent celles du projet. Le délai propre à un scénario
est son `timeoutMs`, avec 300 000 ms par défaut ; `--timeout` surcharge ce délai en secondes.
Un message de scénario est limité à 220 caractères, sans slash initial ni saut de ligne, pour rester
une seule demande dans le chat actuel. `--help` et `--list` ne contactent ni Minecraft ni Ollama.

Scénarios disponibles :

- `craft_table` : quatre planches fournies ; obtenir une table de craft dans l'inventaire.
- `collect_two_logs` : inventaire vide, un chêne fixe ; gagner au moins deux bûches.
- `checks_axe_from_empty` : inventaire vide, forêt fixe ; obtenir une nouvelle hache en bois.
- `checks_existing_stock` : une hache déjà fournie ; la conserver sans production superflue.
- `checks_new_axe` : une hache déjà fournie et forêt fixe ; gagner une hache supplémentaire.
- `checks_additional_logs` : trois bûches déjà fournies et arbre fixe ; en gagner au moins deux.
  Ces oracles utilisent les inventaires observés, jamais les checks inventés par le planner.
  Vérifier aussi les traces pour la vraie opération de craft, l'absence de craft inutile, les recettes
  transmises et le phrasé bot/joueur : l'inventaire seul ne prouve pas ces propriétés.
  Les critères contradictoires/inconnus sont testés hors ligne avec faux LLM ; aucun test impossible
  n'est ajouté à la campagne. Ces quatre scénarios sont préparés, mais n'ont pas été lancés le 16 octobre.
- `collect_four_logs` : inventaire vide, trois chênes aux positions X/Z (5, 0), (-5, 4), (3, 9) ;
  gagner au moins quatre bûches. Les arbres contiennent chacun quatre blocs de tronc. Le bot peut
  récolter un seul arbre ou plusieurs ; casser les blocs sans ramasser leur loot ne suffit pas.
- `place_block_in_front` : une planche de chêne fournie ; la poser au sol juste devant la position
  initiale du bot. Il démarre face au sud (+Z), donc la cible est (0, surfaceY+1, 1), soit (0, -60, 1)
  par défaut. Le critère vérifie le passage air → `oak_planks` à cet endroit **et** la consommation
  d'un bloc d'inventaire. Tourner ou se déplacer ne déplace pas la cible ; jeter l'objet ne valide pas le test.
- `craft_wooden_pickaxe` : table posée à (3, surfaceY+1, 0), trois planches et deux bâtons fournis ;
  obtenir une pioche en bois et conserver la table en place. Isole le craft 3×3 de la récolte et de la pose de table.
- `craft_two_wooden_tools` : même table, six planches et quatre bâtons ; fabriquer une hache puis une
  pioche en bois, conserver les deux et la table. Délai de trois minutes. L'oracle vérifie les deux gains ;
  les traces permettent de contrôler l'ordre des crafts, qui n'est pas prouvé par l'inventaire final seul.
- `collect_cobblestone_from_mound` : une pioche en bois fournie, aucune autre ressource en inventaire ;
  miner et ramasser quatre cobblestones. Délai de trois minutes. La butte fixe occupe X=8..12/Z=5..9 :
  socle terre/herbe à surfaceY+1, neuf pierres exposées à surfaceY+2 au centre, avec une marche d'accès.
  La terre enterrée est posée sous couverture pour éviter une propagation d'herbe pendant la préparation.
  Réussite = gain d'au moins quatre cobblestones **et** quatre cellules de pierre devenues air.
- `craft_stone_pickaxe_from_world` : même butte et deux chênes fixes en (5,0) et (-5,4), inventaire vide,
  aucune table fournie. Demande une pioche en bois puis une pioche en pierre ; délai de cinq minutes.
  Réussite = inventaire initial vide, nouvelle pioche en pierre conservée et au moins trois pierres minées.
  Le craft intermédiaire, les recettes choisies et l'ordre des actions restent consultables dans les traces.
  Ces scénarios lisent les cellules du décor via le controller ; une cellule inconnue ne compte jamais comme minée.
- `craft_iron_pickaxe_from_world` : inventaire vide, trois chênes fixes en (5,0), (-5,4), (3,9)
  (12 bûches), butte terre/herbe avec 14 pierres, 4 minerais de charbon et 6 minerais de fer exposés.
  La butte occupe X=7..14/Z=4..9, avec une marche à surfaceY+1 et les ressources à surfaceY+2 ;
  toutes les ressources sont à moins de 16 blocs horizontalement du départ.
  Aucun outil, combustible, lingot, four ou table n'est fourni. Une seule demande :
  fabriquer une pioche en pierre, construire/utiliser un four, puis fabriquer une pioche en fer et
  conserver les deux pioches. Délai de dix minutes, surchargeable avec `--timeout`.
  Réussite = départ vide, deux pioches présentes, `use_furnace` réellement réussi, fenêtre fermée,
  et retrait observé d'au moins 1 bûche, 11 pierres, 1 minerai de charbon et 3 minerais de fer.
  La quantité de bois consommée n'impose pas de recette particulière : des bâtons peuvent aussi venir des feuilles.
  Une cellule remplacée après minage compte aussi ; une cellule inconnue ne compte pas.
  Le four peut rester posé : il n'est pas demandé de le récupérer. L'ordre précis des crafts
  se lit dans les traces, pas dans l'inventaire final. La recette `iron_pickaxe` est documentée dans
  la bibliothèque ; la cuisson passe par `use_furnace`, pas par une fausse recette de crafting.
  `collect_resource` peut maintenant obtenir bois/cobblestone, `coal` et `raw_iron`, avec sélection
  d'une pioche adaptée déjà disponible. Le planner doit prévoir les pioches et la cuisson séparément.
  Ce scénario a été ajouté avec validation hors ligne ; il reste à exécuter en jeu.
- `collect_dropped_logs` : quatre bûches au sol à (5.5, surfaceY+1, 0.5), sans arbre ; les ramasser.
  Le loot de test ne disparaît pas avec le temps. Sa disparition seule ne suffit pas : il faut gagner quatre bûches.
- `chest_withdraw` : lire un coffre avec quatre bûches, inventaire vide ; retirer exactement deux bûches et fermer le coffre.
- `chest_deposit` : lire un coffre vide, quatre bûches en inventaire ; en déposer exactement deux et fermer le coffre.
  Pour les deux tests, les variations des deux inventaires doivent être opposées et le coffre doit rester en place.
  La trace doit confirmer une lecture `get_chest_contents` réussie.
- `smelt_iron` : four vide à (3, surfaceY+1, 0), trois `raw_iron` et un `coal` fournis.
  Lire le four, cuire et récupérer trois lingots, puis fermer. Vérifie le gain, la consommation de minerai,
  le bloc intact, les contenus NBT sans minerai ni sortie restante et une lecture `get_furnace_contents` réussie.
  Délai de 300 secondes, cuisson incluse ; aucun test en jeu de four occupé.
- `navigate_around_wall` : mur de pierre de cinq blocs de large et trois de haut, centré en Z=3 ;
  se tenir sur le marqueur cobblestone au sol en (0, surfaceY, 6), mur intact.
- `navigate_with_scaffolding` : pilier de deux blocs en X=6/Z=0 avec sommet cobblestone, douze terres fournies ;
  se tenir sur le sommet sans détruire le pilier. Vérifie aussi une nouvelle terre posée autour du pilier et une
  consommation de terre. L'agent choisit ses actions ; le test ne force pas un tool ou un itinéraire particulier.
- `eat_food` : un steak fourni, faim réduite pendant la préparation ; le consommer et augmenter la faim.
  Aucun scénario de craft impossible/prérequis manquant n'est inclus.
- `build_small_shelter` : maison fixe 5×5×4, origine (5, surfaceY+1, 5), 55 planches, 25 cobblestone et
  une porte fournies. Une seule capability survival, sans LLM ni commandes OP du constructeur. Le controller
  contrôle 729 cellules : dessin entier (100 cellules dont 18 d'air et deux moitiés de porte), marge horizontale
  de deux blocs, sous-sol jusqu'à la bedrock, air au-dessus du toit. Les cinq propriétés de porte sont vérifiées.
  Le sol et la marge doivent rester intacts, sauf herbe devenue terre sous le plancher. Consommation exacte
  des matériaux, bot vivant au sol, verrou physique libre et fenêtre fermée sont aussi exigés.
  Cela ne prouve pas une absence de modification ailleurs dans le monde, ni le respect d'une demande par un LLM.
- `build_with_scaffolding` : pilier fixe de cinq blocs, cinq planches et 24 terres fournies, sans LLM.
  Contrôle 250 cellules : pilier, marge de deux blocs, sous-sol et air supérieur. Toute terre temporaire
  restante, destruction du sol, cellule inconnue ou bot resté en hauteur fait échouer la vérification.
  La récupération des drops de terre n'est pas exigée. Les traces `scaffold_*` montrent les accès utilisés.

Les scénarios supplémentaires sont répartis dans `InteractionScenarios.ts`, `NavigationScenarios.ts` et `BuildingScenarios.ts`,
réexportés par `scenarios.ts`. Les fixtures utilisent des positions fixes et s'adaptent à `surfaceY`.
Les agents et leurs prompts ne sont pas modifiés par ces scénarios.

Commencer par un scénario avec `--scenario ID`, puis ajouter `--repeat 5` pour comparer plusieurs essais.
À 300 secondes par essai, 60 essais pourraient prendre 5 h **hors préparation** s'ils atteignaient tous
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
9. Barrière IPC `settle` : détacher le chat, arrêter les producteurs et attendre la libération du verrou physique
   (10 s de grâce), sans déconnecter le bot. Puis `FinalObservation` attend deux observations connues identiques
   (blocs/propriétés, inventaires, fenêtre), avec délai de 3 s et intervalle de 100 ms. Le critère est revérifié.
   Une réussite provisoire peut être invalidée ; une réussite tardive ne promeut jamais un timeout ou un échec.
   Une cellule inconnue reste inconnue, jamais air. Échec de settlement/lecture finale = `error`, sauf timeout conservé.
10. Nettoyage indépendant : `stop` dans le chat, fermeture du processus et confirmation de départ du joueur
   par le controller avant le prochain reset. `settle` et fermeture sont idempotents.

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

L'IPC du worker transporte readiness, armement du chat, événements de workflow, observations, settlement et fermeture.
`TrialRuntime` adapte le workflow habituel ou `FixedBuildTrial` (uniquement dans les tests), sans nouveau mode d'agent de production.
La liste explicite de cellules est bornée à 4096, validée intégralement avant lecture, sans troncature.
`BlockObservations` expose nom et propriétés utiles (`facing`, `half`, `hinge`, `open`, `powered`).
Les campagnes lisent les blocs depuis les chunks reçus par le controller indépendant, pas le client qui construit.
L'IPC conserve aussi cette lecture pour les diagnostics ciblés du worker. Une cellule indisponible vaut `null`,
pas `air` ; la préparation attend leur disponibilité. Les mêmes positions sont relues et archivées pendant l'essai.
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
Les fixtures four déclarent `kind: "furnace"` et un contenu initial vide.
`furnaceInventory` vérifie séparément le bloc et les trois slots du four ; le parseur de coffre n'est pas détourné.
Le worker transmet aussi `successfulTools`, issu des événements `tool.completed` réussis, pour vérifier
les lectures explicitement demandées. Le verdict physique reste indépendant du rapport du modèle.
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
- `skills/`, `source/`, `working-tree.patch` : copie de référence du code, des skills, des fixtures Blueprint et changements locaux.
- `results.json` : essais et statistiques cumulés, consommables ultérieurement par une autre UI.
- `<essai>/scenario.json` : demande, délai, inventaire initial, profil de faim, coffres et drops prévus ;
  runner `workflow_llm` ou `fixed_build_no_llm` et dessin/origine fixes si présents.
- `<essai>/blueprints/` : store isolé contenant les blueprints réellement acceptés, consultables depuis le rapport.
- `<essai>/events.jsonl` : événements du lanceur et observations de l'inventaire/état/cellules/coffres/drops suivis.
- `<essai>/trace_<session>.jsonl` : requêtes LLM, réponses brutes et appels de tools de production.
- `<essai>/result.json` : verdict, critère et détails, observations initiale/finale, temps et statistiques.
  `finalAfterSettlement` indique une lecture finale confirmée ; `finalVerificationMs` distingue sa durée de celle de la demande.
  La section « Vérification finale indépendante » présente ces preuves et jusqu'à 20 écarts pour la maison,
  avec le nombre total d'écarts (le contrôle lui-même n'est pas tronqué).
- `<essai>/process.log`, `log_<session>.log`, `agent_summary_<session>.md` : sorties et checklist.
- `<essai>/landmarks.json` : mémoire de lieux isolée, conservée pour inspection.

Chaque ligne JSONL conserve `timestamp`, `event`, `data`.
Les événements `trial.observation` ont aussi un identifiant, l'instant de demande/réception relatif au
début de l'essai, et `afterWorkflowFinish` pour distinguer une lecture finale d'une requête plus ancienne.
`trial.final_observation` est la lecture connue/stable après arrêt ; `trial.final_observation_failed` explicite son échec.
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
Une modification de `src/`, `skills/`, `tests/e2e/` ou `tests/fixtures/blueprints/` pendant une campagne l'invalide et arrête la suite.
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

`npm.cmd run smoke:collect` vérifie la collecte physique sans LLM et sans reset global.
Il utilise `collect_test_bot` non OP et `test_controller` OP, près de (-35,-60,-35).
Il exige des cellules vides, prépare quatre bûches superposées et deux pierres puis teste :
stock initial 1 + demande 4 bûches, refus sans pioche, collecte de 2 cobblestones avec pioche et 2 dirt.
Les totaux finaux sont relus par NBT depuis le controller, indépendamment du bilan du collecteur.
Le test restaure ses cellules et les sources de terre prélevées, puis vide uniquement l'inventaire du bot de test.
Ne pas intervenir dans cette zone pendant l'essai. Les traces utilisent `collect.event` et `collect.smoke` ;
ce smoke écrit des traces JSONL, pas une campagne HTML.

Options de validation de la collecte :

- `npm.cmd run smoke:collect -- --terrain --edge-cases` : sans LLM, ajoute une bûche à Y+7 avec puis
  sans dirt initial, une butte, un creux, un obstacle, deux bûches pour une demande de trois (échec partiel
  attendu), et un stop 50 ms après le début d'un dig. Les fixtures fixes sont dans
  `tests/fixtures/collection/scenes.ts`. Inventaire NBT et cellules sont vérifiés par le controller.
  Ces fixtures ne font pas de reset global ; le harness restaure uniquement les cellules qu'il suit.
- `npm.cmd run smoke:collect -- --llm` : après la collecte déterministe de base, utilise le vrai LLM
  configuré et les prompts de production. Stock initial vide sauf 24 dirt d'accès, cinq troncs fixes
  de quatre bûches ; demande quatre bûches supplémentaires puis approvisionnement, craft et abri 5×5×4.
  Origine imposée (-26,-60,-26), deux cellules d'air superposées pour l'entrée, aucune porte.
  Un garde de test refuse un appel `build` hors origine/dimensions autorisées avant toute construction.
  Chaque demande est bornée à dix minutes. La vérification contrôle chaque cellule depuis le controller,
  le plancher/toit, l'air intérieur et l'entrée ; elle ne se fie pas à `build.ok` ou au texte du modèle.
  `collect.workflow_summary` donne modèle, durée, appels par agent/tool et erreurs ; les blueprints
  restent dans `logs/collection_workflow_<session>/`. Aucune campagne de répétitions n'est implicite.

`npm.cmd run smoke:architect` teste séparément le rôle de conception avec le LLM configuré et les noms
du registre Minecraft configuré. Aucun serveur Minecraft/controller n'est contacté. Le blueprint accepté
est sauvegardé puis relu, sans construction ; les soumissions rejetées ne deviennent pas des fichiers acceptés.
Le prompt de l'essai est dans `tests/fixtures/prompts/architect-request.md`, séparé du prompt de rôle.
Les traces sont celles du logger normal, pas un rapport de campagne. Un dessin valide peut encore être
inadapté à la demande ou inaccessible à la construction : cet essai ne prouve ni l'un ni l'autre.
`npm.cmd run smoke:build-workflow` teste maintenant les délégations réelles avec réponses LLM scriptées,
stock fourni et construction physique : demande de dessin sans modification, puis maison et checklist
vérifiées. Le bootstrap de production, les prompts, le store et l'Executor sont conservés ; seul le client
LLM est remplacé. Les observations indépendantes contrôlent aussi les propriétés des portes.
Il utilise le même coin et le même nettoyage que `smoke:doors`, et des traces JSONL, pas une campagne HTML.
Ce smoke scripté ne mesure ni les capacités du modèle réel ni l'approvisionnement : utiliser `smoke:collect -- --llm` pour cet essai distinct.
Le premier scénario `build_small_shelter` fournit maintenant le contrôle physique indépendant et le rapport HTML,
mais sans le workflow LLM. Il ne remplace pas le smoke des délégations.

Pour ajouter un scénario, définir un `Scenario` dans `scenarios.ts` avec demande, inventaire,
fixture bornée facultative, liste de blocs attendus et `verify(initial, current)`.
`expectedBlocks` décrit la fixture à vérifier avant l'essai ; `observeBlocks(config)` sélectionne,
si nécessaire, les cellules à suivre pendant l'essai. Les critères restent de petites fonctions
déterministes, basées sur l'inventaire, l'état du bot et ces observations explicites de blocs.
`containers(config)` décrit des coffres déjà présents dans la fixture et les items à y mettre ;
`drops(config)` décrit les piles au sol (position, item, count). Leur préparation et observation restent
exclusivement dans la couche de test/controller. `hungry: true` sélectionne le profil de faim décrit ci-dessus.
