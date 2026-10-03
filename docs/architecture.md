# Architecture actuelle

## Parcours d'une demande

```text
MinecraftChatAdapter
  -> WorkflowAgent / coordinator
       -> reply : réponse au joueur
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
- `CoordinatorTools.ts` et `ToolCatalogBuilder.ts` définissent les catalogues propres à chaque rôle.
  Le coordinateur possède les outils de workflow et les lectures du monde, pas les capacités physiques.
  Le bootstrap transmet aussi le catalogue de l'actionneur au planner comme documentation dans son system,
  sans tools appelables. Les descriptions et schémas restent issus des mêmes registres.
- `execution/ToolCallJournal.ts` est partagé par les deux agents. Il attribue les numéros d'appels
  et conserve les inventaires avant/après des capabilities et de `run_step`. La query
  `get_inventory_diff_after` consulte ces données sans dépendre de la conversation LLM.
  Le bootstrap injecte le même journal dans les deux agents et le registre de queries.
- `ActionContextBuilder.ts` et `WorldContextFormatter.ts` préparent les données lisibles.
  `TaskContextFormatter.ts` partage la vue objectif/plan/étape/rapports entre coordinateur et actionneur.
  Les rapports y sont compacts ; leurs TaskResults complets restent dans l'état et les traces.
- `MessageHistory.ts` conserve les échanges complets et la demande active ;
  `ContextCompactor.ts` décide quand faire un résumé. Voir [les règles de contexte](agent-workflow.md).
- `Executor.ts` valide les entrées, applique timeout/annulation et garde le verrou physique.
  `TaskResult` est un succès ou une erreur structurée ; le texte du modèle n'est pas une preuve d'exécution.
- `capabilities/Craft.ts` expose `craft_from_inventory_2x2` et `craft_from_table_3x3`.
  Deux schémas objets distincts fixent la station en interne et partagent le même moteur de recettes,
  annulation et vérification. L'ancien tool `craft` n'est plus exposé. Voir [les arguments](tools.md#crafting).
- `src/world/` traduit les observations Mineflayer. `WorldQueries.getNearbyEntities` est conservée
  comme API interne, notamment pour `get_dropped_items`, sans tool générique exposé au LLM.
- `src/llm/` traduit nos messages en Chat Completions. La couche agents ne dépend pas du SDK OpenAI.
- `src/debug/` contient le serveur local, les snapshots et leur projection UI.
- `src/devworld/` est un processus séparé : WorldBuilder -> WorldPlan -> CommandExecutor -> bot OP.
  Il ne passe jamais par les tools de l'agent.
- `tests/e2e/` orchestre les campagnes Minecraft : controller réutilisé, bot enfant neuf par essai,
  consignes dans le chat, observations IPC, critères déterministes et rapport HTML persistant.
  Voir [scénarios de test](scenario-testing.md). Les campagnes sont lancées explicitement, hors `npm test`.

## Ajouter ou changer un composant

Pour une capability : implémenter `Capability`, enregistrer le schéma et sa description dans
`createCapabilities.ts`, tester succès/erreurs/timeout. Attendre les opérations physiques ;
si une opération survit au retour de la méthode, l'enregistrer avec `deferCancellationUntil`.

Pour une query : implémenter `WorldQuery`, l'enregistrer dans `defaultQueries.ts`, tester les valeurs
inconnues et les limites. Une query ne modifie pas le monde.
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

`npm.cmd test` vérifie code, scripts et tests. Les smoke restent séparés car ils contactent Ollama.
Ne pas remettre des anciens agents ou prompts de test dans `src/` ou `prompts/`.
Actualiser la page concernée lorsque ces frontières changent ; les détails locaux restent en commentaires.
