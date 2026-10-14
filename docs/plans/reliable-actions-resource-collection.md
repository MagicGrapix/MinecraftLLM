# Confirmations fiables et collecte automatique — plan de suivi

Date : 13 octobre 2026.

Statut : **lots 1 à 5 implémentés ; lot 6 en cours**.
Cocher les tâches après implémentation et vérification, puis renseigner le journal final.
Ce plan complète [le plan Blueprint / Builder](blueprint-builder.md) sans reprendre ses lots reportés.

## Décisions et points ouverts

- Confirmer les effets d'un craft et d'une pose avant d'enchaîner les opérations qui en dépendent.
- Vérifier immédiatement, puis toutes les **100 ms**, pendant **3 000 ms maximum** ; sortir dès confirmation.
- Trois secondes sont un délai de confirmation choisi, pas une garantie de synchronisation Minecraft.
  Une expiration signifie « effet non confirmé », et ne prouve pas l'absence d'effet physique.
- Ajouter une capability algorithmique `collect_resource`, appelée une seule fois par l'actionneur.
- Réutiliser les capabilities physiques sous le même verrou de l'Executor, sans appels LLM internes.
- Fonctionner sur sol plat et relief modéré, avec obstacles et cibles en hauteur ; pas seulement en superflat.
- Retourner un bilan concis au modèle et conserver le détail des opérations dans les traces et la UI.
- Garder le correctif des réponses textuelles imitant les tools hors périmètre pour l'instant.
- Décrire l'abri comme ayant une entrée ouverte ; ne pas ajouter de fabrication/pose de porte au workflow.

Choix validés par Quentin le 13 octobre :

- **Ressources initiales** : bûches, terre et cobblestone ; charbon et fer ensuite.
- **Scaffolding après collecte** : retrait lorsque l'accès est sûr et signalement des blocs laissés.

Les constantes suivantes sont des valeurs initiales proposées, à ajuster avec les essais :
rayon de recherche 32 blocs, maximum 50 depuis l'origine de l'appel ; quantité de 1 à 256 items ;
délai global de 300 secondes ; petite réserve de 8 dirt, au plus 24 poses temporaires par appel,
avec accès en hauteur limité initialement à 3 blocs au-dessus d'un appui local sûr.
Ces limites restent dans le code, pas dans de nouvelles variables d'environnement.

## Lot 1 — Confirmer le crafting

Point de départ : `src/capabilities/Craft.ts` attend chaque `bot.craft`, mais contrôle le gain immédiatement
après la série. Les tests positifs actuels actualisent leur faux inventaire avant de résoudre la promesse.
Mineflayer peut aussi prédire des changements locaux avant confirmation du serveur.

- [x] Définir `ACTION_CONFIRMATION` dans `src/config.ts`, avec `pollIntervalMs: 100` et `timeoutMs: 3000`.
- [x] Ajouter un petit mécanisme d'attente annulable dans `src/runtime/`, partagé avec la pose seulement pour les parties réellement communes.
- [x] Observer les confirmations serveur avant de lancer l'opération ; ne pas accepter une simple prédiction locale.
- [x] Choisir dans l'adaptateur d'inventaire un mécanisme de confirmation/resynchronisation serveur vérifiable pour la version installée.
  Une mise à jour d'un slot sans rapport avec la recette ne confirme pas le craft. Ne pas envoyer une requête réseau à chaque tick du polling.
- [x] Confirmer chaque exécution de recette avant la suivante, notamment le résultat rangé, les ingrédients et l'absence d'item bloqué sur le curseur.
- [x] Conserver le contrat de quantité minimale produite : demander 7 planches exécute deux recettes et peut en produire 8.
- [x] Au bout du délai, rendre `ACTION_NOT_CONFIRMED` avec gain attendu/observé et état de confirmation ; conserver le diagnostic détaillé dans les traces.
- [x] En cas d'échec partiel, arrêter la série et rapporter le gain déjà confirmé. Ne pas rejouer automatiquement toute la demande.
- [x] Respecter `AbortSignal`, déconnexion et barrières `deferCancellationUntil` ; aucune opération tardive concurrente.

