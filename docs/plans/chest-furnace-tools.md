# Coffre et four : lire le contenu et agir

Date : 20 octobre 2026.

Statut : lots 1 à 5 implémentés ; les trois scénarios en jeu ont réussi le 20 octobre 2026.

## Objectif

Donner à l'actionneur deux outils par équipement : un pour lire son contenu, un pour agir.
Le modèle ne gère ni ouverture, ni fermeture, ni session. Il reste responsable de ses déplacements.

Outils prévus :

- `get_chest_contents({})` : lire le coffre accessible.
- `use_chest({ direction, item, quantity })` : déposer ou retirer une quantité précise.
- `get_furnace_contents({})` : lire le four accessible et son état de cuisson.
- `use_furnace({ inputItem, quantity, fuel })` : cuire une quantité précise et récupérer le résultat.

Aucun argument de position, de rayon, de session, de slot ou de mode automatique.
Les descriptions, exemples et messages envoyés au modèle sont en anglais.

## Décisions communes

### Accès et choix de la cible

- Les outils ne marchent pas, ne cherchent pas de ressources, ne posent pas l'équipement et ne cassent rien.
- Un ajustement du regard pour ouvrir le bloc est permis, sans déplacer le bot.
- Rechercher seulement des blocs chargés dans un petit voisinage borné. Proposer un rayon local de huit blocs,
  centralisé dans la configuration : ce rayon de diagnostic n'est pas la portée d'interaction.
- S'il existe une seule cible accessible du type demandé, l'utiliser.
- S'il existe plusieurs cibles accessibles, retourner une erreur d'ambiguïté et demander de se repositionner.
  Ne pas choisir arbitrairement un coffre dont le contenu pourrait être différent.
- Si aucune cible n'est accessible, fournir les faits observés sur la cible proche pertinente :
  position, distance, visibilité et éventuel obstacle. Sinon signaler qu'aucune cible chargée n'a été trouvée localement.
- Le bot peut utiliser séparément les outils existants de recherche, `goto` et `get_block_access`.
  Aucun appel préalable à `get_block_access` n'est obligatoire.
- Réutiliser la géométrie de `BlockAccess`, avec les règles propres à l'interaction.
  Son verdict `canDig`, la possibilité de casser le bloc et l'obligation d'être au sol ne sont pas
  des critères génériques d'ouverture d'une fenêtre.
- Lecture et action partagent exactement la même sélection. Chaque appel vérifie de nouveau la cible ;
  une lecture ne réserve pas un équipement pour un appel ultérieur. Le résultat identifie toujours sa position.

### Une seule opération visible par appel

Ouvrir, lire ou transférer, puis fermer sont des détails internes. Les résultats du modèle ne contiennent
pas de `sessionId`, de `windowId` ni d'instructions telles que « appelle open_container puis close_container ».

Le feedback reste opérationnel : « le coffre est trop loin », « deux coffres sont accessibles »,
« il manque deux bûches », « le transfert n'est pas confirmé ».
Il peut indiquer qu'il faut se rapprocher, mais n'exécute jamais ce déplacement.

Conserver les détails techniques et les sous-opérations dans les traces de l'appel parent,
sans créer de faux appels de l'actionneur ni recopier cette trace dans son contexte.

### Lecture du contenu et verrou physique

Lire le contenu via Mineflayer nécessite d'ouvrir brièvement une fenêtre.
Les quatre outils passent donc par les capabilities et le verrou existant de l'Executor,
y compris ceux nommés `get_*`. Ne pas les enregistrer comme des queries du monde sans effet physique.

Ces lectures ne transfèrent aucun item. Elles retournent un instantané serveur puis ferment la fenêtre.
La cuisson d'un four peut continuer naturellement pendant la lecture.
Un contenu inconnu ou non reçu ne doit jamais être présenté comme un contenant vide.

