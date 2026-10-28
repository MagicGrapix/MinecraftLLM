# MinecraftLLM

Bot Minecraft expérimental en TypeScript/Mineflayer, piloté par un modèle local via une API OpenAI-compatible.
Le coordinateur dialogue avec le joueur, le planner crée une checklist, l'actionneur exécute une étape.

## Démarrer

Depuis la racine du projet, avec Minecraft et le serveur LLM déjà lancés :

```powershell
npm.cmd install
npm.cmd run dev
```

L'interface de debug est sur http://127.0.0.1:3001/.
Dans Minecraft, écrire une demande au bot. Pendant une requête, seuls `stop` et `resume` sont traités.
Les messages ordinaires reçus pendant son travail sont ignorés.
Le bot principal n'a pas besoin d'OP.

La connexion LLM est dans `src/agent/AgentConfig.ts` : `LLM_BACKEND = "llamacpp"`
utilise le serveur déjà lancé sur `http://127.0.0.1:8080/v1`. Le bot et l'atelier partagent ce choix.
Le modèle par défaut est `qwen-27b`, identifiant exposé par llama-swap. Ce nom doit correspondre à un
modèle de `/v1/models` pour sélectionner le bon backend. Aucun serveur LLM n'est lancé par le projet.
Pour revenir au 9B Ollama, remplacer cette constante par `"ollama"`, puis redémarrer le processus.
Les adresses et modèles des deux connexions sont juste en dessous dans le même fichier.
`.env.example` documente les variables acceptées ; l'application ne charge pas automatiquement un fichier `.env`.
Les variables `LLM_BASE_URL`, `LLM_API_KEY` et `LLM_MODEL`, si définies dans le terminal,
restent prioritaires ; aucune variable n'est nécessaire pour utiliser le choix du code.

Les réglages de comportement restent des constantes dans `src/config.ts` :

- `CONTEXT_BUDGET` : compression à 20 000 tokens d'entrée estimés, cible 10 000, estimation de 3 caractères/token.
- `TOOL_REPLAY_MODE` : présentation native ou compacte des anciens échanges d'outils.
- `ACTION_MAX_TOOL_CALLS` : 256 appels d'outils maximum par délégation.
- `PLANNER_MAX_TOOL_CALLS` : 16 tours maximum pour consulter les recettes et soumettre le plan.
- `RECIPE_LIMITS` : limites des fiches et résultats de la bibliothèque `recipes/`.

La limite de sortie reste de 4 096 tokens par défaut. La fenêtre réelle du serveur LLM est un réglage distinct :
changer le seuil de compression n'agrandit pas la fenêtre du modèle.

## Tester et construire le monde

```powershell
npm.cmd test
npm.cmd run smoke:ollama
npm.cmd run dev:world
```

`npm test` est hors ligne : compilation, vérification TypeScript et tests avec faux bot/LLM.
Le smoke appelle réellement le backend sélectionné ; le diagnostic `check:ollama` reste spécifique à Ollama.
Le contrôleur de monde rejoint réellement Minecraft et nécessite
`op world_controller` dans la console serveur, sans donner OP au bot principal.

Commandes du contrôleur : `tree`, `forest 10 25`, `ore iron 8`, `preview forest 10 25`, `clear`, `reset`.
`reset` modifie l'arène, supprime les entités non-joueurs et vide l'inventaire du bot ;
`inventory clear all` détruit uniquement son inventaire.
Voir [le contrat du contrôleur](docs/contracts.md).

Pour les captures de l'article, le même terminal accepte `scene list`, `scene 1` à `scene 4`
et `preview scene 1`. Scènes statiques bois, observations, crafting et shelter, avec un figurant
`photo_bot` sans LLM. Déconnecter le bot habituel avant de préparer une scène.
Attention : la zone X/Z=22..42 est remplacée, l'heure et la météo changent globalement.
Voir [les scènes photo, le cadrage et leur modification](docs/photo-scenes.md).

Pour tester uniquement la conception de blueprints avec le backend sélectionné, sans connexion Minecraft :

```powershell
npm.cmd run smoke:architect
```

Pour tester le planner seul sur « hache puis abri », avec inventaire et facture de test :
`npm.cmd run smoke:planner`. Cela appelle le vrai LLM mais ne rejoint pas Minecraft.
Le rapport et les échanges sont sauvegardés dans `logs/planner/` et les traces de session.
Les fiches sont éditables dans `recipes/`, une par objet ; redémarrer pour les recharger.
Voir [les recettes, leur validation et leurs tools](docs/recipes.md).

Pour l'atelier web interactif : `npm.cmd run dev:architect`, puis ouvrir
http://127.0.0.1:3004/. Chaque essai utilise le vrai Architect, les prompts du projet et le vrai
validateur, sans rejoindre Minecraft. Les messages, schémas des tools, réponses brutes, erreurs
et couches du blueprint sont consultables séparément. Les prompts sont relus à chaque essai.
Voir [le fonctionnement de l'atelier](docs/architect-workbench.md).

L’Architect dessine et corrige un texte ASCII via `submit_blueprint({ drawing })` : A = planches de chêne,
point = air, ligne vide entre couches. Dimensions déduites ; pas de choix de matériaux ou de portes.
Il ne construit rien lui-même.
Le coordinateur l'appelle via `ask_architect`, puis transmet le dessin accepté au planner et à l'actionneur.
Ses limites sont dans `src/building/BuildingConfig.ts`,
son prompt dans `prompts/architect.md`. Un dessin valide ne garantit pas que le modèle a respecté
toutes les consignes : consulter [le bilan des essais du lot 4](docs/plans/blueprint-builder.md#lot-4--architect-isolé).

`npm.cmd run smoke:build-workflow` teste la chaîne complète dans Minecraft avec stock fourni et
réponses LLM scriptées (aucun Ollama). Le test utilise un bot dédié et nettoie sa petite zone ensuite.
Voir [prérequis et limites](docs/blueprints.md#intégration-lot-5).

## Où lire / modifier

- [Architecture](docs/architecture.md) : composants et points d'extension.
- [Contexte et agents](docs/agent-workflow.md) : messages, compression, mémoire, checklist.
- [Contrats et limites](docs/contracts.md) : ce qu'un succès prouve, annulation, monde de test.
- [Debug et logs](docs/debugging.md) : retrouver les requêtes/réponses exactes.
- [Descriptions des tools](docs/tools.md) : emplacements des descriptions et format retenu.
- [Accès aux blocs](docs/block-access.md) : portée et visibilité.
- [Blueprints, Architect et Builder](docs/blueprints.md) : dessin, matériaux, stockage et construction.

Les prompts réellement chargés sont dans `prompts/`. Les prompts de smoke sont dans
`tests/fixtures/prompts/`, les faux clients dans `tests/support/`.
Redémarrer le processus du bot après une modification du code ou des prompts.