Vérification :

- [x] Tester confirmation immédiate, confirmation retardée, aucune confirmation, mise à jour non pertinente et prédiction annulée par le serveur.
- [x] Tester plusieurs recettes successives, quantité non multiple du rendement, inventaire initial non vide et échec après production partielle.
- [x] Tester annulation pendant l'attente et absence de listeners/timers résiduels.
- [x] Faire un smoke sans LLM des crafts 2x2/3x3 avec inventaire vérifié indépendamment depuis le controller.
  Inclure des demandes 7 et 64, puis une séquence visant au moins 79 planches ; contrôler ingrédients, curseur et absence d'items inattendus.
- [x] Si les créations inattendues de boutons ou les incohérences persistent, examiner la synchronisation des clics de crafting.
  Ne pas considérer le polling final comme une preuve que la cause est corrigée.
  Aucun item inattendu lors du smoke ; le défaut historique n'est pas reproduit dans cet essai contrôlé.
  Le contrôle compare tous les totaux d'items à la recette et refuse aussi les changements concurrents inattendus.
  L'adaptateur protocolaire est borné à Java 1.21.11, sans modifications de `node_modules`.

## Lot 2 — Confirmer la pose malgré une erreur ambiguë

Point de départ : `Place.ts` convertit les erreurs Mineflayer en `WORLD_CHANGED`.
`MineflayerBuildOperations.place` possède un observateur serveur installé avant la pose,
mais retourne immédiatement lorsque la capability échoue, avant d'attendre sa confirmation supplémentaire.
La séquence « air, erreur, bloc attendu reçu plus tard » a été reproduite en simulation ;
elle n'est pas prouvée comme cause des trois échecs de la session Minecraft.

- [x] Centraliser la confirmation d'une pose dans le chemin commun à `place` et au Builder ; éviter deux délais de trois secondes cumulés.
- [x] Capturer destination et bloc attendu, puis installer l'observation serveur avant l'envoi de la pose.
- [x] Sur succès Mineflayer ou erreur ambiguë après envoi, observer immédiatement puis toutes les 100 ms, au plus trois secondes après le retour de cette tentative.
- [x] Accepter une confirmation du bloc attendu déjà reçue pendant l'appel, ou reçue pendant cette attente, à la bonne destination.
- [x] Conserver les vérifications de propriétés exigées par le Builder ; la confirmation commune ne les remplace pas.
- [x] Ne pas réenvoyer de pose pendant l'attente. À expiration, retourner `ACTION_NOT_CONFIRMED` avec cause initiale, cible et dernier état observé.
- [x] Garder les échecs de précondition explicites : inventaire vide, support absent, destination occupée avant envoi. Ils ne nécessitent pas cette attente.
- [x] Une cellule inconnue, une déconnexion ou une annulation ne deviennent jamais un succès ; conserver la distinction avec un bloc incorrect effectivement observé.
- [x] Conserver les protections d'annulation et la fin réelle de la promesse physique avant libération du verrou.

Vérification :

- [x] Tester bout en bout dans l'adaptateur : erreur Mineflayer sur air puis confirmation tardive du bon bloc => succès sans seconde pose.
- [x] Tester air persistant, mauvais bloc, prédiction locale seule, confirmation reçue pendant l'appel, arrêt et déconnexion.
- [x] Faire un smoke sans LLM avec le petit blueprint existant et contrôle indépendant des cellules depuis le controller.
- [x] Enregistrer le déroulement des confirmations pour distinguer un vrai refus d'un diagnostic trop précoce.

## Lot 3 — Collecteur : contrat et boucle de base

Entrée minimale : `collect_resource({ item: "oak_log", quantity: 20 })`.
`quantity` est un **gain supplémentaire d'items dans l'inventaire**, pas un stock total cible ni un nombre de blocs à casser.
Des stacks ramassées d'un coup peuvent dépasser la quantité demandée ; rapporter le gain réel.
Un nom d'item valide dans Minecraft n'est pas nécessairement une ressource supportée par ce collecteur.

