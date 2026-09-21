# Plan — Agent Ollama, pilotage par chat et mémoire de travail

> Statut : prêt pour implémentation.
>
> Dépend de : `02-concurrent-agent-foundations.md` et des capabilities d'interaction déjà présentes.
>
> Modèle retenu pour la v1 : Ollama local, modèle `qwen3.5:9b`, API OpenAI-compatible
> `POST /v1/chat/completions`.
>
> But de cette phase : remplacer le scénario codé en dur de `main.ts` par un Agent événementiel que
> Quentin peut observer, interrompre, questionner et diriger depuis le chat Minecraft.

## 1. Résultat attendu

À la fin de cette phase, le bot doit pouvoir :

1. se connecter au serveur et rester inactif sans appeler le modèle en boucle ;
2. recevoir une demande naturelle depuis le chat Minecraft ;
3. distinguer une question en lecture seule d'une demande d'action ;
4. charger les Skills utiles, lire le monde et construire des `TaskSpec` ;
5. laisser l'`ExecutionController` exécuter les actions physiques pendant que l'Agent peut réfléchir ;
6. réagir aux résultats de capabilities sans lancer deux inférences concurrentes ;
7. interrompre immédiatement une réflexion devenue obsolète lorsqu'un nouveau message arrive ;
8. arrêter réellement le bot avec `stop`, puis effectuer une nouvelle réflexion avant `resume` ;
9. conserver un contexte court des actions récentes et une mémoire persistante des lieux importants ;
10. répondre dans le chat avec un message bref, sans exposer de chaîne de pensée interne.

Exemples de comportement :

```text
Quentin: comment tu penses construire une table de craft ?
Bot:     réponse explicative uniquement ; aucune mutation de queue

Quentin: construis une table de craft
Bot:     inspecte l'inventaire, charge craft_item, prépare/modifie la queue et exécute

Quentin: stop
Bot:     annule l'inférence, met la queue en pause et interrompt l'action physique active

Quentin: où est le coffre ?
Bot:     répond depuis les landmarks/queries ; reste arrêté

Quentin: resume
Bot:     relit l'état, revalide le plan en attente, puis reprend seulement si la réflexion réussit
```

## 2. Principes d'architecture non négociables

1. **Une seule action physique à la fois.** Cette règle reste la responsabilité de
   `ExecutionController` et `Executor`.
2. **Une seule inférence Agent à la fois.** Aucun callback Minecraft ou événement d'exécution ne doit
   appeler directement le LLM.
3. **Agent et exécution sont concurrents.** Marcher ou creuser ne bloque pas les queries ni une
   réflexion.
4. **Le modèle n'appelle jamais `Executor`.** Il peut uniquement lire via `WorldQueryRegistry` et
   demander des mutations validées via un `AgentToolBridge` vers `ExecutionController`.
5. **Tout argument produit par le modèle est non fiable.** JSON parse, Zod, existence de capability,
   révision et permissions sont vérifiés avant toute mutation.
6. **Une réponse obsolète ne peut jamais agir.** Chaque réflexion possède un `generationId` et un
   `AbortSignal`; le résultat est rejeté après chaque `await` si la génération n'est plus courante.
7. **`stop` est collant.** Aucune réponse LLM ni demande d'action ne peut relancer l'exécution tant
   qu'un `resume` explicite n'a pas réussi.
8. **Les questions sont réellement read-only.** Ce n'est pas seulement une instruction de prompt :
   les tools de mutation sont absents ou refusés côté code.
9. **Pas de boucle de pensée à vide.** Le LLM est réveillé par des événements déterministes.
10. **Les Skills restent du savoir textuel.** Ils décrivent une technique ; ils n'exécutent rien.
11. **Le contexte reste borné.** L'historique de debug complet peut être loggé, mais il n'est pas
    renvoyé intégralement au modèle.
12. **Pas de dépendance à un champ de raisonnement propre à Qwen/Ollama.** L'API interne reste
    compatible avec d'autres backends OpenAI-like.

## 3. Architecture cible

```text
 chat Minecraft ──► MinecraftChatAdapter ──► AgentMailbox
           stop ──► arrêt déterministe             │
        resume ──► reprise contrôlée                │
                                                  ▼
 événements Controller ──► WakePolicy ──► AgentLoop (1 génération active)
                                               │
                      ┌────────────────────────┼───────────────────────┐
                      ▼                        ▼                       ▼
               AgentContextBuilder      LLMClient              AgentToolBridge
                      │                        │                       │
          ┌───────────┼────────────┐           │          ┌──────────┼──────────┐
          ▼           ▼            ▼           │          ▼          ▼          ▼
 RecentActivity  LandmarkMemory  Skills        │     WorldQueries  Skills  ExecutionController
          │           │            │           │         lecture   lecture    TaskSpec seulement
          └───────────┴────────────┴───────────┘
```