Les outils sont appelables par l'actionneur. Le planner reçoit leur documentation via le catalogue
existant ; aucun nouveau pouvoir physique n'est donné au planner ou au coordinateur.

## Contrats des quatre outils

### `get_chest_contents`

Entrée :

```json
{}
```

Résultat : position du coffre, liste compacte des items et quantités, confirmation de fermeture.
Exemple de données utiles :

```json
{
  "position": { "x": 3, "y": -60, "z": 0 },
  "items": [{ "item": "oak_log", "count": 4 }],
  "closed": true
}
```

La liste contient uniquement les items du coffre, jamais l'inventaire du bot.
Agréger les ressources ordinaires par nom ; ne pas prétendre distinguer des variantes enchantées ou
renommées avec cette interface minimale. La V1 et ses tests portent sur des items ordinaires.
Ne pas exposer les indices de slots pour des transferts qui n'en ont pas besoin.

Succès : le contenu a été observé et la fenêtre fermée.
Cela ne garantit pas que ce contenu sera encore identique au prochain appel.

### `use_chest`

Entrées :

```json
{ "direction": "deposit", "item": "oak_log", "quantity": 2 }
```

```json
{ "direction": "withdraw", "item": "oak_log", "quantity": 2 }
```

`quantity` est le nombre exact d'items à transférer pendant cet appel, pas un stock final cible.
Valider le nom de l'item, la quantité positive, la disponibilité et la capacité du destinataire.

Ouvrir le coffre, effectuer le transfert, vérifier les variations opposées dans le coffre et
l'inventaire du bot, puis fermer. Vérifier de nouveau les préconditions même après une lecture réussie.
La lecture préalable reste facultative : elle est utile quand le modèle ne connaît pas le contenu.

Retour compact : position, direction, item, quantité demandée, quantité confirmée transférée,
stock final de cet item côté bot et coffre, fermeture.
Un succès prouve le transfert exact confirmé, pas seulement la résolution de la promesse Mineflayer.

### `get_furnace_contents`

Entrée :

```json
{}
```

Retourner la position et les trois emplacements logiques :

- `input` : item à cuire et quantité, ou `null` si vide confirmé.
- `fuel` : combustible encore présent et quantité, ou `null`.
- `output` : résultat disponible et quantité, ou `null`.
- État de cuisson observé et progression, si disponibles ; sinon indiquer une valeur inconnue.
- Confirmation de fermeture.

Ne pas exposer de slots numériques. Distinguer un emplacement combustible vide d'un four éteint :
du combustible déjà consommé peut encore entretenir la cuisson.
Cette lecture ne récupère pas le résultat et ne recharge pas le four.

### `use_furnace`

Entrée :

```json
{ "inputItem": "raw_iron", "quantity": 3, "fuel": "coal" }
```

V1 : four standard, `raw_iron` vers `iron_ingot`, charbon.
`quantity` est le nombre de minerais de cet appel à cuire ; le code déduit le produit et le combustible
nécessaire. Les autres recettes ou combustibles reçoivent un feedback explicite « non pris en charge ».

Ouvrir, vérifier les ingrédients et la place pour les lingots, alimenter, attendre la cuisson,
récupérer la production confirmée, fermer.
Ne pas absorber silencieusement une sortie préexistante dans le résultat de cet appel.
La V1 exige des emplacements vides et aucune cuisson préexistante ; sinon elle explique l'état
observé sans déplacer les items déjà présents. Pas de scénario en jeu consacré au four occupé.

Retour compact : position, quantité demandée, minerai inséré, lingots récupérés et éventuels
items laissés dans le four. Distinguer les items réellement observés des quantités inconnues.

Le délai de cuisson est séparé du délai de confirmation d'inventaire. La limite d'action doit permettre
la quantité acceptée, avec une marge bornée ; ni attente infinie ni timeout standard trop court.
Les bornes restent des constantes de configuration, pas des arguments supplémentaires du modèle.