- [x] Ajouter `CollectResourceCapability`, enregistrée dans `src/bootstrap/createCapabilities.ts`, avec schéma strict et délai propre.
- [x] Introduire un petit catalogue de ressources : item demandé, blocs sources, conditions de récolte/outils nécessaires.
  Par exemple, `cobblestone` peut provenir de `stone` avec un outil adapté ; ne pas supposer un drop identique au bloc.
- [x] Rejeter un item inconnu ou une ressource non prise en charge avant toute action. Documenter les ressources effectivement supportées.
- [x] Capturer l'origine, la dimension et l'inventaire initial ; garder la recherche bornée à cette origine même si le bot se déplace.
- [x] Vérifier place disponible dans l'inventaire et outil capable de produire le drop ; équiper un outil disponible sans le crafter automatiquement.
- [x] Chercher par lots bornés dans les chunks chargés ; réutiliser la recherche coopérative existante et son annulation.
- [x] Considérer le loot correspondant déjà au sol avant de casser davantage de blocs, quand sa récupération est raisonnable.
- [x] Choisir une cible, vérifier son état et son accès, naviguer, équiper, dig, rejoindre les drops et confirmer le gain d'inventaire.
- [x] Relire les positions des drops mobiles ; disparition d'une entité ou succès de `goto` ne prouvent pas son ramassage.
- [x] Réévaluer le gain après les déplacements et avant une nouvelle extraction ; les ramassages en route peuvent avoir fourni des ressources utiles.
- [x] Dédupliquer les cibles observées et limiter les tentatives par cible ; passer à une autre après épuisement des essais.
- [x] Arrêter sur objectif atteint, absence de progression, délai, annulation ou prérequis bloquant, avec bilan partiel.
- [x] Garder toutes les opérations sous l'Executor parent, avec le même `ExecutionContext` ; aucune réentrée de l'Executor ni second verrou.

Découpage réalisé, sans framework de plugins :

- `src/collection/ResourceCollector.ts` : boucle et bilan.
- `ResourceCatalog.ts` : ressources et prérequis.
- `ResourceAccess.ts` : préconditions de récolte et choix de l'outil ; essais bornés dans la boucle.
- `ResourcePickup.ts` : choix d'une case praticable près de la surface où le drop tombe.
- `MineflayerCollectionOperations.ts` : réemploi des capabilities et queries avec le contexte parent.
- `CollectionConfig.ts` / `CollectionTypes.ts` : constantes et contrats nécessaires.

Vérification :

- [x] Tester « possède déjà 1, demande 4 supplémentaires » => objectif atteint seulement avec gain confirmé d'au moins 4.
- [x] Tester drops retardés, stacks multiples, inventaire plein, outil manquant/cassé, cible disparue, terrain non chargé et cible inaccessible.
- [x] Tester qu'un gain temporaire puis consommé/perdu ne satisfait pas le stock supplémentaire encore disponible à la fin.
- [x] Tester stop/timeout pendant navigation, dig et ramassage, avec bilan partiel et conservation du verrou si une opération termine encore.

Les traces `collect.event` et le bilan compact sont présents dès ce lot ; l'UI du lot 5 reste inchangée.
Ces limitations initiales de navigation ont été levées au lot 4, sous limites conservatrices.
Les constructions du joueur non enregistrées restent inconnues : utiliser une zone de test.

## Lot 4 — Accès sur relief modéré et réserve de terre

`goto` accepte déjà `canDig` et `canPlace`, avec terre/cobblestone en stock.
Le scaffolding du Builder suppose un chantier plat ; ne pas l'appliquer tel quel à un terrain bosselé.

- [x] Utiliser d'abord un accès direct ; autoriser ensuite des modifications locales bornées nécessaires au passage.
- [x] Réutiliser le pathfinder et les contrôles de portée/visibilité ; ne pas assimiler distance proche et accès effectif au bloc.
- [x] Préserver les blocs cibles jusqu'au dig explicite, les stations/coffres/lits et les chantiers connus ; éviter de prélever du bois dans un bâtiment connu.
  Ne pas promettre une reconnaissance parfaite de toutes les constructions du joueur.
