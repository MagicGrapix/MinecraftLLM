# Plan — Fondations d'un Agent concurrent

> Statut : étapes 1 à 7 implémentées le 19 septembre 2026.
>
> Validation : build TypeScript strict et 23 tests réussis. Le test live du harness contre un serveur
> Minecraft reste à exécuter.
>
> Scope : étapes 1 à 7 préparant l'Agent, sans intégrer encore de LLM.
>
> Principe central : les actions Minecraft restent séquentielles, mais leur exécution est asynchrone
> par rapport à l'Agent. L'Agent peut observer, réfléchir et modifier les tâches en attente pendant
> qu'une capability est active.

## 1. Objectif

Faire évoluer la couche exécutive actuelle vers cette architecture :

```text
                      commandes non bloquantes
        ┌─────────┐  enqueue / pause / resume / step / abort
        │  Agent  │ ─────────────────────────────────────────┐
        └────▲────┘                                          │
             │ événements + snapshots                        ▼
             │                                  ┌────────────────────────┐
             └──────────────────────────────────│  ExecutionController   │
                                                │ mode + révision + pump │
                                                └───────────┬────────────┘
                                                            │
                                              ┌─────────────┴─────────────┐
                                              ▼                           ▼
                                      ExecutionQueue                  Executor
                                        tâches FIFO              une tâche à la fois
                                                                        │
                                                                        ▼
                                                                   Capabilities
                                                                        │
                                                                        ▼
                                                                    Minecraft

        WorldQueryRegistry : lectures immédiates autorisées pendant l'exécution
        SkillRegistry      : descriptions courtes disponibles
        SkillLoader        : charge les instructions complètes à la demande
```

L'appel qui démarre ou reprend la queue ne doit jamais attendre que les actions se terminent. Il
retourne immédiatement un accusé de réception. La fin d'une action est communiquée plus tard par un
événement.

## 2. Principes non négociables

1. Une seule capability physique est active à la fois en v1. `goto`, `dig`, `place`, etc. ne se
   disputent jamais simultanément le contrôle de Mineflayer.
2. L'Agent et l'action active sont concurrents. Une inférence ou une query peut avoir lieu pendant un
   déplacement ou un creusage.
3. L'Agent ne crée que des `TaskSpec`. `TaskFactory` reste propriétaire des IDs et timestamps.
4. Une tâche active est immuable. L'Agent peut uniquement l'interrompre. Il peut modifier librement
   les tâches encore en attente.
5. Les World Queries sont strictement en lecture seule et ne passent pas dans l'ExecutionQueue.
6. Les Skills sont du savoir textuel chargé dans le contexte. Ils ne sont ni des routines TypeScript,
   ni des actions cachées.
7. Les interfaces publiques restent sérialisables en JSON et ne révèlent aucun objet Mineflayer.
8. Toute décision asynchrone peut devenir obsolète. Les snapshots et mutations portent donc une
   révision vérifiable.

## 3. Sémantique du contrôleur

### Modes

```ts
export type ExecutionMode = "paused" | "draining" | "stepping";
```

- `paused` : aucune nouvelle tâche ne démarre. Une tâche déjà active peut finir normalement.
- `draining` : le contrôleur consomme automatiquement les tâches FIFO. Si la queue devient vide, le
  mode reste actif ; une tâche ajoutée plus tard démarre automatiquement.
- `stepping` : exactement une tâche est exécutée, puis le contrôleur repasse en `paused`.

Le contrôleur démarre en `paused`.

### Commandes

- `resume()` passe en `draining` et retourne immédiatement.
- `pause()` passe en `paused`. La tâche active n'est pas interrompue.
- `step()` est accepté uniquement lorsque le contrôleur est `paused` et sans tâche active. Il lance au
  plus une tâche et retourne immédiatement.
- `abortCurrent(reason)` passe d'abord en `paused`, puis interrompt la tâche active. Les tâches en
  attente sont conservées.
- `shutdown(reason)` est réservé au cycle de vie du programme : pause, interruption, vidage de la
  queue et fermeture définitive du contrôleur.

Cette séparation évite qu'un mot ambigu comme `stop` signifie parfois « pause », parfois « interruption
immédiate », parfois « suppression du plan ».

## 4. Étape 1 — Transformer l'Executor en exécuteur d'une tâche

### Changement

`Executor` ne possède plus `ExecutionQueue` et ne contient plus `start()`, `stop()` ou `drainQueue()`.
Son contrat principal devient :

```ts
export class Executor {
  get currentTask(): Task | null;

  execute(task: Task): Promise<TaskResult>;
  abortCurrent(reason?: string): boolean;
}
```

