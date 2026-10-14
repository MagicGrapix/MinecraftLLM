# Agents et contexte

## Coordinateur, planner, actionneur

Le coordinateur est la conversation du joueur. Il choisit un tool par tour : répondre, demander un plan,
déléguer une étape, demander un blueprint, consulter le monde, cocher une étape ou mettre à jour le résumé de tâche.
Il n'exécute aucune capability Minecraft lui-même.

Le prompt lui demande de transmettre au planner l'objectif, les contraintes du joueur, les faits observés
et les blocages. Le planner décide les sous-objectifs, prérequis de craft, stations et quantités ; le
coordinateur ne lui impose pas une recette ou une séquence de tools. Pour `run_step`, il transmet le but
et le critère de l'étape courante, en laissant les arguments d'exécution à l'actionneur.

Le planner reçoit la conversation joueur/assistant restante, son résumé compacté, le monde actuel,
la checklist et l'instruction du coordinateur. `PlannerAgent` crée une conversation privée par délégation :
un tool natif par réponse, résultat réel en message tool, puis nouvel appel si nécessaire.
Il termine avec `submit_plan({steps:[{title,successCriteria}]})` ; le format réutilise `PlannerResultSchema`
(1–10 étapes, titre 160 caractères maximum et critère 400). Un texte seul ne soumet pas de plan.
Son system contient aussi le catalogue complet de l'actionneur (noms, descriptions et schémas d'arguments),
injecté par `{{action_tools}}` depuis le même `ToolCatalogBuilder` que les tools réellement disponibles.
Il s'en sert pour proposer des sous-objectifs réalisables et tenir compte des opérations déjà gérées
par chaque tool. Les cibles et arguments d'exécution restent à l'actionneur. Les seuls tools appelables
du planner sont `search_recipes`, `read_recipe` et `submit_plan` ; aucune capability ou lecture du monde.
Les fiches sont rendues en texte avec grilles, tandis que le journal conserve le résultat structuré.
Une entrée absente ou invalide reste une incertitude explicite, pas une preuve d'impossibilité.
Le code numérote les étapes à partir de 1. Seul un `submit_plan` valide remplace l'ancien plan et invalide
ses rapports. Une erreur ou une interruption laisse l'ancien plan intact. Une soumission invalide retourne
un feedback dans la conversation privée pour correction. La délégation suivante repart à neuf.
Le coordinateur reçoit le plan et `recipeCoverage` : recettes/variantes lues et entrées indisponibles,
sans la conversation privée ni les grilles. Il peut transmettre les contraintes utiles dans les étapes.

Le prompt regroupe une action et sa vérification dans une seule étape. Une inspection distincte reste
possible si elle vérifie une autre propriété, par exemple pouvoir entrer dans une construction.
Les critères quantifiés nomment l'item et la comparaison : stock total minimal, gain depuis le début
de l'étape ou quantité exacte explicitement demandée. Les rendements de craft sont des lots entiers :
le besoin d'un `stick` peut produire quatre sticks, et les ingrédients restants ne doivent pas être
déclarés absents sans nécessité. Ces règles guident le LLM ; `successCriteria` reste du texte, pas une
expression déterministe. Planner et actionneur partagent les outils de consultation des recettes.
Le succès de lecture ne valide ni le stock, ni l'accès à une station, ni l'exécution du craft.

L'actionneur reçoit une étape avec son critère, l'objectif utilisateur, la checklist complète, le résumé
de tâche et les derniers rapports des étapes déjà tentées. Il travaille uniquement sur l'étape déléguée.
Il garde une conversation privée pendant cette délégation, sans phases planning/review.
Il choisit un tool à la fois : lecture, capability, skill ou `finish_step`.
Le résultat réel est ajouté avant le prochain appel LLM. Chaque nouvelle délégation repart à zéro.

`finish_step` rend une déclaration et les TaskResults réels au coordinateur.
`complete_step` exige le dernier rapport réussi de cette étape dans le plan courant.
La validation du critère de réussite reste à la charge du coordinateur : ce contrôle de correspondance
n'est pas une vérification déterministe de l'objectif.

