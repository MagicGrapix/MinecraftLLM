# Architecture actuelle

## Parcours d'une demande

```text
MinecraftChatAdapter
  -> WorkflowAgent / coordinator
       -> reply : réponse au joueur
       -> ArchitectAgent : dessin privé, validation/sauvegarde, référence et facture
       -> planner : JSON de checklist, un seul appel logique
       -> ActionRunner / ActionAgent : une étape, conversation privée
            -> WorldQueryRegistry : observations
            -> AgentToolBridge -> TaskFactory -> Executor -> Capability -> Mineflayer
            -> finish_step : rapport + TaskResults réels
       -> complete_step : coche la checklist après examen du rapport
```

Les appels sont attendus séquentiellement. L'actionneur ne réfléchit pas pendant une capability.
Il a un seul prompt et aucun mode planning/review. Une nouvelle délégation commence avec un contexte neuf.
Le planner ne possède pas de boucle d'outils. Le coordinateur garde sa conversation entre les demandes,
mais rien n'est rechargé comme mémoire d'agent après redémarrage.

## Responsabilités et fichiers

- `src/bootstrap/createAgentRuntime.ts` assemble clients, queries, capabilities, agents, chat et inspecteur.
- `WorkflowAgent.ts` dirige les délégations et garde `WorkflowState`. `ActionRunner` dans `ActionTypes.ts`
  est sa frontière avec l'actionneur : un changement d'implémentation ne demande pas de réécrire le coordinateur.
  `WorkflowState` conserve le plan, l'étape sélectionnée et le dernier rapport de chaque étape du plan courant.
  Il conserve aussi la référence Blueprint sélectionnée, sa facture calculée et la consigne de conception.
  `ConstructionContext.ts` la présente aux trois rôles, indépendamment de l'historique compactable.
- `CoordinatorTools.ts` et `ToolCatalogBuilder.ts` définissent les catalogues propres à chaque rôle.
  Le coordinateur possède les outils de workflow et les lectures du monde, pas les capacités physiques.
  Le bootstrap transmet aussi le catalogue de l'actionneur au planner comme documentation dans son system,
  sans tools appelables. Les descriptions et schémas restent issus des mêmes registres.
- `execution/ToolCallJournal.ts` est partagé par le coordinateur, l'Architect et l'actionneur. Il attribue les numéros d'appels
  et conserve les inventaires avant/après des capabilities et de `run_step`. La query
  `get_inventory_diff_after` consulte ces données sans dépendre de la conversation LLM.
  Les tools Architect et `ask_architect` sont numérotés mais ne capturent pas l'inventaire (aucune action physique).
- `ActionContextBuilder.ts` et `WorldContextFormatter.ts` préparent les données lisibles.
  `TaskContextFormatter.ts` partage la vue objectif/plan/étape/rapports entre coordinateur et actionneur.
  Les rapports y sont compacts ; leurs TaskResults complets restent dans l'état et les traces.
- `MessageHistory.ts` conserve les échanges complets et la demande active ;
  `ContextCompactor.ts` décide quand faire un résumé. Voir [les règles de contexte](agent-workflow.md).
  `llm/InputBudget.ts` impose aussi le plafond de 20k à chaque appel, retries et résumés compris.
  `BoundedSummary.ts` traite les gros historiques par fragments successifs sans dépasser ce plafond.
- `Executor.ts` valide les entrées, applique timeout/annulation et garde le verrou physique.
  `TaskResult` est un succès ou une erreur structurée ; le texte du modèle n'est pas une preuve d'exécution.