`execute()` conserve toutes les responsabilités déjà fiables :

- lookup dans `CapabilityRegistry` ;
- validation Zod ;
- timeout ;
- `AbortSignal` ;
- distinction `TIMEOUT` / `INTERRUPTED` / `INTERNAL_ERROR` ;
- aucune exception métier vers l'appelant.

Un second appel à `execute()` pendant une tâche active est refusé avec `BLOCKED` et les faits
`currentTaskId` / `requestedTaskId`. L'ExecutionController sera normalement l'unique appelant, mais
l'Executor protège quand même son invariant.

### Fichiers

- modifier `src/execution/Executor.ts` ;
- adapter `src/execution/Executor.test.ts` ;
- retirer les événements de queue de l'Executor : ils appartiendront au contrôleur.

### Validation

- succès d'une tâche ;
- input invalide ;
- timeout ;
- interruption ;
- exception imprévue ;
- refus de deux exécutions physiques concurrentes.

## 5. Étape 2 — Ajouter l'ExecutionController asynchrone

### Responsabilité

`ExecutionController` devient l'acteur qui possède :

- `ExecutionQueue` ;
- `TaskFactory` ;
- `Executor` ;
- le mode courant ;
- la boucle de consommation non bloquante ;
- le snapshot et sa révision.

API cible :

```ts
export class ExecutionController {
  enqueue(spec: TaskSpec, options?: MutationOptions): ControlResult;
  enqueueMany(specs: readonly TaskSpec[], options?: MutationOptions): ControlResult;

  resume(options?: MutationOptions): ControlResult;
  pause(options?: MutationOptions): ControlResult;
  step(options?: MutationOptions): ControlResult;
  abortCurrent(reason?: string, options?: MutationOptions): ControlResult;

  snapshot(): ExecutionSnapshot;
  subscribe(listener: ExecutionEventListener): () => void;
  shutdown(reason?: string): Promise<void>;
}
```

Toutes les commandes opérationnelles retournent immédiatement. Seul `shutdown()` peut attendre le
nettoyage final.

Le pump interne respecte ces invariants :

1. il n'appelle jamais `Executor.execute()` si une tâche est déjà active ;
2. il ne dépile rien en mode `paused` ;
3. après une tâche en mode `stepping`, il repasse en `paused` avant toute autre exécution ;
4. en mode `draining`, un nouvel `enqueue` réveille le pump même si la queue était vide ;
5. une erreur d'un listener ne casse jamais le contrôleur.

### Fichiers

- créer `src/execution/ExecutionController.ts` ;
- créer `src/execution/ExecutionController.test.ts` ;
- conserver `ExecutionQueue` comme structure FIFO simple.

## 6. Étape 3 — Modifier la queue pendant une action

### Opérations nécessaires

L'Agent doit pouvoir modifier uniquement le futur plan :

```ts
enqueue(spec)
enqueueMany(specs)
prepend(spec)
removePending(taskId)
replacePending(specs)
clearPending()
```

Les méthodes publiques du contrôleur acceptent des `TaskSpec`; elles passent toujours par
`TaskFactory`. Les méthodes internes de `ExecutionQueue` manipulent des `Task` matérialisées.

`replacePending()` est atomique : aucun état intermédiaire n'est observable. La tâche active n'est
jamais incluse dans le remplacement.

`prepend()` permet de placer une action urgente juste après la tâche active sans la faire passer devant
cette dernière. Pour une urgence immédiate, l'Agent utilise d'abord `abortCurrent()`.

### Concurrence JavaScript

Node.js exécute les mutations synchrones sur un seul event loop, mais une réponse LLM peut arriver
après plusieurs changements d'état. Chaque mutation accepte donc :

```ts
export interface MutationOptions {
  expectedRevision?: number;
}
```

Si la révision ne correspond plus, la commande est refusée avec `REVISION_CONFLICT`. L'Agent doit
relire un snapshot avant de recalculer sa décision.

### Modifications d'ExecutionQueue

- ajouter `prepend(task)` ;
- ajouter `remove(taskId)` ;
- ajouter `replace(tasks)` ;
- préserver `toArray()` comme copie défensive ;
- ne jamais exposer le tableau interne.

## 7. Étape 4 — Événements, snapshots et révisions

### Snapshot

```ts
export interface ExecutionSnapshot {
  readonly revision: number;
  readonly mode: ExecutionMode;
  readonly current: {
    readonly task: Task;
    readonly startedAt: number;
  } | null;
  readonly pending: readonly Task[];
  readonly shutdown: boolean;
}
```