Une lecture directe du coordinateur ou le rapport d'une autre étape ne remplace pas ce rapport.
Le refus de `complete_step` précise l'étape à déléguer avec `run_step`. Pour vérifier le résultat,
le coordinateur utilise les TaskResults et le World Context courant ; il ne relit que les informations
manquantes, incertaines ou susceptibles d'avoir changé. Le code n'empêche pas une lecture redondante
ni une checklist trop détaillée : leur réduction dépend encore des prompts.

`WorkflowState` garde un dernier rapport par numéro d'étape, avec ses TaskResults complets et sa version
de plan. Déléguer une autre étape n'écrase pas ce rapport : le coordinateur peut donc cocher une étape
oubliée après vérification. Le prompt lui demande toutefois de vérifier et cocher avant de poursuivre.
Une nouvelle tentative reçoit le rapport précédent comme contexte, mais l'invalide pour la complétion :
seul le nouveau rapport peut autoriser `complete_step`. Un échec ou une exception ne laisse pas un ancien
succès utilisable. Une nouvelle demande joueur ou un nouveau plan vide les rapports et l'étape sélectionnée.

## Architect isolé (lot 4)

`ArchitectAgent.run(delegation, { signal?, generationId?, reflection? })` reçoit une demande utilisateur,
des compléments facultatifs (instruction de délégation, contraintes, observations et extrait de discussion).
Il crée une conversation privée neuve. `prompts/architect.md` est son prompt de rôle en production.
Son system contient seulement les règles de dessin, la légende fixe et les limites en texte.
La demande et les compléments forment un seul message user protégé ; une instruction identique
à la demande n’est pas dupliquée. Les observations ne donnent aucun droit d’action ou de lecture du monde.

À chaque appel : un tool natif `submit_blueprint({ drawing })`, puis le résultat réel dans
un échange assistant/tool. Le replay reste natif pour préserver les grilles lors des corrections.
Une soumission valide et enregistrée termine immédiatement la délégation : référence, nom/description,
dimensions, facture et versions. Ni grille ni conversation privée ne partent dans le rapport.
Le contexte est abandonné après ce retour, même en échec ; les traces restent disponibles.

`ARCHITECT_LIMITS` dans `BuildingConfig.ts` fixe huit appels maximum, réponses mal formées et corrections
comprises, et 4096 tokens de sortie par défaut. Il n'y a pas de seconde boucle de huit retries.
Les résumés utilisent le compactor partagé et ses appels séparés bornés (deux retries maximum ici).
Le plafond d’entrée de 20k inclut aussi le schéma du champ drawing et le feedback de validation.
`ArchitectDrawing` convertit les couches texte A/point en Blueprint interne ; le modèle ne fournit
ni dimensions, ni palette, ni portes. Les limites d’appels et la version Minecraft ne sont pas injectées dans le prompt.
Les phases de trace sont `architect` et `architect_context_summary`, pas des modes planning/review.

