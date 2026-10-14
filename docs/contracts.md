# Contrats et limites

## Exécuter, observer, valider

- `goto` réussit quand son objectif de navigation est atteint. Cela ne valide ni le prochain `dig`,
  ni le ramassage d'un item. Le déplacement peut casser/poser selon ses options.
- `get_block_access` indique la portée et une face visible localement. Ce n'est pas une autorisation
  du serveur. Une valeur inconnue ne signifie pas « air ».
- `dig` exige une mise à jour de bloc **reçue du serveur** et une cellule devenue non solide.
  L'air prédit localement par Mineflayer et ses événements `blockUpdate` ne suffisent pas.
  Sans confirmation dans les trois secondes après la fin du dig, il retourne `ACTION_NOT_CONFIRMED` :
  observer la cible avant de retenter, car une absence de confirmation n'est pas une preuve d'échec physique.
  Si la cellule n'est plus observable,
  il retourne `WORLD_CHANGED` avec `verification: unknown`, jamais un succès.
  Il ne prouve pas que la ressource est entrée dans l'inventaire.
- `get_dropped_items` décrit les stacks observées au sol. `get_inventory` décrit l'inventaire actuel
  du bot. Un item présent ne prouve pas un gain : comparer avec l'observation initiale.
- `collect_resource` exige un gain net d'inventaire serveur depuis le début de l'appel : posséder 1 bûche
  puis en demander 4 exige au moins 5 bûches à la fin. Un ramassage de stack peut dépasser la demande.
  Il n'attribue pas la cause du gain : un item donné/ramassé pendant l'appel compte aussi.
  Il considère les drops avant de miner ; casser une source, arriver ou voir un drop disparaître ne suffit pas.
  L'inventaire est resynchronisé avant/après les opérations ; `inventoryKnown: false` signifie que `collected`
  est seulement le dernier gain confirmé, pas une preuve du stock actuel (notamment après interruption).
  Un échec conserve un bilan partiel : ne pas redemander aveuglément toute la quantité.
  L'accès essaie le chemin libre, puis le creusement local, puis la terre de scaffolding si nécessaire.
  Les stations et les chantiers `build` connus du runtime sont protégés, pas les constructions arbitraires
  du joueur. Réserver son usage à une zone de test. Le stock de dirt demandé et le cobblestone ne sont
  pas dépensés pour l'accès. Le nettoyage ne retire que la terre suivie, confirmée et restée identique,
  depuis un appui sûr ; `scaffoldsLeft` peut être non nul malgré une collecte réussie.
  Stop interdit de nouvelles opérations de nettoyage. Les confirmations d'inventaire ciblent Java 1.21.11.
  Le bilan ne prouve pas que l'environnement est inchangé : du terrain peut avoir été creusé et des supports
  laissés. Les opérations internes sont liées à un seul appel parent, sans nouvelles décisions LLM.
- `place` confirme le nom du bloc à la destination grâce à un paquet serveur reçu depuis le début
  de la tentative, concordant avec la cellule actuellement chargée. Une prédiction locale seule ne suffit pas.
  La même confirmation sert au Builder, sans deuxième attente. Après résolution ou rejet de `bot.placeBlock`,
  elle vérifie immédiatement puis toutes les 100 ms, au plus 3 secondes (`ACTION_CONFIRMATION`).
  Le délai Mineflayer précédant cette vérification s'ajoute à ces 3 secondes ; aucune pose n'est réémise.
  Une erreur Mineflayer ambiguë peut donc devenir un succès si le bloc attendu est ensuite confirmé.
  Sinon, `ACTION_NOT_CONFIRMED` conserve la cause, la cible et les derniers états local/serveur :
  `verification` distingue cellule `unknown`, état `unconfirmed` et bloc serveur incorrect `mismatch`.
  Une déconnexion/mort/respawn invalide la tentative (`WORLD_CHANGED`), même après un paquet correct.
  Les préconditions échouent sans attente ni envoi. Seuls les items ayant un ID de bloc identique sont
  pris en charge ; l'orientation et les structures multiblocs ne sont pas garanties par `place`.
  Le Builder conserve ses vérifications propres de cellules et de propriétés des portes.