La révision augmente après toute modification observable : mode, queue, démarrage, résultat,
interruption ou shutdown.

### Événements

```ts
export type ExecutionEvent =
  | { type: "mode_changed"; snapshot: ExecutionSnapshot }
  | { type: "queue_changed"; reason: string; snapshot: ExecutionSnapshot }
  | { type: "task_started"; task: Task; snapshot: ExecutionSnapshot }
  | {
      type: "task_finished";
      task: Task;
      result: TaskResult;
      snapshot: ExecutionSnapshot;
    }
  | { type: "queue_idle"; snapshot: ExecutionSnapshot }
  | { type: "shutdown"; snapshot: ExecutionSnapshot };
```

`queue_idle` signifie qu'aucune tâche n'est active ou en attente. Il ne force pas le mode à
`paused` : en `draining`, une tâche ajoutée ensuite pourra repartir immédiatement.

Les listeners sont des notifications rapides. Le contrôleur ne fait jamais `await` sur un listener.
Le futur Agent déposera les événements dans sa propre mailbox plutôt que de lancer une inférence
directement depuis le callback.

Les événements de progression fine (`path_update`, pourcentage de dig, etc.) sont hors scope de cette
phase. Ils pourront être ajoutés sans modifier les contrats fondamentaux.

## 8. Étape 5 — Tester avec un faux Agent, sans LLM

Le faux Agent est un rôle joué par les tests, pas une nouvelle abstraction de production. Il appelle
les commandes du contrôleur et réagit aux événements.

Scénarios obligatoires :

1. `resume()` retourne alors qu'une capability lente est encore active ;
2. une query ou un autre calcul peut s'exécuter pendant cette capability ;
3. une tâche ajoutée pendant l'exécution est consommée ensuite en mode `draining` ;
4. `pause()` laisse finir la tâche active mais conserve la suivante ;
5. `step()` exécute exactement une tâche ;
6. `replacePending()` ne change pas la tâche active ;
7. `abortCurrent()` produit `INTERRUPTED`, met le contrôleur en pause et conserve la queue ;
8. une mutation avec une ancienne révision produit `REVISION_CONFLICT` ;
9. l'ordre des événements est déterministe ;
10. un listener qui throw n'empêche pas l'exécution.

Le harness `src/main.ts` migre ensuite vers le contrôleur :

```text
connecter le runtime
→ créer le contrôleur
→ souscrire aux événements
→ enqueueMany(...)
→ resume() (retour immédiat)
→ garder le processus actif
```

Ce harness démontre que le processus principal reste disponible pendant que le bot marche ou creuse.

## 9. Étape 6 — Ajouter WorldQueryRegistry

### Pourquoi un registry

`WorldQueries` est aujourd'hui une interface TypeScript directe. Le futur modèle a besoin d'un catalogue
de queries nommées, décrites et validées comme les capabilities, mais exécutées immédiatement et sans
passer par la queue.

Contrats proposés :

```ts
export interface WorldQuery<Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  execute(input: Input, world: WorldQueries): Promise<QueryResult<Output>>;
}

export type QueryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: QueryError };
```

`WorldQueryRegistry.execute(name, input)` :

- valide l'input avec Zod ;
- transforme une query inconnue ou invalide en erreur structurée ;
- capture les exceptions imprévues ;
- ne touche jamais à l'ExecutionController ;
- peut être appelé pendant une capability active.

Premières queries exposées :

- `get_self` ;
- `get_inventory` ;
- `get_block` ;
- `find_nearest_blocks` ;
- `get_nearby_entities`.

Le registry expose aussi une description compacte (`name`, `description`) destinée plus tard au prompt.
La conversion Zod vers le format exact de tools du fournisseur LLM reste hors scope jusqu'à
l'intégration du modèle.

### Fichiers

```text
src/world/queries/WorldQuery.ts
src/world/queries/QueryResult.ts
src/world/queries/WorldQueryRegistry.ts
src/world/queries/defaultQueries.ts
src/world/queries/WorldQueryRegistry.test.ts
```

### Validation

- query valide ;
- query inconnue ;
- input invalide ;
- exception interne capturée ;
- query exécutée avec succès pendant une tâche lente.

## 10. Étape 7 — Définir les Skills textuels

### Définition retenue

Un Skill est une technique expliquée au modèle : quand l'utiliser, quelles observations demander,
quelles capabilities employer, comment traiter les erreurs et comment vérifier la réussite.

Un Skill ne possède aucune méthode `execute()` et ne modifie jamais directement la queue.

### Format

```text
skills/
  gather/
    SKILL.md
```

`SKILL.md` utilise un frontmatter validé :