Un **snapshot** est une photo JSON immuable de l'état observable du contrôleur à une révision donnée :
mode, tâche active, tâches en attente et état de shutdown. Il ne pilote rien par lui-même ; il permet
au modèle de raisonner sur un état précis et au bridge de refuser une décision devenue obsolète avec
`REVISION_CONFLICT`.

## 4. Arborescence proposée

```text
src/
  agent/
    Agent.ts
    AgentMailbox.ts
    AgentState.ts
    AgentContextBuilder.ts
    AgentToolBridge.ts
    ToolCatalogBuilder.ts
    WakePolicy.ts
    prompts.ts
    Agent.test.ts
    AgentToolBridge.test.ts

  chat/
    ChatIntent.ts
    ChatIntentRouter.ts
    MinecraftChatAdapter.ts
    MinecraftChatAdapter.test.ts

  llm/
    LLMClient.ts
    LLMError.ts
    OpenAICompatibleLLMClient.ts
    FakeLLMClient.ts
    OpenAICompatibleLLMClient.test.ts

  memory/
    LandmarkMemory.ts
    RecentActivityBuffer.ts
    ConversationHistory.ts
    LandmarkMemory.test.ts
    RecentActivityBuffer.test.ts

  bootstrap/
    createCapabilities.ts
    createAgentRuntime.ts

scripts/
  smoke-ollama.ts

data/
  landmarks.json             # créé au runtime, ignoré par Git si spécifique au monde local

docs/plans/
  03-ollama-agent-chat.md
```

Les noms peuvent être adaptés aux conventions du dépôt, mais les responsabilités ne doivent pas être
fusionnées dans un énorme `Agent.ts` ou dans `main.ts`.

## 5. Étape 1 — Configuration et client LLM provider-neutral

### Dépendances

Ajouter :

```text
openai
zod-to-json-schema
```

Conserver `zod` v3. Ne pas faire fuiter les types du SDK OpenAI hors de
`OpenAICompatibleLLMClient.ts`.

### Variables d'environnement

Créer `.env.example` ou documenter les variables sans committer de secret :

```ini
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen3.5:9b
LLM_TEMPERATURE=0.2
LLM_MAX_TOKENS=1200
LLM_REQUEST_TIMEOUT_MS=120000
LLM_MAX_TOOL_ROUNDS=8
BOT_OWNER_USERNAME=GrapixMagique
BOT_MODE=agent
LANDMARKS_FILE=./data/landmarks.json
```

`LLM_API_KEY` est nécessaire au SDK, même si Ollama local ignore sa valeur. La taille de contexte
d'Ollama ne doit pas être supposée par le code ; le `AgentContextBuilder` doit borner lui-même son
contenu.

### Contrats internes

Définir des types internes capables de préserver intégralement le protocole de tools :

```ts
export interface LLMToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export type LLMMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: readonly LLMToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface LLMTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface LLMRequest {
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly LLMTool[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

export interface LLMResponse {
  readonly message: Extract<LLMMessage, { role: "assistant" }>;
  readonly finishReason: string | null;
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
  };
}

export interface LLMClient {
  complete(request: LLMRequest): Promise<LLMResponse>;
}
```

Ne pas retourner seulement `content` et une liste de calls détachée : le message assistant contenant
les `tool_calls` doit être remis dans l'historique avant les messages `tool` portant les IDs
correspondants.

### Adapter OpenAI-compatible

`OpenAICompatibleLLMClient` :

- construit le SDK avec `baseURL`, `apiKey` et `model` injectés ;
- utilise `client.chat.completions.create(...)` ;
- passe l'`AbortSignal` dans les options de requête du SDK ;
- mappe uniquement les function tool calls supportés ;
- refuse une réponse sans `choices[0]` avec une erreur structurée ;
- transforme annulation, indisponibilité, timeout et protocole invalide en `LLMError` ;
- n'ajoute aucun champ `reasoning` spécifique au provider ;
- ne retry pas automatiquement une annulation ;
- limite un retry transitoire éventuel à une tentative avec backoff court, sans dupliquer de tool call.

