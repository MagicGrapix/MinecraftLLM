# Debug et logs

L'interface locale est http://127.0.0.1:3001/, démarrée avec le bot en mode agent.
Une request est une demande du joueur ; un call est un appel LLM dans cette request.
Les numéros de call suivent leur démarrage, pas leur fin.

Un clic manuel coupe le suivi live. Les réponses réseau d'anciennes sélections ne remplacent plus
le détail choisi, et le polling ne se chevauche pas. Clear efface les cartes en mémoire,
pas les fichiers sur disque. Il est refusé lorsqu'un call est en cours.

## Retrouver une session

- `logs/log_<session>.log` : journal console lisible.
- `logs/trace_<session>.jsonl` : requêtes exactes, réponses brutes avant parsing, erreurs et rounds finalisés.
- `logs/agent_summary_<session>.md` : dernière checklist, étape sélectionnée, rapports compacts et résumé factuel de tâche.

Ces fichiers partagent le même identifiant de session. Chaque ligne JSONL est un événement JSON
avec `timestamp`, `event` et `data`. Événements utiles :
`llm.request`, `llm.raw_response`, `llm.error`, `inspector.round`, `context.compacted`.
Les réponses tronquées ou invalides sont conservées, même quand le parsing échoue.

La trace complète est activée par défaut ; `LOG_FULL_TRACE=false` la désactive.
Elle peut devenir volumineuse et contient les messages du joueur ainsi que les observations du monde :
ne pas la publier sans la relire. La clé API du client n'est pas ajoutée aux requêtes enregistrées.
La rétention UI (30 calls par défaut) ne supprime pas ces fichiers.
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
