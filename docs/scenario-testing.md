# Scénarios Minecraft de bout en bout

Le lanceur dans `tests/e2e/` démarre un controller OP et un nouveau processus du bot pour chaque essai.
Les agents, tools, skills et prompts sont ceux de production. La demande passe par le chat Minecraft.
Les critères de test ne sont jamais injectés dans le contexte LLM. Aucun LLM supplémentaire ne juge les résultats.

## Lancer une campagne

Le serveur Minecraft et Ollama doivent déjà tourner. Le lanceur ne redémarre pas le serveur.
Dans la console du serveur, une seule fois :

```text
op test_controller
```

Depuis la racine du projet :

```powershell
npm.cmd run test:scenarios -- --list
npm.cmd run test:scenarios -- --scenario craft_table
npm.cmd run test:scenarios -- --scenario collect_two_logs --timeout 300 --repeat 3
npm.cmd run test:scenarios
```

La dernière commande lance les deux scénarios. Le reset modifie l'arène configurée du world builder
(par défaut X/Z -48..48, Y -64..-30), y compris ses blocs souterrains et ses entités hors joueurs.
Le profil restauré est bedrock -64, terre -63/-62, herbe -61, air au-dessus.
Éviter les interventions manuelles et les autres bots actifs dans cette zone pendant une campagne.
Ne pas démarrer manuellement les pseudos dédiés `test_bot` / `test_controller`.
Seul le controller doit être OP ; ne pas donner OP à `test_bot`.

Les constantes se règlent dans `tests/e2e/config.ts` ; les scénarios dans `tests/e2e/scenarios.ts`.
Les options de connexion Minecraft et Ollama restent celles du projet. Le délai propre à un scénario
est son `timeoutMs`, avec 300 000 ms par défaut ; `--timeout` surcharge ce délai en secondes.
Un message de scénario est limité à 220 caractères, sans slash initial ni saut de ligne, pour rester
une seule demande dans le chat actuel. `--help` et `--list` ne contactent ni Minecraft ni Ollama.

Pour une série périodique, sans chevauchement :

```powershell
npm.cmd run test:scenarios -- --campaigns 3 --interval 60
```

Cela lance trois campagnes, espacées de 60 secondes **après la fin** de la précédente.
Le programme doit rester ouvert. Ce n'est pas une tâche système ni un service en arrière-plan.
Ctrl+C annule la campagne, ferme ses processus et conserve les résultats déjà écrits.
Un problème de préparation, de connexion ou d'arrêt confirmé arrête la série ; un échec de critère
ou un timeout dont le nettoyage est confirmé permet de poursuivre les essais.
Le code de sortie est 0 si tous les essais réussissent, 1 sinon.

## Cycle et isolation

1. Vérification OP du controller et des chunks de l'arène.
2. Reset du terrain, bot de test déconnecté. Vérification de toutes les cellules de l'arène.
3. Pose de la fixture, puis vérification des blocs attendus et du reste de l'arène.
4. Nouveau processus Node du bot, nouveau contexte des agents et fichier de landmarks propre à l'essai.
5. Inventaire vidé et alimenté, effets retirés, santé/faim restaurées, XP remis à zéro, mode survival,
   position (0.5, surfaceY+1, 0.5), orientation sud, slot de barre rapide 0. Temps réglé au jour, météo claire.
6. Vérification de l'inventaire, santé, faim, effets, position, orientation, sol et absence d'action physique.
7. Activation du chat, demande du controller, confirmation structurée de prise en charge, chronométrage.
8. Observations toutes les 200 ms. Fin du workflow + exécuteur libre + critère satisfait = réussite.
9. `stop` dans le chat, arrêt du workflow, attente de libération du verrou physique, fermeture du processus
   et confirmation de départ du joueur par le controller avant le prochain reset.

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
Les arbres de scénario ont une géométrie fixe et des feuilles persistantes, posées avec deux `/fill`.
La génération naturelle `/place feature` reste disponible dans le world builder manuel.

Le bot de test accepte le chat normalement. Le worker détecte une demande acceptée d'un autre émetteur
ou différente de la demande attendue comme une contamination. Il n'ajoute aucun contrôle de propriétaire
au bot normal. Une intervention physique d'un joueur n'est pas automatiquement détectée.

L'IPC du worker transporte uniquement readiness, événements de workflow, observations et fermeture.
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

- `campaign.json` : configuration effective, scénarios, révision Git et empreinte source ; clé API exclue.
- `prompts/` : copie utilisée réellement par les workers, même si les prompts originaux sont édités ensuite.
- `skills/`, `source/`, `working-tree.patch` : copie de référence du code, des skills et changements locaux.
- `results.json` : essais et statistiques cumulés, consommables ultérieurement par une autre UI.
- `<essai>/scenario.json` : demande, délai et inventaire initial.
- `<essai>/events.jsonl` : événements du lanceur et observations de l'inventaire/état.
- `<essai>/trace_<session>.jsonl` : requêtes LLM, réponses brutes et appels de tools de production.
- `<essai>/result.json` : verdict, critère, observations initiale/finale, temps et statistiques.
- `<essai>/process.log`, `log_<session>.log`, `agent_summary_<session>.md` : sorties et checklist.
- `<essai>/landmarks.json` : mémoire de lieux isolée, conservée pour inspection.

Chaque ligne JSONL conserve `timestamp`, `event`, `data`. Le journal de tools contient le numéro,
le rôle, le tool-call ID, les arguments, le résultat et les inventaires avant/après si suivis.
Les numéros sont uniques dans une session du bot ; chaque nouveau processus repart de 1.
Ils ne sont donc pas des identifiants globaux de campagne. Utiliser essai/session + numéro.

Statuts : `passed`, `failed` (workflow terminé mais critère faux), `timeout`, `error` (préparation,
workflow en erreur, observation perdue ou infrastructure). Un « success » du modèle ne valide rien seul.
Les critères actuels mesurent des gains d'inventaire depuis l'état initial, pas seulement une présence.
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
Une modification de `src/`, `skills/` ou `tests/e2e/` pendant une campagne l'invalide et arrête la suite.
Les paramètres globaux jour/météo restent dans l'état réglé par le dernier reset, comme le reset manuel.

## Vérifier et étendre

`npm.cmd test` compile également `tests/e2e/` et exécute ses tests unitaires (cycle, timeout,
inventaire, fixtures, statistiques, HTML et IPC avec un faux worker sans Minecraft/Ollama).
Les vrais scénarios ne sont jamais exécutés par cette commande.

Pour ajouter un scénario, définir un `Scenario` dans `scenarios.ts` avec demande, inventaire,
fixture bornée facultative, liste de blocs attendus et `verify(initial, current)`.
Les critères restent de petites fonctions déterministes ; les observations disponibles aujourd'hui
couvrent surtout l'inventaire et l'état du bot. Ajouter explicitement les observations nécessaires
avant un scénario de construction ou de validation de blocs plus complexe.