- [x] Traiter le relief local : appui stable, place pour le corps, petite montée/descente et possibilité de revenir au sol.
- [x] Encadrer la consommation et les poses de scaffolding ; si nécessaire, adapter l'observation des opérations internes du pathfinder.
  Son bilan actuel des changements locaux n'est pas une preuve serveur ni une preuve de propriété des blocs.
- [x] Ajouter une acquisition bornée de dirt lorsque l'accès nécessite une petite réserve manquante.
  Chercher un gisement directement accessible, sans invoquer récursivement `collect_resource` ni dépendre de nouveau scaffolding.
- [x] Ne pas creuser l'appui du bot, la bedrock, une sortie indispensable, ni descendre vers le vide ; ne pas engager de franchissement de liquide/falaise non pris en charge.
- [x] Séparer matériaux collectés pour l'objectif et matériaux temporaires. Ne pas dépenser le gain demandé en dirt/cobblestone comme scaffolding.
- [x] Suivre chaque pose temporaire, sa position et sa confirmation. Une observation de terre à cet endroit ne suffit pas à autoriser son retrait.
- [x] Appliquer la politique de nettoyage choisie par Quentin ; si retrait, seulement les blocs suivis encore identiques et accessibles sans danger.
- [x] Rapporter les blocs laissés après réussite partielle, timeout ou stop ; ne pas poursuivre un nettoyage physique après annulation.
- [x] Distinguer collecte réussie et nettoyage incomplet ; un bloc temporaire laissé ne doit pas masquer la quantité réellement ramassée.

Vérification :

- [ ] Fixtures fixes : petite butte, creux, obstacle, bûche surélevée avec dirt en stock, puis même cible sans dirt initial.
- [x] Tester réserve introuvable, accès trop haut, budget de poses épuisé, retrait devenu impossible et bloc temporaire modifié par un tiers.
- [x] Tester que le collecteur ne tourne pas en rond et explique brièvement le blocage quand le relief sort des limites.

## Lot 5 — Bilan compact et détail sous l'appel

- [x] Retourner un `TaskResult` avec bilan compact : item, demandé, gain confirmé, sources repérées, sources cassées,
  cibles dont l'accès a échoué, nombre de scaffolds laissés et durée. Ajouter une cause courte en échec.
- [x] Compter les positions sources distinctes, pas les résultats répétés de recherche. Une tentative d'accès ratée n'est pas une preuve d'inaccessibilité définitive.
- [x] Séparer compteurs de blocs et quantités d'items ; préciser les cibles abandonnées après essais dans le contrat du compteur.
- [x] Viser moins de 1 000 caractères pour le bilan envoyé au LLM, sans liste de coordonnées ni inventaires complets.
  Le détail reste dans les traces ; ne pas tronquer du JSON pour respecter cette taille.
- [x] Conserver un seul numéro global pour l'appel LLM `collect_resource` et un seul diff d'inventaire parent.
- [x] Relier les événements internes au `taskId`, au tool call et au numéro parent ; attribuer un index local aux opérations, affichable comme `42.1`, `42.2`.
- [x] Tracer début/fin, opération, stratégie, cible/position, arguments, durée, résultat/erreur et changements confirmés.
  Capturer aussi les opérations de dig/pose internes au pathfinder nécessaires pour expliquer le trajet.
- [x] Ne pas créer de faux appels LLM dans `ToolCallJournal`, ni compter ces opérations comme des décisions de l'actionneur.
- [x] Ajouter dans la UI existante une liste dépliable des sous-opérations sous l'appel parent, avec erreurs visibles et sélection stable.
- [x] Charger les détails à la demande/par pages ; ne pas recopier toute la trace dans chaque round ni dans le contexte LLM.
- [x] Dans le rapport de scénarios, distinguer appels LLM et opérations physiques internes pour garder des statistiques justes.

Vérification :

