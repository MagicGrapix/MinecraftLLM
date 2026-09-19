# Plan — Couche exécutive (Capabilities / Tasks / Executor)

> Scope de ce document : **uniquement la partie exécutive** (ce qui exécute des tâches sur Mineflayer).
> Hors scope pour l'instant : Agent/LLM, Planner, Skills, GoalStack, Behavior/Supervisor, WorldMemory.
> Ces parties viendront dans un `02-agent-layer.md` une fois la colonne vertébrale exécutive stable.
>
> **État au 19 septembre 2026 :** implémentation terminée, compilation stricte et 5 tests exécutifs
> validés. Le harness a également été validé contre le serveur Minecraft 1.21.11 : connexion, `goto`,
> erreur structurée `MISSING_ITEM`, poursuite de la queue et `dig` réussis.

## 1. État initial

Fichiers actuels (`src/`) : `BotManager.ts`, `Activity.ts`, `Behavior.ts`, `Context.ts`, `Thoughts.ts`,
`actions.ts`, `types.ts`, `utils.ts`, `Logger.ts`, `main.ts`.

Constats :

- `BotManager.ts` fait trop de choses : connexion au bot, pathfinder, `actionsQueue` (FIFO maison),
  ET une classe `Action` abstraite qui réimplémente ~120 événements Mineflayer (`chat`, `entityMoved`,
  `pistonMove`, ...) pour pouvoir les override au cas par cas, ET un mini-langage `ActionSequence`
  (`.do().doIf().goto().label().switch().wait().exec()`) qui réinvente un interpréteur.
- `actions.ts` contient les vraies briques utiles (`SelectItemAction` → equip, `PlaceBlockAction`,
  `ClearInventoryAction`, `GiveItemsAction`) mais elles `resolve()/reject(string)` — les échecs sont
  des strings non structurées, pas exploitables par un LLM.