Codes conseillés :

```ts
type LLMErrorCode =
  | "ABORTED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "INTERNAL_ERROR";
```

### Fake et smoke test

Créer `FakeLLMClient` avec une queue de réponses/promesses contrôlables. Il doit permettre de simuler
une réponse lente et une réponse qui arrive malgré une annulation, afin de tester la barrière
`generationId`.

Créer `scripts/smoke-ollama.ts` qui vérifie séparément :

1. une réponse texte simple ;
2. un tool call forcé avec arguments JSON ;
3. le replay correct `assistant(tool_calls) -> tool(tool_call_id) -> assistant` ;
4. l'annulation d'une requête avec `AbortController`.

Le smoke test ne se lance pas dans `npm test`; il nécessite Ollama et le modèle local.

## 6. Étape 2 — Rendre capabilities et queries exposables comme tools

### Métadonnées des capabilities

Ajouter `description` à `Capability` et `RegisteredCapability`. Faire évoluer le registry pour exposer
des résumés et la validation sans exécuter :

```ts
interface CapabilitySummary {
  readonly name: string;
  readonly description: string;
}

CapabilityRegistry.list(): readonly CapabilitySummary[];
CapabilityRegistry.has(name: string): boolean;
CapabilityRegistry.validateInput(name: string, input: unknown): ValidationResult;
```

Adapter les tests qui attendent actuellement une simple liste de noms. Chaque description doit dire
ce que fait la capability, ses effets et les préconditions importantes, sans expliquer une stratégie
complète — la stratégie appartient aux Skills.

### JSON Schema

`ToolCatalogBuilder` convertit les schémas Zod en JSON Schema avec
`zod-to-json-schema`. Les schémas sont calculés au bootstrap, pas à chaque tour.

Construire le schéma de `tasks` comme une union discriminée JSON Schema générée depuis le registry :

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "capability": { "const": "goto" },
        "input": { "...": "schéma Zod de goto" },
        "timeoutMs": { "type": "integer", "minimum": 1 }
      },
      "required": ["capability", "input"],
      "additionalProperties": false
    }
  ]
}
```

Le JSON Schema aide le modèle, mais le bridge refait toujours la validation Zod au runtime.

## 7. Étape 3 — `AgentToolBridge`

### Catégories de tools

Le bridge publie trois groupes.

**Lectures immédiates :**

- une fonction par query enregistrée : `get_self`, `get_inventory`, `get_block`,
  `find_nearest_blocks`, `get_nearby_entities` ;
- `get_execution_snapshot` ;
- `list_skills` ;
- `load_skill` ;
- `list_landmarks`.

**Mutations du futur plan :**

- `enqueue_tasks` ;
- `replace_pending_tasks` ;
- `prepend_task` ;
- `remove_pending_task` ;
- `clear_pending_tasks`.

**Contrôle et mémoire :**

- `pause_execution` ;
- `resume_execution` ;
- `abort_current_task` ;
- `remember_landmark` ;
- `forget_landmark`.

Toutes les mutations de queue et de contrôle reçoivent `expectedRevision`. Le résultat retourne le
nouveau snapshot compact et les IDs concernés. Sur `REVISION_CONFLICT`, le modèle doit relire le
snapshot avant de proposer une nouvelle mutation.

### Permissions par tour

```ts
export type AgentPermissionMode =
  | "readonly"
  | "planning_stopped"
  | "acting"
  | "resume_review";
