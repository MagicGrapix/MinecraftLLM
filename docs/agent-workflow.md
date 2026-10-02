# Agents et contexte

## Coordinateur, planner, actionneur

Le coordinateur est la conversation du joueur. Il choisit un tool par tour : répondre, demander un plan,
déléguer une étape, consulter le monde, cocher une étape ou mettre à jour le résumé de tâche.
Il n'exécute aucune capability Minecraft lui-même.

Le planner reçoit la conversation joueur/assistant restante, son résumé compacté, le monde actuel,
la checklist et l'instruction du coordinateur. Il produit un seul JSON :
`{"steps":[{"title":"...","successCriteria":"..."}]}`.
Le code numérote les étapes à partir de 1. Un nouveau plan remplace l'ancien et invalide son dernier rapport.

L'actionneur reçoit une étape avec son critère, l'objectif utilisateur, la checklist et le résumé de tâche.
Il garde une conversation privée pendant cette délégation, sans phases planning/review.
Il choisit un tool à la fois : lecture, capability, skill ou `finish_step`.
Le résultat réel est ajouté avant le prochain appel LLM. Chaque nouvelle délégation repart à zéro.

`finish_step` rend une déclaration et les TaskResults réels au coordinateur.
`complete_step` coche une étape seulement si le rapport réussi correspond au plan courant.
La validation du critère de réussite reste à la charge du coordinateur : ce contrôle de correspondance
n'est pas une vérification déterministe de l'objectif.

## Ordre des messages

```text
system    : prompt du rôle + checklist + World Context actuel
assistant : résumé de conversation antérieure (vide au départ)
user      : demande active, conservée telle quelle
assistant / tool : échanges suivants, dans leur ordre
```

Les demandes précédentes et leurs réponses restent à leur place tant qu'elles n'ont pas été compactées.
La demande active ne migre pas à la fin du contexte à chaque call. Elle ne peut pas être supprimée
par la compression. Pour l'actionneur, l'instruction du coordinateur est le message user protégé ;
l'objectif global reste également présent dans ses données de délégation.

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

Avant un nouveau call du coordinateur ou de l'actionneur, `ContextCompactor` vérifie le budget.
Si le seuil est atteint, un appel LLM séparé résume les anciens échanges avec le résumé précédent.
Il conserve les faits utiles, contraintes, échecs et incertitudes. Il remplace ensuite le premier message assistant.
La demande active et le dernier échange complet restent intacts, et les messages récents gardent leur ordre.

La suppression des anciens échanges n'est validée qu'après un résumé non vide, dans la limite autorisée.
Une erreur ou un stop pendant la compression laisse l'ancien historique intact.
Si le system, la demande ou le dernier résultat sont eux-mêmes trop gros, le traitement échoue explicitement :
aucun JSON n'est découpé et aucun résultat n'est éliminé silencieusement.
Le monde est relu après la compression pour le prochain call.

Le planner n'a pas d'historique indépendant : il reçoit les messages de discussion conservés par le coordinateur
et son résumé, sans rejouer ses appels d'outils. Les appels de compression portent leur propre label debug ;
ce ne sont pas de nouvelles phases de l'actionneur.

## Deux résumés, deux usages

Le **résumé de conversation** est automatique au seuil de 20k. Il remplace de vieux messages dans le contexte
assistant, avec un budget de 3 000 caractères.

Le **résumé de tâche** est demandé par `refresh_summary`, limité par `AGENT_MEMORY_MAX_CHARS`
(500 caractères par défaut). Il reçoit les faits courants, le résumé précédent, le résumé de conversation
et l'activité récente, puis remplace la section Task Summary du system.
Sa réponse complète n'est pas rejouée dans l'historique ; seul un accusé de mise à jour y entre.
Il est écrit avec la checklist dans `logs/agent_summary_<session>.md`.
Aucun de ces résumés n'est automatiquement rechargé après redémarrage.

## Présentation compacte des tools

`TOOL_REPLAY_MODE` reste une constante séparée. En mode `compact`, les anciens échanges complets
sont présentés en texte/YAML assistant, étiquetés comme activité de l'application. Le dernier échange reste
natif : assistant tool call, puis résultat tool. Une réponse `reply` envoyée devient du texte assistant.
Le mode `native` garde les enveloppes assistant/tool originales.

Cette transformation de format ne fait pas d'appel LLM et ne constitue pas la compression à 20k.
Les arguments/résultats restent disponibles jusqu'à leur éventuelle inclusion dans un résumé.
L'inspecteur montre toujours la requête exacte envoyée et les exécutions originales.

## Arrêts, retries et limites

Les messages ordinaires sont ignorés pendant une requête. `stop` annule le LLM ou l'action courante ;
`resume` rend la main au coordinateur avec un monde relu. Les tools interrompus reçoivent un résultat,
pour ne pas laisser de tool call sans réponse.

Une sortie mal formée, vide ou tronquée provoque jusqu'à huit retries LLM, sans exécuter ses tools.
Une action physique échouée n'est pas rejouée automatiquement. Voir [les annulations](contracts.md).
Le coordinateur dispose de 64 tours par boucle, l'actionneur de 256 calls par délégation,
dont le dernier est réservé à un rapport. Ces limites ne remplacent pas le budget de contexte.

## Prompts

Les six templates runtime sont dans `prompts/` : coordinator, planner, actioner, summary,
conversation-summary et context-summary. Les trois prompts d'agents restent éditables séparément.
Le chargement intervient au démarrage ; redémarrer le bot après édition.
Les smoke sont dans `tests/fixtures/prompts/`. Aucun ancien classifier ou MemoryUpdater n'est conservé.