```yaml
---
name: gather
description: Récolter une quantité donnée d'une ressource présente dans le monde.
required_capabilities:
  - goto
  - equip
  - dig
required_queries:
  - get_inventory
  - find_nearest_blocks
---
```

Le corps Markdown contient au minimum :

- quand utiliser le skill ;
- informations à obtenir avant d'agir ;
- stratégie recommandée ;
- gestion des `TaskError` probables ;
- condition de réussite vérifiable ;
- limites connues.

### Chargement progressif

```ts
interface SkillSummary {
  name: string;
  description: string;
}

interface LoadedSkill extends SkillSummary {
  requiredCapabilities: readonly string[];
  requiredQueries: readonly string[];
  instructions: string;
}
```

- `SkillRegistry.list()` retourne uniquement les résumés courts.
- `SkillLoader.load(name)` charge le texte complet à la demande.
- le loader refuse les chemins sortant de la racine `skills/` ;
- il vérifie que les capabilities et queries déclarées existent réellement ;
- aucune ressource ou script de Skill n'est exécuté dans cette phase.

Le premier Skill réel est `gather`. Il sert à valider le format, pas encore à piloter automatiquement
le bot puisqu'aucun LLM n'est branché dans les étapes 1 à 7.

### Fichiers

```text
src/skills/Skill.ts
src/skills/SkillRegistry.ts
src/skills/SkillLoader.ts
src/skills/SkillLoader.test.ts
skills/gather/SKILL.md
```

## 11. Arborescence après les étapes 1 à 7

```text
src/
  execution/
    ExecutionQueue.ts
    Executor.ts
    ExecutionController.ts
    Executor.test.ts
    ExecutionController.test.ts

  world/
    WorldQueries.ts
    MineflayerWorldQueries.ts
    queries/
      WorldQuery.ts
      QueryResult.ts
      WorldQueryRegistry.ts
      defaultQueries.ts
      WorldQueryRegistry.test.ts

  skills/
    Skill.ts
    SkillRegistry.ts
    SkillLoader.ts
    SkillLoader.test.ts

skills/
  gather/
    SKILL.md
```

## 12. Ordre d'implémentation et points de contrôle

Chaque étape doit compiler et passer les tests avant la suivante :

1. Executor unitaire ;
2. contrôleur avec modes ;
3. mutations de queue et révisions ;
4. événements et snapshots ;
5. tests de concurrence + migration du harness ;
6. queries exposables au modèle ;
7. format et loader de Skills.

Le script de test devra découvrir tous les fichiers `*.test.js` compilés, et non plus uniquement
`Executor.test.js`.

## 13. Definition of Done

Les étapes 1 à 7 sont terminées lorsque :

- `npm test` compile et exécute tous les tests ;
- `resume()`, `pause()`, `step()` et `abortCurrent()` respectent exactement leur contrat ;
- l'Agent simulé peut modifier la queue pendant une action lente ;
- aucune commande de contrôle n'attend la fin d'une capability ;
- un snapshot versionné permet de détecter une décision obsolète ;
- les cinq World Queries actuelles sont accessibles par un registry validé ;
- le Skill `gather` peut être listé sous forme courte puis chargé intégralement ;
- le loader détecte une capability ou query inexistante dans un manifest ;
- le harness Minecraft réel fonctionne encore avec `goto`, `equip` et `dig` ;
- le bot reste connecté après le scénario jusqu'à `Ctrl+C`.

### État de validation

- `npm test` découvre automatiquement tous les fichiers `*.test.js` compilés : **23/23 réussis** ;
- `npm run typecheck` réussit ;
- le script de développement `dev-give-items.ts` compile séparément ;
- la validation live Minecraft n'a pas été lancée automatiquement afin de ne pas modifier un monde
  sans serveur de test explicitement sélectionné.

## 14. Hors scope

Ces éléments viendront après les sept étapes :

- fournisseur LLM (Ollama, llama.cpp ou autre) ;
- boucle de réflexion et mailbox de l'Agent réel ;
- `AgentDecision` final et conversion en structured output ;
- sélection automatique des Skills ;
- `GoalStack` ;
- Supervisor et réflexes de survie ;
- WorldMemory ;
- événements de progression à haute fréquence ;
- exécution simultanée de plusieurs capabilities physiques ;
- nouvelles capabilities comme `pickup`, `craft`, `use_block`, `transfer_item` ou `attack`.

L'étape suivante après ce plan sera la boucle Agent asynchrone : elle consommera les événements du
contrôleur dans une mailbox, chargera les Skills pertinents, appellera les World Queries et émettra des
commandes non bloquantes vers l'ExecutionController.