```

- `readonly` : queries, snapshot, Skills et lecture des landmarks seulement ;
- `planning_stopped` : permet de préparer/modifier les tâches, mais refuse toute reprise ;
- `acting` : permet les mutations et le contrôle normal ;
- `resume_review` : permet de revalider/remplacer le plan pendant que le contrôleur reste en pause ;
  la reprise finale appartient à l'orchestrateur, pas au modèle.

Le filtrage se fait à deux niveaux : tools non autorisés absents du catalogue envoyé, puis refus côté
bridge si un nom forgé est quand même reçu.

### Règles d'exécution des tool calls

1. parser `arguments` comme JSON ;
2. refuser un objet invalide avec un résultat tool structuré, sans throw hors de l'Agent ;
3. valider le schéma du tool ;
4. pour chaque `TaskSpec`, vérifier la capability puis son `inputSchema` ;
5. vérifier le mode de permission et `manualStopped` ;
6. exécuter les tool calls dans l'ordre pour une v1 déterministe ;
7. sérialiser tout résultat en JSON compact ;
8. journaliser tool, durée, succès/erreur et génération, sans journaliser de secret.

Plusieurs lectures indépendantes pourront être parallélisées plus tard. Les mutations ne le sont pas.

## 8. Étape 4 — Historique court et mémoire des lieux importants

### `RecentActivityBuffer`

Conserver les **15 derniers événements significatifs**, pas tous les événements techniques :

- demande ou correction de Quentin ;
- démarrage/fin d'une capability avec `taskId`, input compact et résultat ;
- query importante et son résultat compact ;
- interruption, erreur LLM ou conflit de révision ;
- changement d'objectif explicite.

Ne pas y mettre chaque `mode_changed`, log de pathfinding ou tick. Chaque entrée contient :

```ts
interface ActivityEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly kind: string;
  readonly summary: string;
  readonly data?: unknown;
  readonly taskId?: string;
}
```

Le buffer mémoire est une ring buffer bornée. Le log détaillé complet reste disponible dans les logs
du processus et n'entre pas automatiquement dans le prompt.

### `ConversationHistory`

L'historique LLM est également borné par nombre de tours et taille sérialisée. Une séquence de tools
est atomique : ne jamais conserver un message assistant avec `tool_calls` si les messages `tool`
correspondants ont été évincés, et inversement.

Pour la v1, ne pas demander au LLM de se résumer lui-même en permanence. Prévoir une interface pour un
résumé roulant futur, mais utiliser aujourd'hui :

- directive active ;
- snapshot frais ;
- état bot/inventaire frais lorsque pertinent ;
- 15 activités significatives ;
- landmarks épinglés ;
- quelques tours de conversation atomiques.

Le futur `GoalStack` remplacera/étendra la directive active ; il n'est pas implémenté ici.

### `LandmarkMemory`

Persister les éléments toujours importants demandés par Quentin : table de craft, coffre, lit, base et
lieux personnalisés.

```ts
type LandmarkKind =
  | "crafting_table"
  | "chest"
  | "bed"
  | "base"
  | "custom";

type LandmarkStatus = "confirmed" | "stale" | "missing";

interface Landmark {
  readonly id: string;
  readonly name: string;
  readonly kind: LandmarkKind;
  readonly dimension: string;
  readonly position: { x: number; y: number; z: number };
  readonly source: "observed" | "user" | "agent";
  readonly status: LandmarkStatus;
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly lastVerifiedAt: number | null;
}
```

Règles :

- les landmarks `pinned` sont toujours injectés sous forme compacte ;
- ne jamais inventer de coordonnées ;
- un coffre connu ne signifie pas que son contenu est connu ;
- un chunk non chargé donne `stale`/inconnu, pas automatiquement `missing` ;
- un succès d'interaction ou de placement à la position rafraîchit `confirmed` ;
- `TARGET_NOT_FOUND` ou `WORLD_CHANGED` sur un landmark le marque `stale`, puis `missing` seulement
  après vérification explicite du bloc dans un chunk observable ;
- écriture du fichier JSON atomique via fichier temporaire puis renommage ;
- un fichier absent démarre une mémoire vide ; un JSON corrompu produit une erreur visible et une
  sauvegarde du fichier fautif, jamais un effacement silencieux.

## 9. Étape 5 — Construction du contexte et prompt système

`AgentContextBuilder` produit un contexte frais à chaque génération. Ordre conseillé :

1. règles système stables ;
2. état de marche (`manualStopped`, permission du tour, raison du réveil) ;
3. directive active ;
4. `ExecutionSnapshot` compact avec révision ;
5. landmarks épinglés ;
6. résumé court des capabilities, queries et Skills disponibles ;
7. contenu complet des Skills chargés pour ce tour ;
8. activités récentes ;
9. messages de conversation retenus ;
10. nouveau message/événement à traiter.

Ne pas charger tous les `SKILL.md` dans chaque prompt. Donner leurs résumés, puis laisser le modèle
appeler `load_skill` lorsque la technique est utile.

### Politique du prompt

Le prompt doit expliquer clairement :

- les queries observent immédiatement ; les capabilities sont des actions physiques mises en queue ;
- une réponse de question ne doit jamais modifier la queue ;
- une tâche active ne peut pas être réécrite, seulement interrompue ;
- utiliser `expectedRevision` et relire après conflit ;
- vérifier le résultat d'une action avant de supposer qu'elle a réussi ;
- préférer un plan court et révisable à une longue queue spéculative ;
- utiliser un Skill pertinent avant une tâche complexe ;
- distinguer observation actuelle, mémoire potentiellement stale et hypothèse ;
- quand le bot est arrêté, préparer un plan est permis mais le démarrage ne l'est pas ;
- répondre dans la langue de l'utilisateur et rester bref pour le chat Minecraft ;
- ne jamais publier de chaîne de pensée ; donner seulement conclusion, plan court, état ou question de
  clarification.

Prévoir un budget de contexte configuré. Commencer conservateur ; si la taille estimée dépasse le
budget, retirer d'abord les anciens tours complets, puis les anciennes activités non épinglées. Ne
jamais retirer la politique, l'état d'arrêt, le snapshot courant ou la demande active.

## 10. Étape 6 — Mailbox, réveils et boucle Agent

### Événements de réveil

```ts
type AgentWakeEvent =
  | { type: "user_message"; username: string; text: string; receivedAt: number }
  | { type: "resume_requested"; username: string; receivedAt: number }
  | { type: "execution_finished"; event: ExecutionEvent }
  | { type: "execution_idle"; event: ExecutionEvent }
  | { type: "startup" };