- `craft_from_inventory_2x2` et `craft_from_table_3x3` vérifient le gain d'inventaire demandé.
  Le premier rejette les recettes nécessitant une table ; le second accepte les recettes 2x2 et 3x3,
  vérifie l'accès à la table avant exécution et son état après. Aucun ne fabrique ses ingrédients
  ni ne navigue. Le nombre produit peut dépasser la quantité demandée selon le rendement de la recette.
  Chaque recette attend un inventaire serveur complet puis vérifie les quantités attendues, ingrédients compris,
  la grille personnelle vide et le curseur vide avant la suivante. Une différence inattendue, même un ramassage
  concurrent, empêche la confirmation et arrête la série. L'attente est immédiate puis toutes les 100 ms,
  pendant 3 secondes maximum (`ACTION_CONFIRMATION`, `src/config.ts`). La prédiction locale seule ne suffit pas.
  À expiration, `ACTION_NOT_CONFIRMED` précise le gain confirmé, le gain observé et les opérations tentées ;
  vérifier l'inventaire avant de redemander des items. Une erreur ne rejoue aucune recette automatiquement.
  L'adaptateur de confirmation est vérifié pour Java 1.21.11 ; les autres versions sont refusées explicitement.
- `finish_step` rend un rapport sans cocher de case. `complete_step` exige le dernier rapport réussi
  de l'étape et de la version courante du plan, puis met à jour la checklist. Les rapports sont conservés
  par étape : une délégation suivante n'empêche pas de vérifier une étape précédente. Retenter une étape
  invalide son ancien rapport pour la complétion, y compris si la nouvelle tentative échoue sans rapport.
  Un nouveau plan ou une nouvelle demande joueur efface ces rapports. La vérification du critère reste
  sémantique ; aucun moteur de prédicats déterministes n'est encore implémenté.

## Arguments des tools et noms Minecraft

