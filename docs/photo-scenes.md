# Scènes statiques pour l'article

Ces scènes sont des **illustrations mises en scène**, pas des essais de l'agent autonome.
Le World Controller prépare les décors avec des commandes OP. Un figurant Mineflayer
`photo_bot` pose avec un objet fourni : aucun LLM, aucun craft ni collecte n'est exécuté.
Les captures des prompts, de l'inspecteur et des rapports restent à prendre dans les vrais logs.

## Utilisation

1. Lancer Minecraft et rejoindre le serveur. Aucun serveur LLM n'est nécessaire.
2. Arrêter/déconnecter le bot habituel. La préparation refuse de démarrer si le joueur
   configuré par `WORLD_AGENT_USERNAME` / `MINECRAFT_USERNAME` est encore connecté,
   même s'il est idle. Les autres agents/scénarios éventuels doivent aussi être arrêtés manuellement.
3. Depuis la racine du projet :

```powershell
npm.cmd run dev:world
```

Seul `world_controller` nécessite OP (`op world_controller` dans la console serveur).
Ne pas donner OP à `photo_bot`. Ne pas lancer deux World Controllers avec le même nom.
Si le contrôleur était déjà ouvert avant la modification du code, le quitter puis le relancer.

Dans son terminal :

```text
scene list
preview scene 1
scene 1
scene 2
scene 3
scene 4
```

- **1 — wood** : deux chênes fixes, figurant devant le premier avec une hache en bois.
- **2 — world** : arbre, terre, pierre et une bûche au sol. Le drop ne peut pas être ramassé
  et ne disparaît pas avec le temps : il illustre la différence entre bloc et objet.
- **3 — crafting** : table, four et pile de bûches ; le figurant tient une épée en bois fournie.
  Ce n'est pas une preuve de craft réussi.
- **4 — shelter** : abri fixe 5×5×4 en planches, intérieur vide, entrée sud haute de deux blocs,
  fenêtre ouest d'un bloc. Pas de porte physique. Le dessin ASCII correspondant est imprimé dans
  le terminal pour pouvoir illustrer le plan et sa reconstruction côte à côte.

`scene list` et `preview scene <id>` ne connectent pas le figurant et n'envoient aucune
commande de scène (le World Controller lui-même reste connecté comme d'habitude).
Chaque `scene <id>` reconstruit la même zone et remplace donc la scène précédente.
Le figurant se connecte automatiquement à la première préparation, puis reste immobile.
Garder ce terminal ouvert pendant les captures. `quit`/Ctrl+C le déconnecte aussi,
sans effacer le décor. Aucun redémarrage du serveur n'est nécessaire.

Le terminal propose une commande `/tp @s x y z yaw pitch` à exécuter **dans le chat de ton joueur**,
avec les permissions nécessaires, pour rejoindre un point de vue. Elle n'est pas exécutée automatiquement.
Le point de vue peut être en hauteur : utiliser le mode spectateur/créatif pour y rester,
ou cadrer manuellement. HUD, capture et mouvement de caméra restent manuels.

## Zone modifiée et garanties

- Centre : X=32, Z=32 ; emprise X=22..42, Z=22..42 inclus.
- Hauteur : `WORLD_SURFACE_Y - 3` à `WORLD_SURFACE_Y + 10` inclus.
  Avec les réglages par défaut : Y=-64..-51. Le sol garde le profil superflat.
- **Tous les blocs et entités non-joueurs dans cette zone sont remplacés/supprimés.**
  Ne rien y conserver. Aucun joueur n'est supprimé. L'inventaire du vrai bot n'est pas touché.
- L'heure (midi) et la météo (clair) sont modifiées **globalement** et ne sont pas restaurées.
  Aucune gamerule n'est changée ; le temps continue normalement après la préparation.
- Toute la scène est construite et validée avant envoi : noms des blocs/items, coordonnées,
  inclusion dans l'arène configurée, limites de `/fill` et nombre de commandes.
  Une arène trop petite provoque un refus, pas un déplacement implicite de la scène.
- La file du controller conserve son débit configuré (2 commandes/s par défaut).
  Les arbres sont explicites et leurs feuilles persistantes, sans `/place feature` aléatoire.
- Après l'envoi, deux observations espacées de 100 ms doivent confirmer les noms des blocs de
  toute la zone, la position du figurant, son objet tenu et les drops attendus (délai max 5 s).
  Une cellule déchargée reste inconnue, pas de l'air. Orientation, lumière, skin et cadrage ne sont
  pas validés visuellement. Les blocs peuvent encore être modifiés par un joueur après la vérification.
- Un refus serveur ou un échec de vérification est affiché, sans annoncer « ready », sans retry
  automatique et sans rollback : les changements déjà effectués restent dans le monde.
- Le figurant est un client offline, sans physique locale, sans écoute du chat ni runtime d'agent.
  Son nom est réservé ; une session existante du même nom est refusée pour éviter de la déconnecter.
  Son apparence dépend du serveur/client ; aucun skin personnalisé n'est installé.

## Adapter / ajouter une scène

Les définitions sont dans `src/devworld/scenes/`, une par fichier : `wood.ts`, `world.ts`,
`crafting.ts`, `shelter.ts`. Les inscrire dans `SceneCatalog.ts` avec un numéro unique.

- Les positions locales sont relatives au centre du plateau ; Y=0 est la surface d'herbe.
- Les régions utilisent des bornes inclusives et des noms Minecraft sans namespace.
- `actor` décrit la pose et l'objet tenu ; `camera` donne un point de vue suggéré.
- `PHOTO_STAGE` dans `ScenePlan.ts` fixe le plateau partagé. Le déplacer exige toujours qu'il
  reste entièrement dans l'arène du World Controller.
- Le shelter réutilise `parseArchitectDrawing` pour lire son dessin. Les lignes continues sont
  regroupées en `/fill`, puis la scène passe par la même file que les autres commandes du controller.

Pas de nouvel agent, de nouvelle suite de scénarios, de capture automatique ou de chorégraphie.
Les agents, leurs prompts, les tests E2E et les capabilities ne dépendent pas des scènes photo.
Tests hors ligne : `node scripts/run-tests.cjs tests/unit/devworld`, puis `npm.cmd test`.