```

Priorité : commande de contrôle déterministe, message utilisateur, échec de tâche, succès de tâche,
queue idle. Les événements d'exécution identiques en attente peuvent être coalescés, mais aucun message
utilisateur ne doit être perdu.

Ne réveillent pas le LLM en v1 : `task_started`, chaque changement de mode, chaque mouvement, les ticks
de faim/santé et les changements de queue produits par le même tour Agent.

### Invariant d'une seule génération

`Agent` possède :

```ts
interface AgentRunState {
  readonly manualStopped: boolean;
  readonly activeDirective: string | null;
  readonly generationId: number;
  readonly thinking: boolean;
}
```

Algorithme :

```text
mailbox reçoit un wake
→ si nouveau chat : annuler AbortController courant et incrémenter generationId
→ attendre la fin logique de l'ancien tour sans accepter ses effets tardifs
→ construire contexte + permissions
→ appeler LLM
→ après chaque await : vérifier signal + generationId
→ enregistrer le message assistant complet
→ s'il y a des tool calls : les exécuter, enregistrer les résultats, rappeler le LLM
→ s'arrêter sur réponse finale, annulation, erreur ou limite de tours
→ publier éventuellement une réponse chat
→ traiter le prochain wake coalescé
```

Limiter un tour à :

- `LLM_MAX_TOOL_ROUNDS` (8 par défaut) ;
- un timeout global ;
- une taille maximale de résultat tool ;
- une seule mutation de plan atomique recommandée par round.

Si la limite est atteinte, arrêter proprement le tour, ne pas reprendre automatiquement une exécution
manuellement stoppée et informer brièvement Quentin.

### Événements pendant une réflexion

- un nouveau message chat annule toujours la réflexion LLM courante ;
- il n'interrompt pas automatiquement l'action physique active ;
- `stop` est l'exception : il annule réflexion **et** action active ;
- un `task_finished` reçu pendant un tour est ajouté à l'activité et mis en mailbox pour le prochain
  tour ; il ne crée jamais une seconde inférence concurrente ;
- un résultat tool obtenu dans le tour est traité dans le même tour et ne crée pas un wake récursif.

## 11. Étape 7 — Intentions du chat et commandes `stop` / `resume`

### Réception du chat

`MinecraftChatAdapter` écoute l'événement Mineflayer `chat` :

- ignore les messages du bot lui-même ;
- n'autorise les mutations que pour `BOT_OWNER_USERNAME` ;
- dans le serveur offline local, rappeler dans les logs que le pseudo n'est pas une authentification
  forte ;
- normalise espaces/casse uniquement pour les commandes exactes ;
- découpe les réponses longues en morceaux sûrs pour le chat, avec délai anti-spam ;
- n'envoie jamais les dumps JSON complets dans Minecraft.

Commandes déterministes acceptées : `stop`, `bot stop`, `resume`, `bot resume`. Elles ne passent pas
par un LLM. Les autres messages sont des entrées naturelles.

### Routage question/action

Créer `ChatIntentRouter` avec le résultat :

```ts
type ChatIntent =
  | { kind: "readonly_question"; confidence: number }
  | { kind: "action_request"; confidence: number }
  | { kind: "conversation"; confidence: number }
  | { kind: "unclear"; confidence: number };