- [x] Un collect exécutant plusieurs goto/dig reste un seul tool call du modèle ; toutes les opérations internes sont consultables et reliées.
- [x] Tester bilan sous la limite, erreurs/arrêt visibles, grand nombre d'événements, consultation après fin et absence de rechargement qui déplace la sélection.
- [x] Vérifier que les traces ne prétendent pas connaître une confirmation ou une cause qu'elles n'ont pas observée.

## Lot 6 — Intégration, prompts ciblés et validation finale

- [ ] Ajouter la description concise de `collect_resource` : action, preuve de succès, limites et exemple d'arguments.
- [ ] Vérifier que le catalogue de l'actionneur et la documentation générée du planner incluent le tool ; le coordinator ne l'exécute pas.
- [ ] Adapter uniquement les passages utiles des skills de collecte et des prompts à l'usage de cette capability ; conserver les edits personnels de Quentin.
- [ ] Dans les prompts Architect actifs et expérimentaux, clarifier `open entrance` sur deux blocs d'air superposés.
  Éviter de promettre une porte réelle dans délégations/résumés. Ne pas supprimer dans ce lot le support historique des portes du Builder.
- [ ] Actualiser `docs/architecture.md`, `docs/contracts.md`, `docs/tools.md`, les docs de scénarios et de debug touchées.
- [ ] Exécuter `npm.cmd test` après chaque lot de code cohérent.
- [ ] Ajouter des scénarios déterministes sans LLM : collecte simple, terrain bosselé, accès avec acquisition de dirt,
  collecte partielle, arrêt en cours d'opération et gain supplémentaire avec stock initial.
- [ ] Contrôler depuis le controller les inventaires et cellules pertinentes, indépendamment du rapport du collecteur.
- [ ] Après ces vérifications, lancer un essai avec LLM : collecter du bois, puis approvisionner/crafter/construire un abri à entrée ouverte.
- [ ] Comparer temps, nombre d'appels LLM et erreurs avec la session de référence, à modèle/prompt/scène documentés.
  Un essai réussi valide le parcours, pas encore sa fiabilité statistique ; laisser les répétitions comme campagne explicite ultérieure.

## Ordre et critères de livraison

1. Lots 1 et 2 : confirmations fiables, vérifiées sans LLM.
2. Lot 3 avec traces du lot 5 dès le départ : collecte de base vérifiable.
3. Lot 4 : réserve de terre, relief et suivi des poses temporaires.
4. Fin du lot 5 et lot 6 : inspection UI, intégration, documentation et essai complet.

La fonctionnalité est prête lorsque la quantité supplémentaire est confirmée, les échecs rendent un bilan exploitable,
stop interrompt les nouvelles opérations, le relief modéré est testé et les opérations internes se consultent sous un seul appel.
Le travail sur la forme des réponses LLM et les lots de construction reportés restent séparés.

## Journal de suivi

- 2026-10-13 : plan créé ; aucune implémentation ou exécution Minecraft/LLM dans cette étape.
- 2026-10-13 : recommandations validées, lot 1 livré. Smoke `npm.cmd run smoke:craft` : demandes 7/64/7
  produisant 8/64/8 planches (80 au total), table, sticks, pioche en 3x3 et recette 2x2 à la table.
  Inventaires relus indépendamment par NBT depuis le controller ; curseur/grille vides, aucun item inattendu.
  Trace : `logs/trace_1791892745018_30960.jsonl`. Table temporaire retirée et inventaire du bot de test vidé.
  `npm.cmd test` : compilation, vérifications TypeScript et **519 tests réussis** (12 nouveaux tests de confirmation).
  La première exécution dans le sandbox Windows a rencontré des `EPERM` sur `realpath` ; la suite complète
  relancée avec les permissions normales est verte. Aucun appel LLM pendant cette validation.