Les positions sont des objets numériques `{ "x": 2, "y": -60, "z": 5 }`, jamais des chaînes ou tableaux.
`goto` accepte des décimales ; les cellules de blocs exigent des entiers. Les schémas envoyés au LLM
documentent ces formats et des exemples, ainsi que les quantités et faces. Pour le crafting,
le choix du tool fixe la station : `station` n'est pas un argument. `quantity` reste un entier
de 1 à 64, sans conversion implicite de chaînes comme `"4"`. Voir [les exemples](tools.md#crafting).
Une erreur de validation indique le tool, le champ, sa valeur rejetée et le schéma attendu.
Elle précise qu'aucun tool n'a été exécuté. Aucune conversion implicite de position ou de liste n'est faite.

`find_nearest_blocks.names` est un tableau non vide d'IDs exacts, même pour un seul nom.
`get_dropped_items.names` utilise le même format, mais peut être omis pour voir aussi les drops inconnus.
Le préfixe `minecraft:` est accepté. Les chaînes séparées par des virgules, catégories comme `log`,
wildcards et IDs inconnus sont rejetés. Une liste partiellement inconnue est rejetée intégralement.
`INVALID_ARGUMENT` signifie que la recherche n'a pas eu lieu ; `ok: true, value: []` signifie qu'une
recherche valide n'a trouvé aucun résultat connu dans ses limites.

`find_nearest_blocks` accepte un rayon de 50 blocs maximum (32 par défaut), et 1 à 128 résultats.
Il parcourt seulement les chunks chargés, sans garantir leur disponibilité passée ou future.
La recherche rend la main tous les 1 024 candidats ; `stop` peut donc interrompre un grand scan.
Toutes les queries partagent un délai de 2 secondes et un maximum de 12 000 caractères sérialisés,
dans `world/queries/QueryLimits.ts`. Les erreurs `QUERY_TIMEOUT`, `INTERRUPTED` et `RESULT_TOO_LARGE`
sont explicites : elles ne deviennent ni des succès vides ni des fragments de JSON.

## Limites du diff d'inventaire

`get_inventory_diff_after` expose les changements observés pendant un appel, sans attribuer leur cause.
Un drop ramassé après le retour de `dig` n'est pas dans le diff de ce `dig`. Le diff de `run_step`
couvre une fenêtre plus large. Les snapshots ne contiennent ni slots, ni durabilité, ni NBT : un outil
abîmé sans changement de quantité ne produit pas de ligne. Les anciennes valeurs ne sont jamais
remplacées par l'inventaire courant lors d'une consultation.

Un numéro absent ou un tool non suivi produit une erreur explicite. Un appel encore en cours,
une déconnexion ou une action physique encore en cours de terminaison produit `OBSERVATION_UNAVAILABLE`,
jamais un inventaire vide. Dans ce dernier cas, le snapshot manquant n'est pas reconstruit plus tard.

## Annuler une capability

Un timeout ou `stop` déclenche l'AbortSignal. L'exécuteur attend au plus une seconde de grâce
pour rendre un résultat TIMEOUT/INTERRUPTED. Une promesse Mineflayer peut continuer après ce retour.
Dans ce cas, `facts.stillSettling` vaut true et le verrou reste détenu jusqu'à la fin de la capability
et de ses opérations enregistrées. Toute nouvelle action est refusée avec BLOCKED.

Il n'y a pas de relance automatique d'action physique. Si l'opération ne se termine jamais, le verrou
ne se libère pas artificiellement : inspecter le log et reconnecter le processus du bot.
Un résultat d'annulation ne garantit pas l'absence de changements déjà appliqués.
Pendant `goto`, les promesses equip/dig/place/activate du pathfinder sont suivies comme barrières.
L'annulation refuse les nouvelles opérations issues de continuations tardives et attend celles déjà
commencées. Le retour de la seule promesse de navigation n'autorise pas une nouvelle capability.
`Executor.waitForIdle(timeoutMs)` attend explicitement la libération du verrou physique après arrêt
des producteurs de tâches. Le runtime expose cette attente pour le lanceur de scénarios.

## Sessions et sorties de l'agent

Une session de coffre ne survit pas à une fermeture serveur, une mort, un respawn ou une déconnexion.
Une fenêtre remplacée n'est pas fermée par erreur ; l'ancien identifiant devient invalide.
Tant que la fenêtre reste ouverte, la délégation suivante peut utiliser son identifiant dans le World Context.

Les réponses du modèle restent du texte de chat. Chaque morceau commençant par `/` est préfixé par `>`
avant envoi : une réponse découpée ne doit jamais devenir une commande Minecraft.

Un landmark n'est confirmé que si le bloc observé correspond à son type attendu.
Poser de la terre sur une ancienne table ne confirme pas cette table ; une cellule déchargée reste inconnue.

## Contrôleur de monde

Le format Blueprint, son stockage et la capability survival `build` sont distincts du contrôleur OP : voir
[les contrats Blueprint](blueprints.md). `build` ne peut ni donner des items, ni effacer le terrain,
ni utiliser des commandes serveur. L'Architect ne possède que la recherche de noms
et la soumission de dessins ; `ask_architect` le raccorde au coordinateur sans capacité physique. Une soumission acceptée
prouve validation et sauvegarde, pas conformité à la demande naturelle ni constructibilité sur un site.

Le monde de test actuel est l'Overworld standard : Y=-64 à 319.
L'arène par défaut va de (-48,-64,-48) à (48,-30,48).
Le reset restaure bedrock à -64, terre à -63/-62 et herbe à -61 ; le bot est téléporté à Y=-60.
Après avoir vidé l'arène, il reconstruit les couches du haut vers le bas : herbe, terre supérieure,
terre inférieure, bedrock. Chaque couche est entièrement posée avant la suivante pour éviter
la propagation d'herbe sur de la terre temporairement exposée entre les commandes espacées.
Les poches de minerai restent au-dessus de -64 : sur ce profil très mince, elles s'étalent horizontalement
sous l'herbe, avec une couche de pierre et la bedrock dessous. Pour un vrai sous-sol profond,
il faudra un profil de surface plus haut ; le générateur ne le déplace pas implicitement.

Le plan est construit et borné avant envoi, puis les commandes sont séquentielles et espacées.
Le transport collecte une courte fenêtre de retours serveur. Une erreur observée interrompt le plan
et reste visible dans ses records. Les no-ops attendus du reset (aucune entité, inventaire/effets vides,
fill sans changement) n'interrompent pas le reste.

La console annonce « Plan sent » : absence d'erreur observée ne signifie pas confirmation indépendante
de toutes les modifications. Un retour tardif peut échapper à la fenêtre ; ce n'est pas un protocole d'ACK.
Les changements déjà effectués ne sont pas annulés si une commande ultérieure échoue.
Le contrôleur est OP ; le bot principal reste sans privilèges administratifs.
Sa physique Mineflayer est désactivée dès sa création. Il reste spectateur, immobile au-dessus
de l'arène pendant le reset ; ce réglage ne concerne pas la physique du bot agent.

Le reset de terrain peut être construit séparément du reset du joueur pour un bot hors ligne.
Le lanceur de [scénarios](scenario-testing.md) vérifie l'état initial observé avant d'envoyer la demande ;
il applique ses critères déterministes séparément de la validation sémantique du coordinateur.
Les observations de blocs sont bornées à 4096 cellules explicites, sans troncature, et conservent les
propriétés de porte. La vérification finale attend l'arrêt des producteurs et `physicalIdle` puis deux
lectures connues/stables depuis le controller. Son délai est séparé de celui de la tâche : un résultat
conforme après expiration ne transforme jamais un timeout en réussite. Voir les limites de la marge
observée et de l'oracle fixe de construction dans la documentation des scénarios.