```

Pour ne pas laisser le modèle obtenir des tools d'écriture avant que l'intention soit connue :

1. `stop`/`resume` sont détectés en code ;
2. quelques formes non ambiguës peuvent être routées en code ;
3. le reste utilise un petit appel de classification au même `LLMClient`, sans aucun tool, avec sortie
   JSON validée par Zod ;
4. toute sortie invalide ou faible confiance devient `unclear` et reçoit une question de clarification
   read-only ;
5. la classification fait partie de la génération annulable courante.

Cas d'acceptation obligatoires :

```text
"construis une table de craft"                    -> action_request
"comment tu penses construire une table de craft" -> readonly_question
"est-ce que tu peux construire une table ?"       -> action_request
"où est le coffre ?"                              -> readonly_question
"attends"                                         -> unclear, jamais interprété comme stop
```

### Sémantique exacte de `stop`

À la réception :

1. incrémenter `generationId` et abort la requête LLM ;
2. mettre `manualStopped = true` avant tout `await` ;
3. appeler `controller.abortCurrent("Stopped by user")`, ce qui pause et interrompt l'action active ;
4. conserver les tâches pending et la directive afin de pouvoir les inspecter/replanifier ;
5. répondre immédiatement `Arrêt demandé.` puis, si une capability possède une barrière
   d'annulation différée, `Bot arrêté.` lorsque `task_finished` confirme l'interruption ;
6. refuser toute tentative ultérieure de `resume_execution` issue du modèle.

Une action demandée pendant l'arrêt peut mettre à jour la directive et préparer/remplacer les tâches,
mais doit répondre par exemple : `Plan préparé ; je reste arrêté jusqu'à resume.`

### Sémantique exacte de `resume`

`resume` ne lance jamais aveuglément les anciennes tâches :

1. annuler une éventuelle réflexion précédente ;
2. garder `manualStopped = true` et le contrôleur en pause ;
3. créer un tour `resume_review` avec snapshot, pending, directive, inventaire et derniers résultats ;
4. autoriser le modèle à relire le monde et remplacer/vider le futur plan ;
5. si le tour se termine correctement et n'est pas obsolète, mettre `manualStopped = false` ;
6. appeler `controller.resume()` avec la révision la plus récente ;
7. si Ollama échoue, si le tour est annulé ou si une validation échoue, rester arrêté et l'indiquer.

Cette règle évite de reprendre une tâche devenue fausse pendant la pause.

### Questions pendant une exécution

Une question annule la réflexion LLM courante pour obtenir la priorité, mais ne pause pas la capability
active. Elle reçoit seulement les tools read-only. Après sa réponse, les événements d'exécution mis en
attente peuvent provoquer une nouvelle réflexion d'action. Si le bot était manuellement arrêté, il le
reste.

## 12. Étape 8 — Câblage de `main.ts` et modes de lancement

Extraire la construction des registries actuellement privée dans `main.ts` vers des fonctions de
bootstrap testables.

Ajouter deux modes :

- `BOT_MODE=agent` : aucun scénario codé en dur, démarrage de l'Agent et du chat ;
- `BOT_MODE=demo` : conserve le scénario `goto/equip/dig` utile au diagnostic bas niveau.

Scripts conseillés :

```json
{
  "dev": "ts-node src/main.ts",
  "dev:agent": "set BOT_MODE=agent&& ts-node src/main.ts",
  "dev:demo": "set BOT_MODE=demo&& ts-node src/main.ts",
  "smoke:ollama": "ts-node scripts/smoke-ollama.ts"
}
```

Si les scripts doivent être portables hors Windows, utiliser deux entrypoints TypeScript au lieu de
syntaxe d'environnement spécifique au shell.

Ordre du bootstrap Agent :

```text
charger/valider config
→ connecter MinecraftRuntime
→ créer world, container manager, capability/query registries et Skills
→ charger LandmarkMemory
→ créer Executor + ExecutionController
→ créer LLMClient + ToolBridge + Agent
→ abonner Controller vers RecentActivity/Mailbox
→ abonner le chat
→ réveil startup optionnel sans auto-action
→ attendre SIGINT/SIGTERM/end
```

Shutdown : désabonner le chat, empêcher les nouveaux wakes, abort le LLM, shutdown le contrôleur,
fermer le container actif, persister les landmarks, puis déconnecter le runtime.

## 13. Politique d'erreurs et observabilité