- 2026-10-13 : lot 2 livré. `PlaceCapability` confirme les poses directes et les cubes du Builder,
  même après rejet ambigu ; suppression de la seconde attente dans `MineflayerBuildOperations`.
  `ACTION_NOT_CONFIRMED` conserve cible, nom attendu, dernier état local/serveur et cause initiale.
  Les préconditions restent immédiates ; seuls les items ayant un bloc du même ID sont acceptés.
  La confirmation spécialisée des portes et leurs vérifications de propriétés sont inchangées.
  `npm.cmd test` : **545 tests réussis**, dont 26 nouveaux tests. Le cas air/refus/bloc tardif
  utilise le plugin de pose Mineflayer installé, avec événements réseau simulés, sans seconde pose.
  Smoke `npm.cmd run smoke:build` réussi sans LLM : deux cubes puis abri de 80 blocs,
  arrêt après deux poses, reprise des 78 restantes, vérification indépendante et rappel sans nouvelle pose.
  **82 poses confirmées**, aucune erreur de pose dans ce smoke ; il ne reproduit pas le défaut historique.
  Trace : `logs/trace_1791894030582_60460.jsonl` (`place.confirmation`, relié au taskId parent).
  La structure temporaire a été retirée et l'herbe restaurée ; le serveur et le bot principal n'ont pas été redémarrés.
- 2026-10-14 : lot 3 livré. `collect_resource` collecte des bûches, dirt et cobblestone sous le verrou parent,
  avec quantité supplémentaire, inventaire serveur, catalogue strict, limites de recherche/essais et bilan partiel.
  Les opérations internes sont indexées dans `collect.event`, sans appels LLM ni nouveaux numéros globaux.
  `npm.cmd test` : **580 tests réussis**, compilation et vérifications TypeScript incluses.
  Smoke `npm.cmd run smoke:collect` réussi sans LLM : 1 bûche initiale + 4 collectées = 5,
  pierre refusée sans pioche, puis 2 cobblestones avec pioche et 2 dirt ; inventaires vérifiés par NBT controller.
  Les essais ont révélé un ciblage de drops encore en chute, puis une arrivée trop éloignée du ramassage.
  Le collecteur vise désormais une case praticable proche de la surface d'arrivée ; tests de régression ajoutés.
  La fixture refuse les drops préexistants et nettoie ses drops résiduels pour isoler les relances.
  Trace finale : `logs/trace_1791961569206_62372.jsonl` ; blocs restaurés et inventaire de test vidé.
  Le serveur local a été démarré pour la vérification ; aucun agent LLM lancé et aucun prompt modifié.
  Le lot 2 est sauvegardé/poussé sur `refactor-redo` au commit `89d17d0` ; le lot 3 a été poussé au commit `489405c`.
- 2026-10-14 : lot 4 : accès direct, obstacles bornés, réserve de 8 dirt et marches confirmées une à une.
  Les tours sous les pieds sont désactivées dans le collecteur ; les marches sont recalculées après confirmation.
  Le filtre de hauteur porte sur les pieds, pas sur les cellules de dégagement de tête du pathfinder.
  Chantiers connus protégés en mémoire du runtime ; 24 poses maximum, pas de nettoyage après stop,
  abandon du retrait d'un bloc changé par un tiers, `scaffoldsLeft` explicite. Observateurs serveur mutualisés.
  Les fixtures réelles de relief additionnelles et l'essai LLM sont suivis dans le lot 6.
  Smoke `smoke:collect -- --terrain` : collecte de base et bûche à Y+7 réussies avec puis sans dirt initial.
  Sans réserve initiale : gain confirmé de 1, 3 supports laissés et signalés ; avec réserve : gain de 1,
  aucun support laissé. Inventaires contrôlés indépendamment par NBT. Trace `trace_1791964910580_70188.jsonl`.
  Suite courante : 595 tests réussis (inclut les tests de projection du lot 5, commité séparément).
- 2026-10-14 : lot 5 livré : bilan compact (cause limitée, détail intégral dans JSONL), sous-opérations
  liées au numéro parent, consultation à la demande par pages de 50 dans Debug (local).
  Inspection réelle avec 125 opérations : pagination 50/100, erreur dépliable en rouge, sélection en pause.
  Les statistiques distinguent les opérations internes des tools LLM et ne doublent pas leurs compteurs.
  Stockage UI borné (64 collectes, 2 000 opérations par collecte), traces complètes conservées sur disque.
  `npm.cmd test` : 596 tests réussis, compilation et typage inclus. Aucun appel LLM.