Une interruption peut laisser des ingrédients dans le four et la cuisson peut continuer côté serveur.
Ne pas présenter cet arrêt comme une annulation des changements déjà réalisés.
La lecture du four permettra ensuite de comprendre cet état ; la reprise automatique d'une cuisson
interrompue et la récupération isolée d'une ancienne sortie restent hors V1.

## Lots d'implémentation

### Lot 1 — Accès, fenêtres et confirmations communs

- [x] Ajouter un petit helper partagé pour la sélection locale et le diagnostic d'accès.
- [x] Réutiliser les calculs géométriques de `src/world/BlockAccess.ts` sans changer le contrat de `dig`.
- [x] Réutiliser les mécanismes de fenêtre et de fermeture existants ; conserver `ContainerSessionManager`
  uniquement là où il reste utile en interne, sans maintenir une API de sessions destinée au modèle.
- [x] Refuser de remplacer ou de fermer une fenêtre étrangère à l'appel.
- [x] Attendre les données initiales du serveur avant de lire ou modifier le contenu.
- [x] Observer les confirmations de la fenêtre ouverte, en filtrant son identité et les paquets concernés.
  Les seules prédictions locales de Mineflayer ne constituent pas une preuve.
- [x] Tenir compte de la limite actuelle de `ServerInventoryConfirmation.synchronize` :
  cette méthode exige une fenêtre fermée. Confirmer le contenu du contenant pendant son ouverture,
  puis fermer et resynchroniser l'inventaire du bot si nécessaire ; ne pas appeler cette méthode fenêtre ouverte.
- [x] Réutiliser `waitForConfirmation` et les constantes de confirmation existantes pour les attentes courtes.
  Une attente de confirmation ne renvoie jamais automatiquement le transfert.
- [x] Respecter signal, deadline et barrière physique jusqu'à la fin du nettoyage, même après annulation.
- [x] Réutiliser les erreurs structurées existantes ; ajouter seulement les cas réellement manquants.
- [x] Reporter les effets partiels confirmés et l'incertitude après erreur. Une fermeture non confirmée
  interdit un succès ; ne pas masquer une erreur de nettoyage.

Critère de fin : sélection cohérente, aucun déplacement caché, aucune fenêtre ni promesse physique
abandonnée après retour, et distinction nette entre vide confirmé et état inconnu.

### Lot 2 — Lecture et transfert du coffre

- [x] Implémenter `get_chest_contents` et `use_chest` avec le même helper de cible.
- [x] Réutiliser la logique utile d'`OpenContainer`, `TransferItem` et `CloseContainer` sans appeler un second Executor.
- [x] Confirmer les quantités dans les deux inventaires et préserver le bilan lors d'un transfert partiel.
- [x] Cibler le coffre ordinaire pour cette première version ; signaler clairement les types de stockage
  non pris en charge au lieu de prétendre couvrir tous les anciens conteneurs.
- [x] Remplacer les trois anciens outils dans `src/bootstrap/createCapabilities.ts`.
- [x] Retirer les sessions publiques et consignes devenues inutiles d'`ActionContextBuilder`
  et du raccordement dans `createAgentRuntime`.
- [x] Mettre à jour les aides d'`UseBlock` qui orientent encore vers `open_container`.
- [x] Retirer le code devenu réellement inutilisé, tout en conservant les protections et tests applicables.

Critère de fin : lire, déposer ou retirer ne demande jamais au modèle de gérer une session.

### Lot 3 — Lecture et cuisson du four

- [x] Implémenter `get_furnace_contents` avec l'API native Mineflayer et les confirmations serveur.
- [x] Implémenter `use_furnace` pour le couple minerai de fer brut/charbon, sans nouvelle dépendance.
- [x] Vérifier les préconditions avant insertion ; refuser les contenus préexistants sans les déplacer.
- [x] Séparer attente de cuisson et confirmation des transferts ; maintenir l'annulation et un timeout adapté.
- [x] Confirmer les lingots réellement récupérés, la consommation des ingrédients et la fermeture.
- [x] Retourner un bilan partiel fiable en cas d'arrêt, de déconnexion ou de perte d'accès.
- [x] Enregistrer les outils et remplacer les aides erronées vers l'outil inexistant `open_furnace`.