Chaque log Agent doit inclure quand pertinent : `generationId`, `wakeType`, `intent`, `toolName`,
`taskId`, `revision` et durée.

Journaliser :

- début/fin/annulation d'une génération ;
- classification d'intention ;
- tool calls et résultat compact ;
- stale result rejeté ;
- mutation refusée et révision ;
- événements d'exécution ;
- changement de `manualStopped` ;
- chargement/persistance des landmarks.

Ne pas faire crash le processus sur une réponse LLM invalide. Répondre brièvement dans le chat et
attendre le prochain wake. En revanche, une configuration invalide au bootstrap doit échouer
clairement avant de connecter le bot si possible.

## 14. Plan de tests automatisés

### Client LLM

- mapping texte ;
- conservation du message assistant et de tous les `tool_calls` ;
- corrélation exacte de `tool_call_id` ;
- réponse vide/invalide ;
- annulation et timeout ;
- aucune dépendance aux types OpenAI dans le reste du code.

### Tool bridge

- query valide pendant une capability lente ;
- JSON invalide ;
- tool inconnu ;
- input de capability invalide ;
- `readonly` refuse toutes les mutations ;
- `planning_stopped` peut modifier pending mais pas reprendre ;
- `resume_review` ne reprend pas directement ;
- `expectedRevision` obsolète retourne `REVISION_CONFLICT` ;
- `replace_pending_tasks` est validé entièrement avant mutation ;
- aucune voie ne permet d'appeler directement `Executor`.

### Agent / concurrence

- une seule inférence simultanée ;
- un nouveau chat abort l'ancienne génération ;
- une réponse tardive de l'ancienne génération n'exécute aucun tool ;
- un `task_finished` pendant une réflexion est traité au tour suivant ;
- les événements sont coalescés sans perdre un message utilisateur ;
- un résultat tool reste dans le même tour ;
- limite de rounds et timeout global ;
- échec Ollama ne reprend jamais un bot arrêté.

### Chat

- ignore le message du bot ;
- contrôle réservé au propriétaire ;
- détection exacte de stop/resume ;
- `stop` annule LLM, pause et interrompt la tâche active ;
- pending conservé après stop ;
- action pendant stop prépare mais ne démarre pas ;
- `resume` réfléchit avant de drainer ;
- question pendant exécution ne stoppe pas l'action ;
- réponses découpées et rate-limitées.

### Intent router

- les cinq phrases d'acceptation de la section 11 ;
- JSON de classification invalide -> `unclear` ;
- faible confiance -> clarification read-only ;
- classifier annulé par un nouveau message.

### Mémoire et contexte

- ring buffer limité à 15 ;
- seules les activités significatives sont retenues ;
- tool call et tool result évincés atomiquement ;
- landmarks pinned toujours présents ;
- upsert et persistance atomique ;
- JSON corrompu non écrasé silencieusement ;
- landmark stale/missing selon les règles de vérification ;
- dépassement du budget retire l'ancien contexte, jamais les invariants courants.

Tous les tests existants de capabilities, runtime, queries, Skills, Executor et Controller doivent
rester verts.

## 15. Scénarios de validation live Minecraft

Préparer un monde superflat local avec jour fixe et mobs désactivés, puis tester dans cet ordre :

1. **Démarrage inactif** : le bot se connecte ; Ollama ne reçoit pas d'appels répétés sans événement.
2. **Question read-only** : `comment tu penses construire une table de craft ?` ; comparer snapshot
   avant/après, queue et mode identiques.
3. **Demande d'action** : `construis une table de craft` ; observer queries/Skill, queue puis résultat.
4. **Concurrence** : poser une question pendant `goto` ; le bot répond et continue à marcher.
5. **Interruption de réflexion** : envoyer deux demandes rapidement ; aucun tool du premier résultat
   obsolète ne s'exécute.
6. **Stop physique** : `stop` pendant `goto` ou `dig` ; action interrompue, contrôleur paused, pending
   conservé.
7. **Discussion arrêtée** : demander inventaire/coffre ; réponse read-only, aucune reprise.
8. **Plan pendant arrêt** : donner un nouvel objectif ; pending peut être préparé, aucune action ne part.
9. **Resume** : `resume` ; nouvelle observation, correction éventuelle du plan, puis reprise.
10. **Landmark** : mémoriser une table/coffre, redémarrer le bot, vérifier sa présence dans le contexte.
11. **Landmark faux** : retirer un bloc connu, demander son utilisation, vérifier passage stale/missing et
    nouvelle recherche plutôt qu'une position inventée.
