# MinecraftLLM

Bot Minecraft expérimental en TypeScript/Mineflayer, piloté par un modèle local via une API OpenAI-compatible.
Le coordinateur dialogue avec le joueur, le planner crée une checklist, l'actionneur exécute une étape.

## Démarrer

Depuis la racine du projet, avec Minecraft et Ollama déjà lancés :

```powershell
npm.cmd install
npm.cmd run dev
```

L'interface de debug est sur http://127.0.0.1:3001/.
Dans Minecraft, écrire une demande au bot. Pendant une requête, seuls `stop` et `resume` sont traités.
Les messages ordinaires reçus pendant son travail sont ignorés.
Le bot principal n'a pas besoin d'OP.

Les valeurs par défaut sont dans `src/agent/AgentConfig.ts`.
`.env.example` documente les variables acceptées ; l'application ne charge pas automatiquement un fichier `.env`.
En PowerShell, une surcharge s'écrit par exemple `$env:LLM_MODEL = "qwen3.5:9b"`.

Les réglages de comportement restent des constantes dans `src/config.ts` :

- `CONTEXT_BUDGET` : compression à 20 000 tokens d'entrée estimés, cible 10 000, estimation de 3 caractères/token.
- `TOOL_REPLAY_MODE` : présentation native ou compacte des anciens échanges d'outils.
- `ACTION_MAX_TOOL_CALLS` : 256 appels d'outils maximum par délégation.

La limite de sortie reste de 4 096 tokens par défaut. La fenêtre réelle d'Ollama est un réglage distinct :
changer le seuil de compression n'agrandit pas la fenêtre du modèle.

## Tester et construire le monde

```powershell
npm.cmd test
npm.cmd run smoke:ollama
npm.cmd run dev:world
```

`npm test` est hors ligne : compilation, vérification TypeScript et tests avec faux bot/LLM.
Le smoke appelle réellement Ollama. Le contrôleur de monde rejoint réellement Minecraft et nécessite
`op world_controller` dans la console serveur, sans donner OP au bot principal.

Commandes du contrôleur : `tree`, `forest 10 25`, `ore iron 8`, `preview forest 10 25`, `clear`, `reset`.
`reset` modifie l'arène, supprime les entités non-joueurs et vide l'inventaire du bot ;
`inventory clear all` détruit uniquement son inventaire.
Voir [le contrat du contrôleur](docs/contracts.md).

Pour tester uniquement la conception de blueprints avec Ollama, sans connexion Minecraft :

```powershell
npm.cmd run smoke:architect
```

L'Architect peut chercher des matériaux et corriger/sauvegarder un dessin ; il ne construit rien et
n'est pas encore relié au coordinateur. Ses limites sont dans `src/building/BuildingConfig.ts`,
son prompt dans `prompts/architect.md`. Un dessin valide ne garantit pas que le modèle a respecté
toutes les consignes : consulter [le bilan des essais du lot 4](docs/plans/blueprint-builder.md#lot-4--architect-isolé).

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
