# Contrats et limites

## Exécuter, observer, valider

- `goto` réussit quand son objectif de navigation est atteint. Cela ne valide ni le prochain `dig`,
  ni le ramassage d'un item. Le déplacement peut casser/poser selon ses options.
- `get_block_access` indique la portée et une face visible localement. Ce n'est pas une autorisation
  du serveur. Une valeur inconnue ne signifie pas « air ».
- `dig` vérifie après l'opération que la cible n'est plus solide. Si la cellule n'est plus observable,
  il retourne `WORLD_CHANGED` avec `verification: unknown`, jamais un succès.
  Il ne prouve pas que la ressource est entrée dans l'inventaire.
- `get_dropped_items` décrit les stacks observées au sol. `get_inventory` décrit l'inventaire actuel
  du bot. Un item présent ne prouve pas un gain : comparer avec l'observation initiale.
- `finish_step` rend un rapport. `complete_step` exige un rapport réussi correspondant à l'étape
  et à la version courante du plan, puis met à jour la checklist. La vérification du critère reste
  sémantique ; aucun moteur de prédicats déterministes n'est encore implémenté.

## Annuler une capability

Un timeout ou `stop` déclenche l'AbortSignal. L'exécuteur attend au plus une seconde de grâce
pour rendre un résultat TIMEOUT/INTERRUPTED. Une promesse Mineflayer peut continuer après ce retour.
Dans ce cas, `facts.stillSettling` vaut true et le verrou reste détenu jusqu'à la fin de la capability
et de ses opérations enregistrées. Toute nouvelle action est refusée avec BLOCKED.

Il n'y a pas de relance automatique d'action physique. Si l'opération ne se termine jamais, le verrou
ne se libère pas artificiellement : inspecter le log et reconnecter le processus du bot.
Un résultat d'annulation ne garantit pas l'absence de changements déjà appliqués.

## Contrôleur de monde

Le monde de test actuel est l'Overworld standard : Y=-64 à 319.
L'arène par défaut va de (-48,-64,-48) à (48,-30,48).
Le reset restaure bedrock à -64, terre à -63/-62 et herbe à -61 ; le bot est téléporté à Y=-60.
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