- `capabilities/Craft.ts` expose `craft_from_inventory_2x2` et `craft_from_table_3x3`.
  Deux schémas objets distincts fixent la station en interne et partagent le même moteur de recettes,
  annulation et vérification. L'ancien tool `craft` n'est plus exposé. Voir [les arguments](tools.md#crafting).
- `src/world/` traduit les observations Mineflayer. `WorldQueries.getNearbyEntities` est conservée
  comme API interne, notamment pour `get_dropped_items`, sans tool générique exposé au LLM.
  `findNearestBlocks` retourne une Promise : `BlockSearch.ts` parcourt les cellules chargées par lots
  coopératifs. `WorldQueryRegistry` applique les délais, annulations et limites de réponse aux deux agents.
- `src/llm/` traduit nos messages en Chat Completions. La couche agents ne dépend pas du SDK OpenAI.
- `src/debug/` contient le serveur local, les snapshots et leur projection UI.
- `src/devworld/` est un processus séparé : WorldBuilder -> WorldPlan -> CommandExecutor -> bot OP.
  Il ne passe jamais par les tools de l'agent.
- `src/building/` fournit le format Blueprint, sa validation/compilation, son store JSON immuable et le Builder déterministe de cubes et portes en chêne.
  `world/MaterialCatalog.ts` résout les noms et suggère des alternatives à partir d'un registre de version injecté.
  La capability `build` construit une référence sauvegardée sous un seul verrou de l'Executor.
  `MineflayerBuildOperations` réutilise goto/equip/place sous le même contexte, sans rappeler l'Executor.
  `BuildVerification` contrôle terrain/stock/cellules ; `BuildPlacement` choisit les faces et postures ;
  `BuildExit` écarte les postures sans retour conservateur au sol après la prochaine pose.
  `BlueprintDoors` développe une porte en deux cellules et un item ; `BuildDoor`/`PlaceBuildDoor` assurent sa pose orientée et la confirmation des deux moitiés.
  `GotoMovements` reconnaît les formes des portes déjà ouvertes ; l'ouverture reste une action `use_block` séparée.
  `agent/ArchitectAgent.ts` fournit maintenant une délégation isolée : `lookup_material` puis
  `submit_blueprint`, avec corrections et retour automatique après validation/sauvegarde.
  `ArchitectTools.ts` ne reçoit ni runtime, ni Executor, ni controller : il ne peut pas construire.
  Le bootstrap l'assemble maintenant avec le même client LLM et le registre de la connexion Minecraft.
  `ask_architect` sélectionne un dessin accepté avant le planner. `lookup_material` partage son schéma
  et sa logique dans `world/queries/LookupMaterial.ts`, réutilisés par l'Architect et les queries existantes.
  Le coordinateur ne reçoit ni `build` ni `submit_blueprint`. L'actionneur refuse un `build` sans référence
  sélectionnée pour la demande ou visant un ancien dessin. Le Builder reste utilisable hors agents pour les smokes.
  Voir [Blueprints](blueprints.md) pour les contrats et limites réellement disponibles.
- `tests/e2e/` orchestre les campagnes Minecraft : controller réutilisé, bot enfant neuf par essai,
  consignes dans le chat, observations IPC, critères déterministes et rapport HTML persistant.
  Les observations de coffres/drops sont ajoutées par le controller ; les lectures NBT OP sont isolées dans
  `tests/e2e/BlockNbtReader.ts` et ne donnent aucun pouvoir supplémentaire au bot testé.
  `TrialRuntime` adapte le workflow ou un essai physique `FixedBuildTrial` sans LLM. `BuildingScenarios.ts`
  vérifie une maison fixe et sa marge depuis le controller (pas depuis le rapport du constructeur).
  `FinalObservation` s'exécute après arrêt des producteurs et libération du verrou, avant déconnexion ;
  les blueprints acceptés restent dans le store propre à chaque essai et sont liés au rapport HTML.
  Voir [scénarios de test](scenario-testing.md). Les campagnes sont lancées explicitement, hors `npm test`.

## Ajouter ou changer un composant

Pour une capability : implémenter `Capability`, enregistrer le schéma et sa description dans
`createCapabilities.ts`, tester succès/erreurs/timeout. Attendre les opérations physiques ;
si une opération survit au retour de la méthode, l'enregistrer avec `deferCancellationUntil`.
Une capability composite peut définir `defaultTimeoutMs` : le bridge le copie dans le TaskSpec,
et l'Executor l'applique aussi pour les appels directs. Un timeout explicite du TaskSpec est prioritaire.
`reportProgress` conserve un petit bilan copié dans les erreurs d'interruption/timeout ; il ne libère jamais le verrou.

Pour une query : implémenter `WorldQuery`, l'enregistrer dans `defaultQueries.ts`, tester les valeurs
inconnues et les limites. Une query ne modifie pas le monde.
Le contexte d'exécution fournit `signal` et `deadline` : une boucle longue doit rendre la main et les vérifier.
Une Promise entourant un calcul synchrone ne le rend pas interruptible. Les noms des tools du coordinateur
(`reply`, `ask_planner`, etc.) sont réservés ; une collision fait échouer la construction du catalogue.
Le bootstrap fige ensuite les registres de queries et capabilities : un ajout tardif est refusé pour éviter
un désaccord entre les schémas envoyés au LLM et le dispatch réel. Ajouter les tools avant l'assemblage.
Les recherches de noms doivent vérifier le registre de la version Minecraft avec `isKnownName` :
une requête invalide ne retourne jamais un succès vide. Les erreurs de schéma détaillées utilisent
`shared/ToolArgumentFeedback.ts`, commun aux agents et au registre de queries.

Pour une évolution d'agent : conserver la frontière `ActionDelegation -> DelegatedActionReport`.
Adapter les tests de protocole et le contexte envoyé, pas seulement les phrases du prompt.
Les descriptions et schémas des outils appelables voyagent dans le champ `tools` du LLM.
Le planner en reçoit une référence textuelle dans son system. Le World Context reste réservé aux observations.

Pour une carte debug : ajouter les données dans `InspectorTypes`, puis la présentation dans
`InspectorPresentation.ts` et le rendu dans `src/debug/ui/`. La projection UI ne transforme pas
la requête envoyée au modèle. Garder les sélections manuelles stables pendant le polling.

## Entretien

`runtime/NavigationOperations.ts` suit les opérations physiques internes de pathfinder pendant `goto`.
Les méthodes Mineflayer sont protégées temporairement sous le verrou de l'Executor, puis restaurées après
terminaison des promesses et de leurs continuations. Cet adaptateur est lié à pathfinder 2.4.x : revoir
les chaînes equip/dig/place lors d'une mise à jour de dépendance.

`ContainerSessionManager` invalide une session à la fermeture serveur, à la mort, au respawn ou à la
déconnexion, et recoupe la fenêtre courante à la lecture. Sa session opaque est exposée dans le World
Context de l'actionneur pour une délégation suivante. Le runtime ferme la session et détache ses listeners.

`runtime/cleanup.ts` tente toutes les étapes de fermeture même après une erreur ou un timeout
(10 secondes par étape). Les erreurs sont regroupées après les tentatives, y compris la déconnexion.
Le shutdown est idempotent ; il ne lance pas une deuxième série de libérations.

`npm.cmd test` vérifie code, scripts et tests. Les smoke restent séparés car ils contactent Minecraft ou Ollama.
Ne pas remettre des anciens agents ou prompts de test dans `src/` ou `prompts/`.
Actualiser la page concernée lorsque ces frontières changent ; les détails locaux restent en commentaires.

## Travaux planifiés

Le [plan Blueprint / Architect / Builder](plans/blueprint-builder.md) suit cette évolution par lots.
Seuls les lots cochés sont livrés ; les sections ci-dessus et [les contrats Blueprint](blueprints.md) décrivent le comportement actuel.
