# Debug et logs

Pour isoler la conception des bâtiments sans lancer le bot : [atelier Architect](architect-workbench.md),
`npm.cmd run dev:architect`, sur http://127.0.0.1:3004/. Ses essais et blueprints restent séparés du runtime.

L'interface locale est http://127.0.0.1:3001/, démarrée avec le bot en mode agent.
Une request est une demande du joueur ; un call est un appel LLM dans cette request.
Les numéros de call suivent leur démarrage, pas leur fin.
Les cartes et les détails des tools affichent aussi `Action #N`, le numéro partagé de l'appel de tool.
Ne pas le confondre avec `Call N` (appel LLM) ou `Step N` (checklist). Une délégation reçoit son numéro
avant les tools enfants, même si elle se termine après eux. Clear ne réinitialise pas ce compteur
et n'efface pas le journal d'inventaire de la demande courante.

L'Architect et `ask_architect` partagent cette numérotation avec le coordinateur et l'actionneur.
Un dessin accepté affiche « Blueprint validated, not built » ; seul `build` est physique et affiche
sa référence et son origine. Les soumissions complètes restent dans les détails/traces de l'Architect,
pas dans le rapport compact du coordinateur. Une erreur Architect conserve son code et ses facts.

Un clic manuel coupe le suivi live. Les réponses réseau d'anciennes sélections ne remplacent plus
le détail choisi, et le polling ne se chevauche pas. Clear efface les cartes en mémoire,
pas les fichiers sur disque. Il est refusé lorsqu'un call est en cours.

## Retrouver une session

- `logs/log_<session>.log` : journal console lisible.
- `logs/trace_<session>.jsonl` : requêtes exactes, réponses brutes avant parsing, erreurs et rounds finalisés.
- `logs/agent_summary_<session>.md` : dernière checklist, étape sélectionnée, rapports compacts, blueprint sélectionné/facture et résumé factuel de tâche.

Ces fichiers partagent le même identifiant de session. Chaque ligne JSONL est un événement JSON
avec `timestamp`, `event` et `data`. Événements utiles :
`llm.request`, `llm.raw_response`, `llm.error`, `inspector.round`, `context.compacted`.
`tool.started` et `tool.completed` conservent le numéro, le nom du tool, son statut et les inventaires
avant/après lorsqu'ils sont suivis. Ils sont écrits même sans serveur inspecteur si la trace est activée.
Un snapshot `null` signifie indisponible, pas vide. Les fichiers existants sont réutilisés, sans fichier par action.
Les réponses tronquées ou invalides sont conservées, même quand le parsing échoue.

La trace complète est activée par défaut ; `LOG_FULL_TRACE=false` la désactive.
Les événements `workflow.accepted` et `workflow.finished` rendent visible le cycle d'une demande.
`llm.validation_error` conserve les erreurs de format des réponses, même sans inspecteur actif.
`tool.started`/`tool.completed` incluent aussi le rôle, les arguments et le résultat de l'appel.
Elle peut devenir volumineuse et contient les messages du joueur ainsi que les observations du monde :
ne pas la publier sans la relire. La clé API du client n'est pas ajoutée aux requêtes enregistrées.
La rétention UI (30 calls par défaut) ne supprime pas ces fichiers.
Pour `collect_resource`, ouvrir **Debug → Tool executions → Internal operations** : les opérations
`#42.1`, `#42.2` partagent le numéro parent 42 et n'ajoutent ni décision LLM ni diff d'inventaire.
L'ouverture suspend le suivi live. Les détails sont chargés par pages de 50, sans déplacer la sélection.
Les erreurs retournées comme `TaskResult` et les interruptions sont toutes deux signalées en rouge/texte.
L'endpoint `/api/collections/42?after=0&limit=50` ne lit que la projection en mémoire : 64 collectes,
2 000 opérations par collecte, pages de 100 maximum. Les évictions sont annoncées ; JSONL garde le détail complet.
`action.task_started` relie taskId, toolCallId et actionNumber ; `collect.event` ajoute l'index local,
les arguments, durées, résultats et poses confirmées. Le contexte LLM ne contient que le bilan final compact.
Dans les rapports de scénarios, les compteurs d'opérations internes/physiques sont distincts des tools LLM ;
leurs durées sont imbriquées et ne doivent pas être additionnées à celle du parent.
L'UI ne recharge pas encore les anciennes sessions JSONL et il n'y a pas de rotation automatique des fichiers.

## Lire une erreur

1. Trouver le call rouge et sa réponse brute : `finish_reason: length` signifie une sortie tronquée,
   pas forcément une fenêtre d'entrée pleine.
2. Comparer les arguments de tool avec son schéma et son résultat réel.
3. Une erreur INVALID_RESPONSE autorise un nouvel appel LLM, jusqu'à huit retries.
   Aucun tool de cette réponse invalide n'est exécuté. Une erreur réseau/timeout LLM reste distincte.
4. Pour une action, regarder le TaskResult et les observations, pas seulement le rapport du modèle.
5. Pour le contexte, regarder la requête réellement envoyée et les calls « Context summary ».
   `context.compacted` contient les estimations avant/après. Ces nombres ne sont pas un comptage exact.

Les métriques natives de tokens retournées par le fournisseur restent visibles.
Le monitoring GPU, la vitesse token/s et le temps de préremplissage ne font pas partie de cette version.

Les [campagnes de scénarios](scenario-testing.md) produisent un rapport HTML hors ligne avec sélection
d'essai, timeline, comptes par tool et comparaison objectif atteint/fin effective du workflow.
Leurs traces sont isolées dans `logs/scenarios/` ; elles n'effacent pas les logs du bot habituel.