12. **Ollama indisponible** : arrêter Ollama ; message d'erreur lisible, bot Minecraft toujours vivant et
    état d'arrêt respecté.

## 16. Ordre d'implémentation recommandé pour Cursor

Chaque lot doit compiler et passer les tests avant le suivant.

### Lot A — Transport LLM

1. dépendances/config ;
2. types `LLMClient` ;
3. adapter OpenAI-compatible ;
4. fake client et tests ;
5. smoke Ollama texte + tools + abort.

### Lot B — Catalogue et bridge

1. descriptions des capabilities ;
2. conversion Zod -> JSON Schema ;
3. catalogue de queries/Skills/controller ;
4. `AgentToolBridge` et permissions ;
5. tests de validation/révision/read-only.

### Lot C — Contexte et mémoire

1. `RecentActivityBuffer` ;
2. `ConversationHistory` atomique ;
3. `LandmarkMemory` persistante ;
4. `AgentContextBuilder` et prompt ;
5. tests de bornage/persistance.

### Lot D — Agent événementiel

1. `AgentMailbox` et priorités ;
2. `WakePolicy` déterministe ;
3. boucle de tool calls ;
4. `AbortSignal` + `generationId` ;
5. événements Controller ;
6. tests de concurrence et réponses obsolètes.

### Lot E — Chat et arrêt/reprise

1. adapter Mineflayer ;
2. commandes stop/resume en code ;
3. intent router conservateur ;
4. permission read-only/action ;
5. état `manualStopped` collant ;
6. tests complets des transitions.

### Lot F — Intégration live

1. refactor bootstrap/main ;
2. modes agent/demo ;
3. logs ;
4. suite automatisée complète ;
5. smoke Ollama ;
6. scénarios Minecraft de la section 15.

Ne pas commencer le lot suivant avec des tests rouges. Ne pas remplacer les abstractions existantes
qui fonctionnent par une nouvelle architecture parallèle.

## 17. Definition of Done

La phase est terminée lorsque :

- `npm run typecheck` et `npm test` réussissent ;
- le smoke test confirme `qwen3.5:9b`, les tools et l'annulation via Ollama ;
- aucune inférence ne tourne sans wake ;
- au maximum une inférence et une capability physique sont actives chacune ;
- une nouvelle entrée chat rend toute ancienne génération incapable d'agir ;
- une question ne peut pas muter la queue, même si le modèle tente un tool forgé ;
- `stop` annule la réflexion, pause et interrompt l'action active ;
- une action demandée pendant l'arrêt ne démarre rien ;
- `resume` effectue une réflexion fraîche avant de reprendre ;
- les 15 dernières activités significatives sont disponibles sans croissance infinie ;
- table de craft, coffre, lit, base et landmarks custom peuvent être mémorisés et persistés ;
- les réponses Minecraft sont concises et n'exposent pas de chaîne de pensée ;
- le mode démo bas niveau reste utilisable pour diagnostiquer les capabilities ;
- les douze scénarios live ont un résultat documenté.

## 18. Explicitement hors scope de cette phase

- `GoalStack` hiérarchique ;
- résumé LLM permanent des cinq dernières minutes ;
- WorldMemory sémantique/embeddings ;
- Supervisor de survie complet ;
- modèle 4B sentinelle tournant en continu ;
- exécution simultanée de plusieurs capabilities physiques ;
- perception visuelle ;
- plusieurs joueurs autorisés à piloter ;
- authentification forte sur serveur offline ;
- dépendance à un format de thinking interne de Qwen.

La future sentinelle 4B devra implémenter la même interface `WakePolicy`. Elle ne recevra que des
événements résumés et ne pourra jamais appeler une capability : elle pourra seulement produire une
raison et une priorité de réveil pour le 9B. Avant de l'ajouter, mesurer latence et VRAM lorsque 4B et
9B sont chargés simultanément. La v1 reste entièrement déterministe sur les wakes.

## 19. Références techniques

- Ollama documente `http://localhost:11434/v1/`, la clé factice requise par les clients, Chat
  Completions et les tools dans son mode OpenAI-compatible :
  https://docs.ollama.com/api/openai-compatibility
- Le protocole Chat Completions définit le message assistant avec ses tool calls et les messages
  `tool` corrélés par `tool_call_id` :
  https://developers.openai.com/api/reference/cli/resources/chat