Critère de fin : le modèle peut lire un four puis faire fondre ses trois minerais en un seul appel d'action.

### Lot 4 — Catalogues, traces, documentation et tests hors ligne

- [x] Rédiger des descriptions anglaises courtes : `Does`, `Success`, `Limits`, `Notes`, avec exemples d'arguments.
- [x] Préciser « bot inventory » et « chest/furnace contents » sans ambiguïté dans les résultats.
- [x] Vérifier que les quatre outils sont appelables par l'actionneur et documentés au planner.
- [x] Garder un seul numéro d'appel et un seul résultat public par outil ; rattacher les détails techniques
  à cet appel dans les traces existantes, sans nouvelle interface de monitoring.
- [x] Vérifier que les mécanismes de diff d'inventaire restent compatibles avec ces capabilities.
- [x] Adapter les tests de catalogue, contexte et bootstrap ; rechercher toutes les références actives
  aux anciens outils et sessions. Préserver les anciens logs archivés.
- [x] Tester lecture vide/non vide, attente des données initiales, absence de transfert pendant la lecture.
- [x] Tester dépôt/retrait exacts, ressources insuffisantes, destination pleine et nom d'item invalide.
- [x] Tester cible absente, hors portée, masquée, ambiguë ou changée après détection.
- [x] Tester cuisson réussie, contenu préexistant refusé, sortie non confirmée et combustible insuffisant.
- [x] Tester confirmations retardées, effets partiels, absence de double envoi, timeout, interruption,
  déconnexion et nettoyage de la fenêtre.
- [x] Actualiser `docs/tools.md`, `docs/contracts.md`, `docs/architecture.md` et les skills concernés
  sans réécrire les prompts personnels de l'utilisateur.
- [x] Exécuter `npm.cmd test` lors de l'implémentation et corriger les régressions.

Critère de fin : les nouveaux contrats sont cohérents dans le code, le contexte et la documentation.

### Lot 5 — Scénarios isolés et validation en jeu

#### Coffre : réutiliser `chest_deposit`

- [x] Conserver le coffre vide proche du bot et quatre `oak_log` dans l'inventaire initial.
- [x] Demander explicitement de lire le coffre, d'y déposer deux bûches et de conserver les deux autres.
- [x] Vérifier que la lecture demandée a eu lieu, sans imposer les noms d'outils dans le prompt.
- [x] Vérifier indépendamment : coffre avec deux bûches, bot avec deux bûches, bloc intact et fenêtre fermée.
- [x] Conserver `chest_withdraw` comme régression : quatre bûches dans le coffre, en retirer exactement deux.
- [x] Vérifier que la lecture NBT du controller distingue toujours l'état inconnu d'un coffre vide.

L'ancienne campagne `1791041256182_341a0acd` échouait à la préparation des deux scénarios :
inventaire du coffre inconnu, aucun appel LLM. Ne pas confondre une nouvelle erreur de préparation
avec un échec de l'actionneur.

#### Four : ajouter `smelt_iron`

- [x] Placer un four vide à une position fixe proche du bot, par exemple `(3, surfaceY + 1, 0)`.
- [x] Fournir trois `raw_iron` et un `coal`, sans lingot initial.
- [x] Utiliser une seule consigne, par exemple :

  > Inspect the nearby furnace, smelt the three raw iron in your inventory using your coal, then collect all three iron ingots.

- [x] Vérifier que la lecture a eu lieu et que le bot a terminé la demande.
- [x] Vérifier indépendamment les trois lingots en inventaire, l'absence de minerai restant,
  le four intact et la fermeture de la fenêtre.