- `Activity.ts`, `Behavior.ts`, `Context.ts`, `Thoughts.ts` sont des stubs vides ou juste des notes de
  design en commentaires (utiles comme idées, mais rien d'exécutable).
- Les imports mélangent la casse (`./Types` vs `types.ts`, `./Utils` vs `utils.ts`, `"BotManager"` sans
  chemin relatif dans `Activity.ts`) — ça ne marche que parce que Windows est case-insensitive. Sur une
  autre plateforme (CI Linux, Docker) ça casse.
- `tsconfig.json` a un `paths: { "*": ["./src/*"] }` sans `baseUrl` : probablement sans effet réel.
- Pas de `node_modules` installé, pas de script `dev`/`build` dans `package.json`.

Conclusion : on ne "patch" pas ce code, on le **remplace** par la nouvelle couche exécutive, en
récupérant ce qui a de la valeur (la logique métier de `equip`/`place`/`clear inventory`, les helpers
d'inventaire de `utils.ts`, `Logger.ts`, `types.ts`).

## 2. Vocabulaire (rappel)

- **Capability** : primitive déterministe exécutable (`goto`, `dig`, `place`, `equip`, `drop`, ...).
- **TaskSpec** : demande d'exécution sérialisable (`capability`, `input`, `timeoutMs?`). C'est le seul
  format que produira le futur LLM.
- **Task** : `TaskSpec` matérialisée par le système avec ses métadonnées internes (`id`, `createdAt`).
- **TaskFactory** : transforme les `TaskSpec` en `Task`. Le LLM ne choisit jamais les identifiants ni
  les timestamps.
- **TaskResult** : `{ ok: true, value }` ou `{ ok: false, error: TaskError }` — jamais d'exception pour
  un échec "normal" (bloc introuvable, chemin bloqué, etc).
- **ExecutionQueue** : FIFO de `Task`, alimentée pour l'instant à la main (plus tard par l'Agent).
- **Executor** : dépile la queue et exécute les tasks **séquentiellement**, un `AbortSignal` par task.
- **WorldQueries** : lecture seule de l'état du monde (position, inventaire, blocs/entités proches).
  Ce n'est pas une capability : ça ne fait rien physiquement, ça répond juste à une question.

Tous les contrats publics (`TaskSpec`, inputs/outputs de capabilities, `TaskResult`, types de
`WorldQueries`) sont du JSON pur. Les classes Mineflayer (`Vec3`, `Block`, `Entity`, etc.) ne traversent
jamais cette frontière. Tout ce qui est au-dessus de `capabilities/` ignore Mineflayer. Seuls
`capabilities/`, `runtime/` et l'adaptateur concret `MineflayerWorldQueries` peuvent connaître ses
objets.

## 3. Architecture cible (scope exécutif)

```
   (main.ts = harness manuel pour l'instant, Agent plus tard)
                       │
                 liste de TaskSpec
                       │
              ┌────────▼────────┐
              │   TaskFactory   │   id + createdAt
              └────────┬────────┘
                       │ Task
                       │
              ┌────────▼────────┐
              │  ExecutionQueue │   FIFO
              └────────┬────────┘
                       │ dequeue séquentiel
              ┌────────▼────────┐
              │     Executor    │   validation Zod, AbortSignal, timeout
              └────────┬────────┘
                       │ lookup par nom
              ┌────────▼──────────┐
              │ CapabilityRegistry│
              └────────┬──────────┘
                       │
        ┌─────────┬────┴────┬─────────┐
        │         │         │         │
      Goto       Dig      Equip     Place   ...
        │         │         │         │
        └─────────┴────┬────┴─────────┘
                       │
              ┌────────▼────────┐
              │ MinecraftRuntime │  (bot + pathfinder init)
              └────────┬────────┘
                       │
                  Mineflayer
                       │
                   Minecraft

   WorldQueries (lecture seule : position, inventaire, blocs proches, entités proches)
   → utilisé par le harness pour construire les `input` JSON des TaskSpec
```

## 4. Arborescence cible

```
src/
  shared/
    types.ts                // Position et autres contrats JSON transverses
    helper.ts               // utilitaires généraux (timeout/cancellation), selon les conventions du projet

  runtime/
    MinecraftRuntime.ts     // connexion bot + pathfinder, remplace la partie "connexion" de BotManager
    PositionAdapter.ts      // conversion privée Position ↔ Vec3

  world/
    WorldQueries.ts         // contrat read-only en JSON pur
    MineflayerWorldQueries.ts // implémentation du contrat sur Mineflayer
    types.ts                // BlockInfo, EntityInfo, SelfState, InventoryState

  capabilities/
    Capability.ts           // interface Capability<I, O> + ExecutionContext
    CapabilityRegistry.ts
    Goto.ts
    Dig.ts
    Place.ts
    Equip.ts
    Drop.ts

  execution/
    Task.ts
    TaskFactory.ts
    TaskResult.ts            // TaskError, success(), failure()
    ExecutionQueue.ts
    Executor.ts
    Executor.test.ts         // validation, timeout, interruption, crash

  Logger.ts                  // conservé tel quel
  config.ts                   // ex-types.ts : mcData, constantes (timeouts...)
  main.ts                      // harness manuel de test
```

Convention conservée : dossiers en minuscules, fichiers de classes/interfaces en PascalCase (cohérent
avec l'existant `BotManager.ts`, `Logger.ts`).

## 5. Interfaces clés (proposées)

### `execution/TaskResult.ts`

```typescript
export type TaskErrorCode =
  | "TARGET_NOT_FOUND"
  | "NO_PATH"
  | "OUT_OF_REACH"
  | "MISSING_ITEM"
  | "BLOCKED"
  | "TIMEOUT"
  | "WORLD_CHANGED"
  | "INTERRUPTED"
  | "INVALID_ARGUMENT"
  | "INTERNAL_ERROR";

export interface TaskError {
  code: TaskErrorCode;
  message: string;
  retryable: boolean;
  facts?: Record<string, unknown>;
}

export type TaskResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: TaskError };

export function success<T>(value: T): TaskResult<T> {
  return { ok: true, value };
}

export function failure<T = never>(
  code: TaskErrorCode,
  message: string,
  opts?: Partial<Pick<TaskError, "retryable" | "facts">>
): TaskResult<T> {
  return {
    ok: false,
    error: { code, message, retryable: opts?.retryable ?? false, facts: opts?.facts },
  };
}
```

### `shared/types.ts`

```typescript
export interface Position {
  x: number;
  y: number;
  z: number;
}
```

`Position` est un DTO JSON, pas un alias de `Vec3`. Les conversions `Position ↔ Vec3` restent des
détails privés de l'adaptateur Mineflayer dans `runtime/` ou des capabilities concernées.

### `execution/Task.ts` et `execution/TaskFactory.ts`

```typescript
export interface TaskSpec<Input = unknown> {
  capability: string;
  input: Input;
  timeoutMs?: number;
}

export interface Task<Input = unknown> extends TaskSpec<Input> {
  id: string;
  createdAt: number;
}

import { randomUUID } from "node:crypto";

export class TaskFactory {
  create<Input>(spec: TaskSpec<Input>): Task<Input> {
    return {
      ...spec,
      id: randomUUID(),
      createdAt: Date.now(),
    };
  }

  createMany(specs: readonly TaskSpec[]): Task[] {
    return specs.map((spec) => this.create(spec));
  }
}
```

### `capabilities/Capability.ts`

```typescript
import { z } from "zod";
import type { MinecraftRuntime } from "../runtime/MinecraftRuntime";
import type { WorldQueries } from "../world/WorldQueries";
import type { TaskResult } from "../execution/TaskResult";

export interface ExecutionContext {
  runtime: MinecraftRuntime;
  world: WorldQueries;
  signal: AbortSignal;
}

export interface Capability<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly inputSchema: z.ZodType<Input>;
  execute(input: Input, ctx: ExecutionContext): Promise<TaskResult<Output>>;
}
```

Chaque capability définit un schéma strict. Par exemple, les coordonnées reçues sont des nombres JSON
finis ; les positions de blocs exigent des entiers lorsque c'est pertinent. L'`Executor` appelle
`inputSchema.safeParse(task.input)` et retourne `INVALID_ARGUMENT` avec les issues Zod avant tout appel
à Mineflayer. Le `any` éventuellement nécessaire pour effacer les génériques à l'intérieur du registry
reste un détail d'implémentation ; il ne constitue jamais une confiance accordée à l'input runtime.

### `capabilities/CapabilityRegistry.ts`

```typescript
export class CapabilityRegistry {
  private capabilities = new Map<string, Capability<any, any>>();

  register(capability: Capability<any, any>): void {
    if (this.capabilities.has(capability.name)) {
      throw new Error(`Capability "${capability.name}" already registered.`);
    }
    this.capabilities.set(capability.name, capability);
  }

  get(name: string): Capability<any, any> | undefined {
    return this.capabilities.get(name);
  }

  list(): string[] {
    return [...this.capabilities.keys()];
  }
}
```

### `execution/ExecutionQueue.ts`

```typescript
export class ExecutionQueue {
  private items: Task[] = [];

  enqueue(task: Task): void {
    this.items.push(task);
  }

  enqueueMany(tasks: readonly Task[]): void {
    this.items.push(...tasks);
  }

  dequeue(): Task | undefined {
    return this.items.shift();
  }

  peek(): Task | undefined {
    return this.items[0];
  }

  clear(): void {
    this.items = [];
  }

  toArray(): readonly Task[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }
}
```

`toArray()` retourne une copie pour empêcher un appelant de muter la FIFO hors de son API. Pas de
priorité ni de LIFO en v1.

### `execution/Executor.ts` (esquisse)

```typescript
export type TaskEvent =
  | { type: "started"; task: Task }
  | { type: "finished"; task: Task; result: TaskResult };

type TaskCancellation =
  | { kind: "timeout"; reason: string }
  | { kind: "interrupted"; reason: string };

interface CurrentExecution {
  controller: AbortController;
  cancellation: TaskCancellation | null;
}

export class Executor {
  private running = false;
  private currentExecution: CurrentExecution | null = null;

  constructor(
    private queue: ExecutionQueue,
    private registry: CapabilityRegistry,
    private runtime: MinecraftRuntime,
    private world: WorldQueries,
    private defaultTimeoutMs: number,
    private onEvent: (event: TaskEvent) => void
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abortCurrent("Executor stopped.");
  }

  /** Pour le futur Supervisor (réflexes) : interrompt la task en cours. */
  abortCurrent(reason?: string): void {
    const current = this.currentExecution;
    if (!current || current.cancellation) return;

    current.cancellation = {
      kind: "interrupted",
      reason: reason ?? "Task interrupted.",
    };
    current.controller.abort(current.cancellation);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const task = this.queue.dequeue();
      if (!task) {
        await sleep(50); // ou event-driven via un EventEmitter "enqueued"
        continue;
      }

      this.onEvent({ type: "started", task });
      const result = await this.runTask(task);
      this.onEvent({ type: "finished", task, result });
    }
  }

  private async runTask(task: Task): Promise<TaskResult> {
    const capability = this.registry.get(task.capability);
    if (!capability) {
      return failure("INVALID_ARGUMENT", `Unknown capability "${task.capability}".`);
    }

    const parsed = capability.inputSchema.safeParse(task.input);
    if (!parsed.success) {
      return failure("INVALID_ARGUMENT", `Invalid input for "${task.capability}".`, {
        facts: { issues: parsed.error.issues },
      });
    }

    const execution: CurrentExecution = {
      controller: new AbortController(),
      cancellation: null,
    };
    this.currentExecution = execution;

    const ctx: ExecutionContext = {
      runtime: this.runtime,
      world: this.world,
      signal: execution.controller.signal,
    };

    try {
      return await runWithCancellation(
        capability.execute(parsed.data, ctx),
        execution,
        task.timeoutMs ?? this.defaultTimeoutMs
      );
    } catch (err) {
      if (execution.cancellation?.kind === "timeout") {
        return failure("TIMEOUT", execution.cancellation.reason, { retryable: true });
      }
      if (execution.cancellation?.kind === "interrupted") {
        return failure("INTERRUPTED", execution.cancellation.reason, { retryable: true });
      }

      // Seul chemin pour une vraie exception imprévue (bug, crash Mineflayer, etc).
      return failure("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    } finally {
      this.currentExecution = null;
    }
  }
}
```

Points importants :
- L'Executor **ne throw jamais** vers l'appelant : `runTask` catch tout et retourne un `TaskResult`.
- Un seul `AbortController` actif à la fois (cohérent avec "une task à la fois").
- `runWithCancellation` (utilitaire général dans `shared/helper.ts`) fait courir l'exécution contre une
  promesse d'annulation et arme le timeout. Il ne se contente pas d'appeler `abort()` : une capability
  qui tarde à observer le signal ne doit pas bloquer indéfiniment l'Executor.
- La cause d'annulation est enregistrée **avant** `controller.abort()`. Un `AbortError` provenant de
  Mineflayer/Pathfinder est donc remappé sans ambiguïté sur `TIMEOUT` ou `INTERRUPTED`, jamais sur
  `INTERNAL_ERROR`.
- Si une capability termine normalement avant une annulation et retourne `NO_PATH`, son résultat est
  conservé tel quel.
- `onEvent` sert de point d'extension pour logguer maintenant, et pour l'Agent plus tard (observer les
  résultats sans coupler l'Executor à l'Agent).

### Contrat exact des issues d'exécution

| Cause | Résultat obligatoire |
|---|---|
| Le schéma Zod refuse l'input | `INVALID_ARGUMENT` |
| Le délai de la task expire | `TIMEOUT` |
| `abortCurrent()` ou `stop()` interrompt la task | `INTERRUPTED` |
| La capability constate qu'aucun chemin n'existe | `NO_PATH` |
| La capability constate un autre échec attendu | Son `TaskError` métier (`MISSING_ITEM`, `BLOCKED`, etc.) |
| Une exception imprévue remonte sans cause d'annulation | `INTERNAL_ERROR` |

## 6. Capacités v1 (celles qu'on migre depuis `actions.ts`)

Chaque input ci-dessous est un DTO JSON couvert par son propre schéma Zod strict :

| Capability | Input public v1 | Remplace / notes |
|---|---|---|
| `goto` | `{ position: Position, range?: number }` | Nouveau. `mineflayer-pathfinder`, `GoalNear`/`GoalBlock`. Erreurs métier : `NO_PATH`, `OUT_OF_REACH`. Le timeout appartient à l'Executor. |
| `dig` | `{ position: Position }` | Nouveau. `bot.dig(block)`. Erreurs : `TARGET_NOT_FOUND`, `BLOCKED`, `OUT_OF_REACH`, `WORLD_CHANGED`. |
| `equip` | `{ item: string, destination?: EquipmentDestination }` | Remplace `SelectItemAction`. Erreur `MISSING_ITEM` si l'item n'est pas dans l'inventaire. |
| `place` | `{ referencePosition: Position, face: BlockFace }` | Remplace `PlaceBlockAction`. `BlockFace` est un enum JSON (`"top"`, `"bottom"`, `"north"`, etc.), converti en `Vec3` seulement dans la capability. Erreurs : `MISSING_ITEM`, `BLOCKED`, `INVALID_ARGUMENT`, `WORLD_CHANGED`. |
| `drop` | `{ mode: "all" }` ou `{ mode: "item", item: string, count?: number }` | Remplace `ClearInventoryAction`. L'union discriminée évite les inputs ambigus. |

**Volontairement exclu de v1** (décidé, voir §11) : `GiveItemsAction` (utilise `/give`, c'est un outil de
dev/cheat, pas une capability de gameplay) → devient un script utilitaire séparé
(`scripts/dev-give-items.ts`), pas dans le `CapabilityRegistry`. `craft` est repoussé à une v1.1 (nécessite
de gérer table de craft/recettes, un peu plus lourd).

## 7. WorldQueries v1 (lecture seule, minimal)

```typescript
interface WorldQueries {
  getSelf(): SelfState;                 // position, health, food, onGround...
  getInventory(): InventoryState;        // items + selectedItem
  getBlock(position: Position): BlockInfo | null;
  findNearestBlock(name: string | string[], opts?: { maxDistance?: number; count?: number }): BlockInfo[];
  getNearbyEntities(opts?: { maxDistance?: number; type?: string }): EntityInfo[];
}
```

`SelfState`, `InventoryState`, `BlockInfo` et `EntityInfo` sont eux aussi des snapshots JSON : aucune
référence à `Bot`, `Vec3`, `Block`, `Entity` ou autre objet Mineflayer.

Ça suffit pour construire les `input` des `TaskSpec` à la main dans `main.ts` en attendant l'Agent (ex :
`{ capability: "goto", input: { position: nearestOak.position } }`).

## 8. Table de migration fichier par fichier

| Ancien fichier | Devenir |
|---|---|
| `BotManager.ts` (connexion + pathfinder) | → `runtime/MinecraftRuntime.ts` |
| `BotManager.ts` (`actionsQueue`, `execute()`) | → `execution/ExecutionQueue.ts` + `execution/Executor.ts` |
| `BotManager.ts` (classe `Action` avec ~120 events) | **supprimé**. Les capabilities n'ont besoin d'écouter que 1-2 events précis (ex: `diggingCompleted`), elles le font directement dans leur `execute()` et se désabonnent via `signal`. Le bridge générique d'events reviendra, réduit, avec le `Supervisor` (phase Agent). |
| `BotManager.ts` (`ActionSequence`) | **supprimé**. Remplacé par du TS normal (fonctions async) — ce sera le rôle des futurs `Skills`, hors scope ici. |
| `actions.ts` → `SelectItemAction` | → `capabilities/Equip.ts` |
| `actions.ts` → `PlaceBlockAction` | → `capabilities/PlaceBlock.ts` |
| `actions.ts` → `ClearInventoryAction` | → `capabilities/Drop.ts` |
| `actions.ts` → `GiveItemsAction` | → `scripts/dev-give-items.ts` (hors CapabilityRegistry) |
| `Activity.ts` | notes de design récupérées ici (§1); fichier **supprimé** pour l'instant, sera recréé en tant que `skills/Skill.ts` dans le plan Agent |
| `Behavior.ts` | **supprimé** pour l'instant, reviendra en tant que `behavior/Supervisor.ts` dans le plan Agent |
| `Context.ts` / `ContextProvider` | **supprimé**, remplacé ici par `world/WorldQueries.ts`. Le "Context" au sens LLM (snapshot compact) viendra dans le plan Agent |
| `Thoughts.ts` | **supprimé** pour l'instant, reviendra en tant que `agent/Agent.ts` + `agent/Planner.ts` dans le plan Agent |
| `Logger.ts` | conservé tel quel |
| `types.ts` | renommé `config.ts` (mcData, constantes) ; les contrats JSON publics vont dans `shared/types.ts` |
| `utils.ts` | fusionné dans `world/WorldQueries.ts` (les helpers d'inventaire/position deviennent des méthodes de query) |
| `main.ts` | réécrit en harness manuel (§9) |

## 9. Phases d'implémentation

- **Phase 0 — Fondations.** Corriger `tsconfig.json` (retirer le `paths` cassé ou le faire fonctionner
  avec un `baseUrl`), harmoniser la casse des noms de fichiers/imports, ajouter les scripts `package.json`
  (`dev`, `build`, `start`), ajouter Zod, `npm install`. Créer les dossiers
  `shared/ runtime/ world/ capabilities/ execution/`.
- **Phase 1 — Contrats exécutifs JSON.** `shared/types.ts` (`Position`), `execution/Task.ts`
  (`TaskSpec`/`Task`), `execution/TaskFactory.ts`, `execution/TaskResult.ts`. Aucun type Mineflayer
  dans ces contrats.
- **Phase 2 — `MinecraftRuntime`.** Extraction propre de la connexion + pathfinder depuis `BotManager`.
- **Phase 3 — `WorldQueries` v1.** Lecture seule, portée depuis `utils.ts` + nouvelles méthodes.
- **Phase 4 — `Capability` + `CapabilityRegistry`.** Schéma Zod obligatoire sur chaque capability ;
  validation centralisée par l'Executor.
- **Phase 5 — Capacités concrètes v1** : `goto`, `dig`, `equip`, `place`, `drop` (voir §6), migrées avec
  `TaskResult` structuré au lieu de `resolve()/reject(string)`.
- **Phase 6 — `ExecutionQueue` + `Executor`.** FIFO avec `enqueueMany`, `peek`, `clear`, `toArray` ;
  exécution séquentielle, validation Zod, un `AbortSignal` par task, timeout configurable et distinction
  garantie entre `TIMEOUT`, `INTERRUPTED` et `INTERNAL_ERROR`.
- **Phase 7 — Harness manuel dans `main.ts`.** Remplace la démo `ActionSequence` : on connecte le bot, on
  construit 3 `TaskSpec` à la main (avec `WorldQueries` pour trouver les cibles), `TaskFactory` les
  matérialise, on les enqueue, on démarre l'`Executor` et on logue chaque `TaskEvent`.
- **Phase 8 — Nettoyage final.** Suppression effective de `BotManager.ts`, `actions.ts`, `Activity.ts`,
  `Behavior.ts`, `Context.ts`, `Thoughts.ts`. Vérification que tout compile (`tsc --noEmit`) et tourne
  contre un vrai serveur Minecraft.

### Definition of Done (couche exécutive)

`npm run dev` connecte le bot, matérialise avec `TaskFactory` puis exécute séquentiellement une petite
liste de `TaskSpec` codée en dur (ex: `goto` vers l'arbre le plus proche trouvé via `WorldQueries`,
`equip` d'une hache, `dig` sur le bloc), affiche un `TaskResult` structuré pour chaque étape (succès ou
`TaskError` avec `code` + `message` + `retryable`), et **ne crash jamais** le process sur un échec
attendu (bloc introuvable, chemin bloqué, item manquant...).

La validation comprend aussi trois scénarios négatifs automatisables sans LLM :

1. un `TaskSpec` mal formé produit `INVALID_ARGUMENT` avant tout appel Mineflayer ;
2. une task trop longue produit `TIMEOUT` ;
3. `abortCurrent()` produit `INTERRUPTED`.

À l'issue de la v1, la future couche Agent ne voit que `TaskSpec[]` en entrée et `TaskResult[]` en
sortie. Elle ne connaît ni `Task.id`, ni `Task.createdAt`, ni `Vec3`, ni Mineflayer.

## 10. Explicitement hors scope (→ `02-agent-layer.md` plus tard)

- `LLMProvider` / intégration Ollama ou llama.cpp
- `Agent` / `Planner` / `AgentDecision` (schémas Zod, structured output)
- `Skills` (composition de capabilities : `Gather`, `Explore`, `Build`)
- `GoalStack` (LIFO d'objectifs)
- `Behavior` / `Supervisor` (réflexes : fuite, faim, feu...)
- `WorldMemory` (mémoire long terme : maison, village, dernière position d'un joueur...)

## 11. Décisions actées

1. **`craft`** : repoussé en v1.1. La v1 exécutive reste minimale : `goto`, `dig`, `equip`, `place`, `drop`.
2. **`GiveItemsAction`** : sort complètement du bot, devient `scripts/dev-give-items.ts`, hors
   `CapabilityRegistry` (ce n'est pas une capability de gameplay).
3. **Timeout par défaut de l'`Executor`** : `30000` ms (`DEFAULT_TASK_TIMEOUT_MS` dans `config.ts`),
   overridable par task via `Task.timeoutMs`.
4. **`TaskSpec` / `Task`** : le futur LLM produit un `TaskSpec`; seul `TaskFactory` ajoute `id` et
   `createdAt`.
5. **Contrats publics** : JSON pur. `Position` remplace `Vec3` à la frontière du moteur exécutif.
6. **Validation** : chaque capability expose un schéma Zod, évalué par l'Executor avant l'exécution.
7. **Annulation** : `TIMEOUT`, `INTERRUPTED` et `INTERNAL_ERROR` sont des issues distinctes et testées.
8. **WorldQueries** : reste strictement read-only ; trouver une cible est une query, s'y déplacer est une
   capability, en collecter plusieurs sera plus tard un skill.
9. **État du plan** : phases 0 à 8 terminées. `npm test` compile le projet et valide les 5 tests ; le
   harness a également été validé en direct contre Minecraft 1.21.11.