L'atelier peut sélectionner une variante par couches : `architect-layers.md`, `LayeredArchitectTools`
et seize appels maximum, sans changer le bot. La même boucle appelle start/set/finish et conserve tous
les échanges natifs. Chaque résultat contient le brouillon complet ; seule la réussite de finish termine
la délégation. Le brouillon est remis à zéro au début de la suivante. Voir [l'atelier](architect-workbench.md).

`requestStop()` interrompt le signal et attend la promesse en cours. Une nouvelle délégation est refusée
tant que celle-ci n'est pas terminée. Une écriture déjà commencée reste attendue : elle peut laisser un
fichier valide immuable, mais le rapport reste `INTERRUPTED` avec `savedBlueprintId`, jamais un succès.
Une limite, une sortie tronquée ou une erreur de stockage ne produit pas de référence acceptée.

Le rôle reste testable seul dans `scripts/smoke/architect.ts`. Depuis le lot 5, le coordinateur
le délègue aussi via `ask_architect({ instruction })`, avec demande active, discussion joueur/assistant,
résumé compacté et instantané du monde. Il ne transmet pas ses anciens tools ni les grilles d'autres dessins.
Les limites Architect restent celles de `BuildingConfig.ts`, sans réutiliser les 256 tours de l'actionneur.

## Construction dans le workflow (lot 5)

- Dessin demandé : `ask_architect` puis `reply(answer)`. Aucun planner/build automatique.
- Construction demandée : `ask_architect`, puis `ask_planner` avec référence et facture, puis `run_step`.
  L'actionneur collecte/crafte selon le plan, ou utilise directement le stock fourni, et appelle `build`.
  Le coordinateur vérifie les résultats comme pour toute autre étape avant `complete_step`.
- `WorkflowState.construction` contient `{ blueprint: ArchitectReport, instruction }`, sans grille.
  `ConstructionContext` est reconstruit dans le system du coordinateur, du planner et de l'actionneur.
  Il ne dépend ni du résumé de conversation ni de la conservation du tool `ask_architect` dans l'historique.
- Un replan conserve ce blueprint. Une nouvelle soumission acceptée remplace la référence, vide la
  checklist et les rapports, et incrémente `planVersion`. Elle n'efface aucun bloc déjà construit.
  Un échec laisse la sélection précédente intacte ; le coordinator reçoit l'erreur structurée, pas un succès.
- Une nouvelle demande efface la sélection. Les anciennes références peuvent rester dans la conversation,
  mais le contexte précise qu'elles sont inactives et l'actionneur refuse de les construire.
- Stop/shutdown propage le signal et attend le retour de l'Architect (y compris une écriture déjà lancée).
  Une réponse tardive ne peut pas modifier l'état de la demande. Resume conserve les échanges appariés.

La distinction dessin/construction reste une décision du coordinateur guidée par son prompt, pas un
classificateur déterministe. L'acceptation d'un dessin n'appelle jamais le Builder par elle-même.
La facture correspond aux items finis pour une construction neuve ; les recettes et leur rendement
restent à planifier. L'origine physique est choisie par l'actionneur d'après la demande/les observations,
puis conservée dans les arguments/résultats pour les reprises ; elle n'est pas inventée par l'Architect.

## Ordre des messages

```text
system    : prompt du rôle + Task Context + Task Summary éventuel + Construction Context + World Context actuel
assistant : résumé de conversation antérieure (vide au départ)
user      : demande active, conservée telle quelle
assistant / tool : échanges suivants, dans leur ordre
```

Les demandes précédentes et leurs réponses restent à leur place tant qu'elles n'ont pas été compactées.
La demande active ne migre pas à la fin du contexte à chaque call. Elle ne peut pas être supprimée
par la compression. Pour l'actionneur, l'instruction du coordinateur est le message user protégé ;
l'objectif global reste également présent dans ses données de délégation.

Pour le coordinateur et l'actionneur, `TaskContextFormatter` présente l'objectif, l'étape sélectionnée
et son critère, la checklist complète et les rapports compacts (numéro, statut déclaré, message).
Sans plan, il affiche `No plan yet.`. Les rapports sont des déclarations historiques ; seuls les `[x]`
représentent une validation du coordinateur. Ils ne remplacent ni les observations fraîches ni les résultats
réels, conservés dans les échanges d'outils et les traces. Ces rapports de plan restent dans le system
même si l'historique est compacté. Le planner garde sa vue checklist et son instruction, sans ces rapports.

L'actionneur n'a plus de section `Last Action Result` dans le system : chaque résultat d'action est déjà
ajouté à sa conversation avant le call suivant. Le dernier résultat brut reste dans le snapshot debug.
Sa conversation repart à zéro à chaque délégation ; les rapports compacts lui transmettent le progrès utile
sans rejouer les conversations privées des étapes précédentes.

Le World Context est un instantané courant dans le system, sans horodatage. Il utilise du texte dense :
position du bot, direction, état de survie, inventaire du bot, item tenu et landmarks.
Les nombres de présentation ont au plus deux décimales. Les données brutes restent dans les traces.
Une observation inconnue ne devient jamais de l'air.

## Compression à 20k

`CONTEXT_BUDGET`, dans `src/config.ts`, définit :

- 3 caractères par token, avec une petite marge de structure/protocole ;
- déclenchement à 20 000 tokens d'entrée estimés ;
- cible d'environ 10 000 après compression ;
- résumé de conversation plafonné à 3 000 caractères.

L'estimation inclut les messages, le system et les schémas des tools. Ce n'est ni un tokenizer,
ni le réglage de fenêtre d'Ollama. Les sorties ont leur propre budget, 4 096 tokens par défaut.

Avant un nouveau call du coordinateur, du planner, de l'actionneur ou de l'Architect isolé, `ContextCompactor` vérifie le budget.
Si le seuil est atteint, un appel LLM séparé résume les anciens échanges avec le résumé précédent.
Il conserve les faits utiles, contraintes, échecs et incertitudes. Il remplace ensuite le premier message assistant.
La demande active et le dernier échange complet restent intacts, et les messages récents gardent leur ordre.

La suppression des anciens échanges n'est validée qu'après un résumé non vide, dans la limite autorisée.
Une erreur ou un stop pendant la compression laisse l'ancien historique intact.
Si le system, la demande ou le dernier résultat sont eux-mêmes trop gros, le traitement échoue explicitement :
aucun JSON rejoué n'est découpé et aucun résultat n'est éliminé silencieusement.
Le monde est relu après la compression pour le prochain call.

Le planner n'a pas de mémoire entre délégations : il reçoit les messages joueur/assistant conservés par
le coordinateur et son résumé, sans rejouer les tools du coordinateur. Pendant la délégation, ses propres
appels/résultats restent natifs ; sa copie est compactée si nécessaire en tenant compte du system,
du catalogue documentaire et des trois schémas appelables. La phase de compression est `planner_context_summary`.
Les appels de compression portent leur propre label debug ;
ce ne sont pas de nouvelles phases de l'actionneur.

Le plafond s'applique aussi aux appels de résumé et aux retries. `llm/InputBudget.ts` vérifie la requête finale
avant transport et produit `CONTEXT_TOO_LARGE` sans contacter Ollama si elle atteint encore 20k.
Pour résumer une grande source, `BoundedSummary` la sérialise puis envoie des fragments consécutifs avec
le résumé intermédiaire, chacun sous le plafond avec une marge pour le feedback de validation.
Ces fragments sont explicitement des données pouvant commencer ou finir au milieu d'un enregistrement,
pas des échanges de tools exécutables. Leur concaténation couvre toute la source ; l'historique original
n'est remplacé qu'après la réussite de tous les appels. Un échec conserve l'ancien résumé et l'historique.
Le résumé de tâche peut être vidé ; un résumé de compression doit rester non vide.

## Deux résumés, deux usages

Le **résumé de conversation** est automatique au seuil de 20k. Il remplace de vieux messages dans le contexte
assistant, avec un budget de 3 000 caractères.

Le **résumé de tâche** est demandé par `refresh_summary`, limité par `AGENT_MEMORY_MAX_CHARS`
(500 caractères par défaut). Il reçoit les faits courants, le résumé précédent, le résumé de conversation
et l'activité récente, puis remplace la section Task Summary du system.
Sa réponse complète n'est pas rejouée dans l'historique ; seul un accusé de mise à jour y entre.
Il est écrit avec la checklist, l'étape sélectionnée et les rapports compacts dans `logs/agent_summary_<session>.md`.
Aucun de ces résumés n'est automatiquement rechargé après redémarrage.

## Présentation compacte des tools

`TOOL_REPLAY_MODE` reste une constante séparée. En mode `compact`, les anciens échanges complets
sont présentés en texte/YAML assistant, étiquetés comme activité de l'application. Le dernier échange reste
natif : assistant tool call, puis résultat tool. Une réponse `reply` envoyée devient du texte assistant.
Le mode `native` garde les enveloppes assistant/tool originales.

Cette transformation de format ne fait pas d'appel LLM et ne constitue pas la compression à 20k.
Les arguments/résultats restent disponibles jusqu'à leur éventuelle inclusion dans un résumé.
L'inspecteur montre toujours la requête exacte envoyée et les exécutions originales.

## Numéros d'appels et diff d'inventaire

Chaque appel qui commence reçoit un `actionNumber` partagé par coordinateur, planner, Architect et actionneur,
y compris les lectures, réponses et handoffs. Ce numéro suit l'ordre de démarrage pendant toute
la session du bot. Il est distinct du numéro de checklist et de l'index du call LLM dans l'inspecteur.
Une réponse sans appel natif valide n'en reçoit pas. Les outils du planner reçoivent aussi un numéro
lorsqu'ils retournent une erreur d'arguments ou de validation, comme les soumissions Architect.

Le résultat natif garde son contrat (`ok`, `value` ou `error`) et ajoute `actionNumber` au premier niveau.
Exception de présentation : les fiches recettes sont du texte en message tool, préfixé `Action #N`.
Le JSON structuré reste dans le journal et l'inspecteur, sans duplication dans le contexte LLM.
Les échanges compactés conservent ce champ ; une réponse `reply` envoyée reste toutefois du texte
de conversation, comme avant. Les traces et la UI conservent son numéro.
Les outcomes des capabilities dans le rapport de l'actionneur conservent aussi leur `actionNumber`.

Toutes les capabilities et `run_step` enregistrent les quantités agrégées par nom d'objet avant/après
l'exécution, succès ou échec. Les lectures et tools de workflow sans effet physique n'enregistrent
pas d'inventaire. `run_step` encadre toute la délégation ; les capabilities enfants ont leurs propres
snapshots. Un échec physique ne déclenche aucune nouvelle tentative automatique.

Les deux agents disposent de `get_inventory_diff_after({"actionNumber":12})` : comparaison fixe
entre juste avant et juste après l'appel 12, jamais avec l'état actuel. Consulter le diff ne modifie
aucun snapshot. Aucun gain retourne `No inventory changes during action #12.`, pas un ancien gain.
Le champ `actionNumber` extérieur désigne l'appel de lecture ; celui de `value` désigne l'appel comparé.
`toolSucceeded` décrit le résultat technique du tool, pas la validation d'une checklist.

Le journal est conservé pendant la demande, y compris après une délégation et pendant stop/resume.
Une nouvelle demande acceptée efface les entrées, sans réutiliser les numéros. Les anciennes entrées
restent dans les traces JSONL, mais ne sont pas rechargées dans l'agent. Ce stockage ne remplace pas
le contexte du monde courant et n'ajoute pas de mémoire LLM.

## Arrêts, retries et limites

Les messages ordinaires sont ignorés pendant une requête. `stop` annule le LLM ou l'action courante ;
`resume` rend la main au coordinateur avec un monde relu. Les tools interrompus reçoivent un résultat,
pour ne pas laisser de tool call sans réponse.

Une sortie mal formée, vide ou tronquée provoque jusqu'à huit retries LLM, sans exécuter ses tools.
Une action physique échouée n'est pas rejouée automatiquement. Voir [les annulations](contracts.md).
Le coordinateur dispose de 64 tours par boucle, l'actionneur de 256 calls par délégation,
dont le dernier est réservé à un rapport. Ces limites ne remplacent pas le budget de contexte.
Le planner dispose de `PLANNER_MAX_TOOL_CALLS = 16` appels LLM hors compression, corrections comprises.
Les erreurs de protocole/arguments consécutives respectent aussi `responseMaxRetries` (8 par défaut).
Les recettes absentes ne déclenchent pas de retry automatique. Sa sortie utilise `llmMaxTokens` comme
les autres appels de workflow. Ces limites ne sont pas injectées dans son prompt.

## Prompts

Les six templates runtime sont dans `prompts/` : coordinator, planner, actioner, summary,
conversation-summary et context-summary. Les trois prompts d'agents restent éditables séparément.
Le chargement intervient au démarrage ; redémarrer le bot après édition.
Les smoke sont dans `tests/fixtures/prompts/`. Aucun ancien classifier ou MemoryUpdater n'est conservé.