- [x] Observer les slots du four depuis le controller si nécessaire, avec un parseur NBT adapté au four :
  ne pas détourner le parseur de coffre ni prendre le rapport du modèle comme oracle.
- [x] Prévoir une limite initiale de 300 secondes par essai, cuisson comprise.
- [x] Mettre à jour le registre de scénarios, leurs tests hors ligne et `docs/scenario-testing.md`.
- [x] Lancer explicitement `chest_deposit`, `chest_withdraw` et `smelt_iron`, une fois chacun,
  dans l'arène autorisée après validation du périmètre de lancement.
- [x] Lire les rapports et distinguer échec de setup, erreur d'outil, timeout et mauvaise décision du modèle.

Critère de fin : les trois scénarios terminent avec leurs critères déterministes vérifiés.

## Hors périmètre de cette première version

- Pas de nouvel agent, de gestionnaire générique de stations ni de nouvelle dépendance.
- Pas de coordonnées ou de sessions ajoutées au schéma des quatre outils.
- Pas de mouvement, collecte, crafting de four ou gestion automatique du combustible manquant.
- Pas de recettes de cuisson universelles, haut fourneau, fumoir ou stockage spécialisé.
- Pas de reprise automatique d'une cuisson interrompue, réorganisation de four occupé ou rollback fictif.
- Pas de scénario de four déjà occupé ; seule la protection correspondante est testée hors ligne.
- Pas encore de scénario complet bois -> pierre -> fer : les interactions isolées doivent être validées d'abord.

## Suivi

Cocher uniquement les tâches réellement livrées. Pour chaque lot, noter les tests exécutés, leurs résultats
et les limites restantes. Un test préparé mais non exécuté en jeu reste non validé.

### Livraison du 20 octobre 2026

- Lots 1–3 : `StationInteraction`, `ServerWindowObservation`, `Chest` et `Furnace`.
  Les anciens outils et `ContainerSessionManager`, devenus inutiles, ont été retirés.
  Les fenêtres restent internes à l'appel ; le code ne déplace pas le bot.
- Lot 4 : schémas, branchements, landmarks et documentation actualisés. Aucun prompt d'agent modifié.
  Tests hors ligne : serveur simulé distinct des prédictions locales, erreurs, délais, cibles ambiguës,
  remplacement de fenêtre, interruption, déconnexion, transfert partiel et absence de double envoi.
  Deux helpers de tests existants ont été corrigés pour accepter les fins de ligne Windows.
  Validation finale : `npm.cmd test` réussi, compilation et typages inclus ; 699 tests unitaires réussis.
- Lot 5 : une répétition par scénario avec le modèle local `qwen-27b` et Minecraft Java 1.21.11.
  Vérification indépendante après arrêt du workflow et stabilisation, pas seulement un rapport du modèle :
  - [Dépôt coffre](../../logs/scenarios/campaign_1792489474641_4836dd3c/report.html) : réussi, 73,73 s.
    Bot 4 → 2 bûches, coffre 0 → 2, lecture confirmée, coffre intact et fermé.
  - [Retrait coffre](../../logs/scenarios/campaign_1792489599377_35a6fd75/report.html) : réussi, 118,74 s.
    Bot 0 → 2 bûches, coffre 4 → 2, lecture confirmée, coffre intact et fermé.
  - [Cuisson fer](../../logs/scenarios/campaign_1792489792657_0b0d3ec9/report.html) : réussi, 129,88 s.
    Trois minerais et un charbon deviennent trois lingots ; input/output vides, four intact et fermé.
    `use_furnace` dure environ 31,5 s dont 30 s de cuisson, sous un seul appel de l'actionneur.

Ces durées excluent la préparation/nettoyage du monde. Une réussite par scénario ne mesure pas un taux
de fiabilité. Les limites V1 ci-dessus restent applicables : coffre simple, fer brut/charbon uniquement,
pas de récupération automatique d'une cuisson interrompue. L'arène est revenue au terrain plat de base.
