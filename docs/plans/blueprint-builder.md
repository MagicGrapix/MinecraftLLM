# Blueprint, Architect et Builder — plan d'implémentation

> Mise à jour du 6 octobre 2026 : la surface Architect a été simplifiée après les lots ci-dessous.
> Un seul tool `submit_blueprint({ drawing })`, texte ASCII A/point avec couches séparées par une ligne vide,
> dimensions déduites, oak_planks fixe, sans portes ni lookup_material. Le Blueprint interne et le Builder
> restent inchangés. La demande/délégation est un message user, séparé du system stable.
> Les bilans de lots ci-dessous sont historiques ; [le contrat courant](../blueprints.md#architect-lot-4)
> et [l’atelier](../architect-workbench.md) décrivent les comportements actuels.

Date : 5 octobre 2026.

Statut au 10 octobre 2026 : **lots 1 à 5 et lot 7 implémentés ; lot 6 partiel et reporté à la demande de Quentin**.
Le workflow est vérifié dans Minecraft avec réponses LLM scriptées. L'essai isolé du 9 octobre avec le 27B
a produit un abri 5×5×4 correct en sept appels ; cela ne valide pas encore le workflow complet réel.
Ce document reste le plan de suivi. Les [contrats Blueprint actuels](../blueprints.md) décrivent ce qui est réellement disponible.

## Utiliser ce document

- Reprendre les lots dans l'ordre indiqué en section 10.
- Cocher une tâche seulement après implémentation et vérification ; joindre les tests ou observations correspondants.
- À la fin de chaque lot, renseigner le journal en section 12 et le prochain travail à faire.
- Mettre à jour les docs de comportement actuel lorsque le code correspondant existe, pas avant.
- Conserver les prompts personnels de Quentin ; ne modifier que les passages nécessaires à l'intégration.

**Lot 7 livré et vérifié.** Les cases ouvertes du lot 6 restent reportées, à reprendre sur demande.
Le mode Architect par couches fonctionne dans l'atelier ; son activation dans le bot reste également à faire.

## 1. Décisions retenues

- [x] Appeler le dessin en blocs **Blueprint**, distinct de la checklist de tâches du planner.
- [x] Ajouter un agent **Architect** : LLM, prompt séparé, contexte neuf par délégation, correction itérative.
- [x] Construire avec un **Builder algorithmique**, pas un nouvel agent LLM.
- [x] Exposer `build` à l'actionneur ; il n'a pas à choisir chaque déplacement ou placement.
- [x] Produire le blueprint avant de demander au planner l'organisation des ressources.
- [x] Calculer les matériaux en code ; ne pas demander au modèle de compter son dessin.
- [x] Conserver les blueprints hors conversation et transmettre leur référence et un résumé compact.
- [x] Vérifier les noms Minecraft exactement, puis proposer des alternatives déterministes si nécessaire ; aucun RAG.
- [x] Représenter la porte comme une dépendance du blueprint, avec sa position et son orientation.
- [x] Ne pas ajouter `get_blueprint_layer`, `get_build_progress` ou `get_next` au catalogue LLM initial.
- [x] Tester d'abord le constructeur sans LLM, puis la génération, puis le workflow complet.

Le format, le catalogue de matériaux, le store et le Builder avec portes existent désormais. `build` est exposé à l'actionneur.
L'Architect isolé et ses deux tools de soumission/recherche existent aussi ; son intégration au workflow reste à implémenter.

### Hors périmètre initial

- Construction bloc par bloc décidée par le LLM ; comparaison des trois méthodes plus tard.
- Framework général de multi-agents, de tâches composites ou de composants de bâtiments.
- Base de données, RAG, embeddings, éditeur 3D ou nouvelle grande interface web.
- Rotation automatique du blueprint, terrains arbitraires, terrassement ou démolition automatique.
- Escaliers, dalles, liquides, gravité, redstone et blocs à états complexes non explicitement pris en charge.
- Récolte/crafting intégrés au Builder : ils restent des tâches de l'actionneur.
- Garantie formelle de toute demande libre du joueur. La conformité au blueprint est vérifiable ; la qualité d'une maison reste une autre question.

## 2. Parcours de la demande

1. Le joueur demande une petite maison.
2. Le coordinator appelle `ask_architect` avec les contraintes utiles.
3. L'Architect consulte au besoin les noms de matériaux, puis appelle `submit_blueprint`.
4. Une soumission rejetée renvoie des erreurs précises ; l'Architect corrige dans sa conversation privée.
5. Une soumission acceptée est enregistrée et termine la délégation. Le coordinator reçoit la référence, les dimensions et les matériaux.
6. Le coordinator appelle le planner avec ces informations et le contexte actuel, dont l'inventaire du bot.
7. Le planner produit sa checklist habituelle : approvisionnement, crafting, construction, vérification selon les besoins.
8. L'actionneur exécute les étapes déléguées ; pour construire, il appelle `build` à une origine explicite.
9. Le Builder contrôle le chantier, construit et vérifie. Son résultat revient à l'actionneur, puis au coordinator via `finish_step`.
10. Le coordinator vérifie le rapport et les résultats réels avant `complete_step` et la réponse au joueur.

Le planner reste single-shot, sans tools exécutables et sans appels directs à l'Architect. Le coordinator reste le seul organisateur des délégations.
Le blueprint ne déclenche pas une construction à lui seul ; l'approbation du dessin est distincte de l'exécution physique.

## 3. Blueprint : format et conventions

### Contrat de soumission

Un seul objet JSON, sans Markdown autour :

```json
{
  "name": "small_oak_house",
  "description": "Small oak shelter with a north-facing entrance.",
  "width": 5,
  "depth": 5,
  "palette": {
    "A": "oak_planks",
    "B": "cobblestone"
  },
  "layers": [
    ["BBBBB", "BBBBB", "BBBBB", "BBBBB", "BBBBB"],
    ["AA_AA", "A...A", "A...A", "A...A", "AAAAA"],
    ["AA_AA", "A...A", "A...A", "A...A", "AAAAA"],
    ["AAAAA", "AAAAA", "AAAAA", "AAAAA", "AAAAA"]
  ],
  "dependencies": {
    "doors": [
      {
        "item": "oak_door",
        "position": { "x": 2, "y": 1, "z": 0 },
        "facing": "north"
      }
    ]
  }
}
```

### Repère

- `layers[y][z][x]` : index de couche = Y, index de ligne = Z, caractère = X.
- La première couche est Y=0 ; les couches vont du bas vers le haut.
- Les colonnes vont vers +X/est, les lignes vers +Z/sud. Nord = -Z.
- `height = layers.length` : ne pas demander une hauteur redondante au LLM.
- `width` caractères par ligne, `depth` lignes par couche ; dimensions rectangulaires autorisées.
- Positions locales entières, à partir de zéro. Aucune position absolue dans le blueprint.
- `build.origin` est la position monde de la cellule locale (0,0,0), pas la position du bot ni le centre.
- Pas de rotation en première version : les orientations locales sont aussi les orientations monde.

### Symboles et dépendances

- Lettres ASCII majuscules : blocs pleins de la palette initialement prise en charge.
- `.` : air requis. Un obstacle à cet endroit bloque la construction ; il n'est pas supprimé implicitement.
- `_` : cellule non contrainte par la grille principale.
- Une dépendance de porte occupe deux cellules `_` : sa position basse et celle immédiatement au-dessus.
- Le validateur développe la dépendance en deux blocs attendus ; ces cellules cessent alors d'être non contraintes.
- Rejeter une porte qui recouvre une lettre, un `.` ou une autre dépendance, ou qui dépasse la hauteur.
- Ne pas ajouter de gestionnaire générique de dépendances : `dependencies.doors` suffit pour cette version.
- Le Builder choisit une charnière déterministe et vérifie les propriétés prises en charge ; son réglage n'est pas laissé implicite au placement.
- Dans l'exemple, la facture finale est **55 oak_planks, 25 cobblestone et 1 oak_door**. L'espace au-dessus de la porte ne coûte pas un deuxième objet.

La première fixture du constructeur utilise le même principe sans porte : entrée en `.` et liste `doors` vide.
Le support réel de `oak_door` a été livré au lot 3 ; les autres matériaux de portes et les portes adjacentes/doubles restent refusés.

### Validation, sans effet dans le monde

- Schéma strict ; chaînes et collections bornées ; caractères ASCII simples, sans espaces significatifs ni emojis.
- Dimensions, longueur des lignes, palette complète, absence de symboles inconnus.
- IDs exacts du registre Minecraft de la version utilisée ; `minecraft:` peut être normalisé explicitement.
- Existence d'un item de placement et prise en charge de son comportement par le Builder.
- Validation des dépendances, support prévu de la porte, absence de chevauchement.
- Exiger une construction non vide. Ne pas déclarer « maison habitable » sur cette seule base.
- Retourner des erreurs localisées : chemin de champ, cellule locale si pertinente, valeur rejetée, attente et suggestions.
- Une validation réussie prouve la conformité au format et au sous-ensemble supporté, pas l'accessibilité future du terrain.

### Stockage et identité

- Enregistrer les blueprints acceptés sous `data/blueprints/<id>.json`, par écriture atomique.
- ID généré par le code, jamais chemin de fichier fourni par le modèle ; `name` n'est qu'un libellé.
- Enregistrer `formatVersion`, version Minecraft, dessin normalisé et matériaux calculés.
- Ne pas modifier un blueprint accepté : une révision reçoit une nouvelle référence. Pas de système de branches ou de versions complexe.
- Revalider à la lecture, notamment si la version Minecraft ou le sous-ensemble supporté a changé.
- Le coordinator conserve une référence structurée dans l'état de la demande, pas seulement dans un résumé compressible.
- Un nouveau plan de tâches peut garder la référence ; une nouvelle demande ne réutilise pas silencieusement un chantier actif.
- La conservation des fichiers n'implique pas une reprise automatique de la mémoire des agents au redémarrage.

## 4. Catalogue de matériaux

Créer un service partagé à partir du registre Minecraft utilisé par le runtime. Les tests et expériences de génération peuvent injecter le registre de la même version sans connecter de bot.

Outil proposé :

```json
{ "query": "oak_plate", "kind": "block" }
```

Nom : `lookup_material`. `kind` accepte `block` ou `item`, avec `block` par défaut. Retour borné : correspondance exacte éventuelle et cinq alternatives au maximum.

Classement : égalité, mots/préfixes/sous-chaînes, puis distance orthographique. Ordre stable en cas d'égalité, seuil de pertinence et possibilité de ne rien proposer.

Chaque résultat précise le nom canonique et, pour un bloc, s'il est supporté par le Builder. La recherche ne promet ni recette accessible ni disponibilité locale.

- Partager ce service entre `lookup_material` et le validateur de blueprint.
- Réutiliser les conventions existantes dans `world/queries/MinecraftNames.ts` et `WorldQueries.isKnownName` ; ne pas créer deux règles contradictoires.
- Ne jamais corriger un nom automatiquement ou utiliser la suggestion comme autorisation de substitution.
- Architect : catalogue limité à `lookup_material` et `submit_blueprint`.
- Actionneur : `lookup_material` et `build` en plus de ses outils existants.
- Planner : documentation générée des outils, comme aujourd'hui ; aucun appel exécutable.
- Coordinator : reçoit `ask_architect`, mais pas `submit_blueprint` ou `build`. La query de noms peut être partagée via le registre existant, sans refonte des permissions par rôle.

## 5. Matériaux : besoins du dessin et besoins du chantier

Le compilateur de blueprint produit des cellules attendues et des opérations de placement. Ce sont des données internes, pas une deuxième checklist LLM.

- Blocs pleins : une unité d'item par cellule à placer.
- Porte : une opération, un item, deux cellules attendues avec leurs propriétés.
- Air et cellules ignorées : aucun item.
- Matériaux temporaires : facture séparée, jamais mélangée aux matériaux définitifs.

À la soumission, retourner la facture pour une construction neuve. Au lancement de `build`, recalculer ce qui manque après observation des cellules déjà conformes.

Le planner reçoit les matériaux finis requis et l'inventaire actuel. Il planifie la récolte/craft nécessaires ; aucun moteur général de résolution de recettes n'est ajouté dans ce chantier.
Les rendements de crafting peuvent produire un surplus, notamment pour les portes : ne pas exiger un inventaire final exactement égal à la facture.
Les stations et outils de crafting sont des prérequis d'approvisionnement, pas des blocs ajoutés implicitement à la maison.

## 6. Contrat de `build`

Entrée minimale :

```json
{
  "blueprintId": "bp_generated_by_code",
  "origin": { "x": 4, "y": -60, "z": 4 }
}
```

Le chantier est identifié en interne par blueprint immuable + dimension + origine. Pas de `buildId` supplémentaire à apprendre au modèle pour cette première version.

### Préparation, avant tout mouvement ou placement

1. Charger et valider le blueprint et la dimension.
2. Vérifier l'emprise autorisée, les limites verticales et la distance maximale du chantier.
3. Observer toutes les cellules contraintes et les supports nécessaires. Une cellule non chargée reste inconnue.
4. Classer les cellules : conforme, manquante, incorrecte, inconnue.
5. Refuser les obstacles, l'air requis occupé, le sol non pris en charge et les observations inconnues.
6. Calculer les items manquants pour le travail restant et comparer à l'inventaire.
7. En cas de prérequis manquant, retourner sans déplacement, sans casse et sans pose.

La validation du terrain n'est pas une preuve qu'un chemin vers chaque position de placement existe. Les vérifications d'accès restent nécessaires pendant l'exécution.
L'inventaire et le monde sont revérifiés avant les opérations qui en dépendent ; le contrôle initial n'est pas une réservation de ressources.

### Construction et vérification

- Ordre déterministe, du bas vers le haut, en respectant les supports et un passage de sortie.
- Pour chaque opération restante, essayer une petite liste bornée de positions de travail et de faces de support.
- Contrôler la portée, la visibilité de la face et l'absence de collision avec le bot ; arriver près de la cible ne suffit pas.
- Équiper, se déplacer et poser via les opérations existantes, sans appels LLM entre les blocs.
- Attendre le retour serveur et vérifier le type et les propriétés attendues. Un succès de méthode ou une prédiction locale ne valide pas le blueprint entier.
- Relire une cible ambiguë avant de retenter pour éviter un doublon ; pas de retries physiques aveugles.
- Arrêter après épuisement des candidats, timeout, annulation ou échec non récupérable ; pas de boucle infinie sur une même cellule.
- Effectuer une vérification finale de toutes les cellules contraintes, y compris l'air requis et les deux moitiés des portes.
- Un bloc détruit depuis son placement redevient manquant. Ne pas valider le chantier avec le seul compteur des opérations passées.

La première version n'efface pas un bloc incorrect pour le remplacer. Elle rend la main avec son emplacement ; une action explicite peut préparer le chantier avant une reprise.

### Résultats compacts

Conserver le contrat `TaskResult` existant. En succès, retourner référence/origine/dimension, durée, placements effectués, éléments déjà conformes et bilan de vérification.
En échec, inclure dans `facts` un bilan partiel borné, la première cible bloquante et les prérequis manquants. Les détails complets vont aux traces.

Réutiliser les codes existants et préciser la cause dans `facts.reason` :

- `INVALID_ARGUMENT` : référence inconnue, format/version non supportée, origine invalide.
- `MISSING_ITEM`, raison `MISSING_MATERIALS` : liste `{item, required, available, missing}`.
- `BLOCKED` : obstacle, terrain non supporté, besoin d'échafaudage non géré.
- `NO_PATH` / `OUT_OF_REACH` : aucun candidat de placement accessible.
- `WORLD_CHANGED` : observation devenue indisponible ou monde incompatible pendant le travail.
- `ACTION_NOT_CONFIRMED` : placement non confirmé ; ne pas affirmer qu'il n'a eu aucun effet.
- `TIMEOUT` / `INTERRUPTED` : état partiel et règle `stillSettling` de l'Executor conservée.

Un nouveau `build` à la même origine observe le monde et ne consomme que les matériaux encore nécessaires.
Un état sauvegardé ou un ancien succès n'autorise jamais de sauter cette observation. Il n'y a pas de rollback automatique du chantier.

## 7. Verrou physique, navigation et traces

### Intégration retenue : capability composite sous un seul verrou

`build` sera une capability enregistrée normalement. L'actionneur conserve donc son chemin actuel `AgentToolBridge -> TaskFactory -> Executor`.

- Un appel `build` acquiert le verrou de l'Executor pour toute sa durée.
- Le Builder réutilise les opérations élémentaires avec le même `ExecutionContext`, signal et barrières d'annulation.
- Ne jamais rappeler `Executor.execute` depuis `build` : l'exécuteur refuserait la réentrée avec `BLOCKED`.
- Réutiliser les implémentations des capabilities par un adaptateur interne typé ; extraire un helper commun seulement si nécessaire. Valider aussi les arguments produits par le Builder.
- Ne pas utiliser un second Executor ni contourner le verrou avec des appels Mineflayer concurrents.
- Tout arrêt coupe la production des opérations suivantes. Les opérations déjà parties restent suivies jusqu'à terminaison, comme pour `goto` actuellement.
- Prévoir un timeout spécifique à `build`, appliqué dans la création du `TaskSpec`. Ne pas lui laisser le défaut actuel de 30 secondes, ni augmenter ce défaut pour toutes les capabilities.
- L'actionneur ne relance pas de LLM pendant la construction ou pendant une terminaison physique encore en cours.

### Navigation du premier jalon

- Terrain plat, petit bâtiment, positions de travail accessibles sans modification de terrain.
- `canDig=false`, `canPlace=false` pour les déplacements du Builder : ne pas casser les murs ni consommer des matériaux par surprise.
- Une construction nécessitant un accès non supporté retourne un blocage clair ; les dimensions permises ne garantissent pas que tout dessin sera constructible.
- Aucune pose ni casse hors de l'emprise déclarée ; garder une marge de circulation observée et une sortie.
- Le bot reste survival, non OP. Le world controller n'intervient que pour préparer/reset les tests.

### Extension échafaudages, après le chemin simple

- Réserver un stock temporaire de terre séparé de la facture de construction.
- Choisir des accès temporaires déterministes dans une marge bornée du chantier.
- Poser ces blocs explicitement et tracer leurs positions et états antérieurs ; ne pas attribuer au Builder tout changement observé à proximité.
- Empêcher le pathfinder de casser la structure ou d'utiliser les ressources réservées à la maison.
- Retirer uniquement les blocs temporaires dont la pose est suivie et dont l'état correspond encore à ce qui a été posé, dans un ordre permettant de sortir.
- Si le nettoyage n'est pas sûr ou échoue, conserver la liste des blocs restants et signaler un chantier incomplet, pas un succès silencieux.
- Après redémarrage, pas de nettoyage automatique sans journal de propriété fiable ; cette reprise avancée est différée.

### Observabilité

- Un appel LLM `build` = un numéro d'action dans `ToolCallJournal` et un diff global d'inventaire avant/après.
- Les sous-opérations ont des événements de chantier internes, pas de faux appels LLM ou de nouveaux tours de conversation.
- Tracer cible, opération, début/fin, erreur et bilan final ; relier les événements au numéro du `build`.
- Garder la réponse au modèle compacte et structurée. Ne pas rejouer toute la grille après chaque bloc.
- Dans l'inspecteur, identifier clairement `architect`, son `submit_blueprint` et le `build` de l'actionneur. Conserver les détails complets des soumissions dans les traces.
- Pas de refonte UI : utiliser les points d'extension existants et ne pas déplacer la sélection lors du rafraîchissement.

## 8. Architect et contexte des autres agents

### Architect

- Ajouter `prompts/architect.md`, chargé par le système de templates existant ; instructions et descriptions de tools en anglais.
- Entrée : consigne du coordinator, demande utilisateur utile, contraintes explicites, dimensions et matériaux supportés.
- Recevoir un extrait utile de la conversation joueur si nécessaire, pas les historiques internes des autres agents.
- Le terrain et l'inventaire sont des observations fournies, pas une obligation d'utiliser seulement ce qui est déjà en stock.
- Contexte privé neuf à chaque appel `ask_architect`, conservé pendant les corrections puis abandonné au handoff.
- Deux tools seulement : `lookup_material` et `submit_blueprint`. Aucun droit de construction ni commande OP.
- Soumission valide et enregistrée : retour automatique au coordinator, sans exiger un second `finish`.
- Soumission invalide : feedback dans l'historique de tools, aucune sauvegarde publiée comme acceptée.
- Limite d'itérations, annulation, erreurs structurées, budget d'entrée de 20k et observabilité identiques aux garanties des autres rôles.
- Une limite atteinte, un appel LLM tronqué ou un stop produit un échec/interruption explicite, jamais un blueprint déclaré valide.

### Coordinator, planner et actionneur

- `ask_architect` reçoit une instruction ; il retourne la référence acceptée ou un rapport d'échec, sans grille complète dans l'historique du coordinator.
- Ajouter à `WorkflowState` un contexte de construction compact : blueprint sélectionné, description, dimensions et matériaux calculés.
- Conserver ce contexte dans les délégations et les prompts, même après compression de l'historique ou remplacement de checklist.
- Changer de blueprint ne valide pas les anciens rapports et ne lance pas de démolition : demander une nouvelle checklist et réobserver le site.
- Injecter au planner les besoins exacts en objets finis et sa documentation d'outils habituelle, incluant `build`.
- L'actionneur reçoit la référence et les besoins avec la checklist et les rapports existants. Il choisit une origine observée, fixe pour le chantier, pas « devant moi » réévalué après chaque mouvement.
- Ne pas construire lors d'une demande de simple conception ou d'explication.
- Les erreurs d'approvisionnement ou de chantier sont remontées au coordinator ; ne pas implémenter une recherche automatique sans borne dans `build`.

## 9. Limites et organisation proposées

Constantes dans `src/config.ts` ou un petit `BuildingConfig.ts`, pas de nouvelles variables d'environnement :

- Largeur/profondeur maximales : 8 ; hauteur maximale : 5, soit au plus 320 cellules.
- Palette : 16 matériaux maximum ; premières dépendances limitées aux portes prises en charge.
- Suggestions de noms : 5 maximum ; erreurs de validation détaillées : 20 maximum avec nombre total signalé.
- Architect : 8 tours de tools au départ ; budget de contexte 20k existant, budget de sortie suffisant pour le JSON complet.
- Builder : 300 secondes au départ, 8 positions/faces candidates maximum par opération ; limites vérifiées dans les boucles.
- Chantier local : toutes les cellules et sa marge de circulation dans un rayon configuré, 50 blocs au départ, et dans les limites du monde.
- Échafaudages futurs : marge horizontale maximale de 2 blocs ; quantité limitée et annoncée séparément.

Ces valeurs sont des garde-fous configurables, pas des limites Minecraft. Un timeout de scénario doit tenir compte de la génération, de l'approvisionnement et de la construction, pas seulement de `build`.

### Nouveaux fichiers envisagés

Ne créer chaque fichier que lorsque le lot correspondant est commencé ; pas de squelettes inutilisés.

- `src/building/Blueprint.ts` : schémas, repère et types.
- `src/building/BlueprintValidator.ts` : validation et compilation en cellules/opérations/matériaux.
- `src/building/BlueprintStore.ts` : fichiers JSON validés, IDs et écritures atomiques.
- `src/building/Builder.ts` : préparation, sélection d'opérations, exécution séquentielle et bilan.
- `src/building/BuildVerification.ts` : observations fraîches et comparaison aux cellules attendues.
- `src/building/DoorPlacement.ts` : comportement spécifique de la dépendance porte.
- `src/capabilities/Build.ts` : adaptateur capability, sans y concentrer tout l'algorithme.
- `src/world/MaterialCatalog.ts` et `src/world/queries/LookupMaterial.ts` : service de noms et query.
- `src/agent/ArchitectAgent.ts` : boucle bornée et handoff ; helpers locaux seulement si nécessaires.
- `prompts/architect.md` : unique nouveau prompt d'agent.
- `tests/unit/building/`, `tests/fixtures/blueprints/`, `tests/e2e/BuildingScenarios.ts`.

### Points existants à adapter

- `bootstrap/createCapabilities.ts` et `bootstrap/createAgentRuntime.ts` : instancier et injecter les dépendances, puis figer les registres comme aujourd'hui.
- `agent/CoordinatorTools.ts`, `WorkflowAgent.ts`, `WorkflowState.ts` : `ask_architect` et référence structurée.
- `agent/ActionTypes.ts`, `ActionContextBuilder.ts`, `TaskContextFormatter.ts` : contexte compact de construction.
- `agent/ToolCatalogBuilder.ts`, `AgentToolBridge.ts` : catalogue/documentation cohérents, timeout du `TaskSpec` de `build`.
- `capabilities/Goto.ts`, `GotoMovements.ts`, `Place.ts` : réemploi sous le même contexte ; changements ciblés seulement si nécessaires à la pose et aux protections.
- `execution/Executor.ts` : préserver son contrat ; ne pas ajouter un second mécanisme de verrouillage.
- Inspecteur : extension minimale des types/labels pour Architect et les événements de construction.
- `docs/architecture.md`, `agent-workflow.md`, `contracts.md`, `tools.md`, `scenario-testing.md` : documentation des comportements effectivement livrés, lot par lot.

## 10. Lots d'implémentation et critères de sortie

### Lot 1 — Blueprint, noms et stockage, sans Minecraft ni LLM

- [x] Définir le schéma et les conventions de coordonnées ; créer la fixture 5x5 ci-dessus et une variante sans porte.
- [x] Implémenter le catalogue de matériaux et les suggestions bornées.
- [x] Valider les couches, noms et fonctionnalités prises en charge avec feedback localisé.
- [x] Calculer les opérations attendues et la facture d'objets, sans appel LLM.
- [x] Implémenter le store avec IDs générés, validation à la lecture et écriture atomique.
- [x] Tester dimensions incorrectes, caractères inconnus, fautes de noms, blocs reconnus mais non supportés, fichiers invalides et référence absente.
- [x] Mettre à jour les docs des nouveaux contrats réellement disponibles.

Sortie : une fixture déterministe peut être validée, enregistrée et relue ; aucun bloc Minecraft n'a été modifié.

Vérifié le 2026-10-05 : `npm.cmd test` réussi, **383 tests dont 53 nouveaux**. Schéma de porte réservé mais rejet fonctionnel explicite jusqu'au lot 3.
Le catalogue est un service hors ligne ; `lookup_material` n'est pas encore enregistré comme tool. Voir `docs/blueprints.md` pour l'API utilisable dès maintenant.

### Lot 2 — Builder de blocs pleins, sans LLM

- [x] Implémenter le précontrôle du chantier et de l'inventaire, sans mouvement en cas de rejet.
- [x] Ajouter `build` sous le verrou de l'Executor, avec son timeout propre et un adaptateur d'opérations élémentaires.
- [x] Choisir les supports, faces et positions de travail ; navigation sans casse ni échafaudage automatique.
- [x] Vérifier les placements, l'air requis et le bilan final ; gérer les positions inconnues.
- [x] Retourner des échecs bornés, l'état partiel et permettre la reprise à la même origine.
- [x] Ajouter journalisation et diff d'inventaire global du `build`.
- [x] Tester la concurrence, `stop`, timeout, barrières de terminaison et absence de réentrée de l'Executor.
- [x] Ajouter un smoke explicite sans LLM : quelques blocs, puis abri 5x5 sans porte, stock fourni.

Sortie : construction réellement posée par un bot non OP, conformité observée, reprise sans doublon et arrêt sûr. Aucun test live lancé implicitement par `npm test`.

Vérifié le 2026-10-05 : `npm.cmd test` réussi, **411 tests dont 28 nouveaux**.
`npm.cmd run smoke:build` réussi sur Minecraft 1.21.11 : deux cubes, abri de 80 blocs,
stop après deux poses, reprise des 78 restantes en environ 34 secondes, puis rappel sans nouvelle pose.
Le controller a vérifié les 100 cellules (80 blocs + 20 d'air). Les fixtures ont été retirées et le petit sol de test restauré.
Le premier essai a révélé une sortie impossible depuis le toit ; `BuildExit` filtre désormais les postures
selon une voie de retour au sol après la pose, sans augmenter la hauteur de chute du pathfinder.
Les événements internes sont reliés au taskId puis au numéro d'action ; aucun appel LLM supplémentaire.
Limites documentées dans `docs/blueprints.md` : sol plat, supports pleins, pas de démolition, portes ou échafaudages.

### Lot 3 — Porte comme dépendance

- [x] Compiler une porte en un item et deux cellules attendues ; rejeter hors-limites et chevauchements.
- [x] Implémenter son support, son orientation et la vérification des deux moitiés sur la version du serveur.
- [x] Tester une porte isolée dans les quatre orientations, puis la maison de référence.
- [x] Tester le passage : ouverture, entrée et sortie, sans modifier la structure. La conformité du dessin et le passage restent deux critères distincts.
- [x] Traiter une porte partiellement présente ou orientée autrement comme un conflit explicite, sans réparation destructive implicite.

Sortie : la facture compte une porte et le constructeur sait réellement la placer. Ensuite seulement, l'annoncer dans les matériaux supportés à l'Architect.

Vérifié le 2026-10-05 : `npm.cmd test` réussi, **429 tests dont 18 nouveaux depuis le lot 2**.
`npm.cmd run smoke:doors` réussi sur Minecraft 1.21.11, sans LLM : quatre orientations isolées,
maison de 81 placements (82 cellules occupées + 18 d'air), arrêt après 2 poses puis reprise des 79 restantes en environ 36 secondes.
Un nouvel appel ne pose rien ; ouverture, entrée, sortie, fermeture puis contrôle indépendant de toutes les cellules réussis.
Les essais ont révélé trois adaptations nécessaires : attendre la rotation réellement envoyée ; traiter les portes ouvertes
comme des passages et corriger les waypoints surélevés du pathfinder ; respecter `use_block.cursor` pour viser le panneau ouvert.
La pose orientée utilise un helper privé Mineflayer isolé et couvert par le smoke. Retester lors d'une mise à jour de cette dépendance.
Les fixtures sont retirées, le sol de test restauré et les deux bots déconnectés. Les prompts des agents restent inchangés.

### Lot 4 — Architect isolé

- [x] Ajouter prompt, schémas de tools et boucle de délégation bornée.
- [x] Réutiliser le catalogue et la validation ; terminer sur une soumission acceptée.
- [x] Appliquer les garanties de budget, annulation et logs, sans prompts inline ni ancienne phase planning/review.
- [x] Tests avec faux LLM : erreur puis correction, matériau inconnu, limite atteinte, réponse tronquée, stop et store en erreur.
- [x] Ajouter une expérience optionnelle avec le vrai LLM et le registre configuré, sans monde Minecraft ni outil physique.

Sortie : une demande peut produire un blueprint accepté et un rapport compact ; aucune construction automatique.

Livré le 2026-10-05 : `ArchitectAgent`, `ArchitectTools`, `prompts/architect.md`, `smoke:architect`.
`npm.cmd test` réussi : **448 tests, dont 19 nouveaux**, compilation et typechecks inclus.
Huit appels maximum, réponses invalides incluses ; contextes frais, replay natif, compactor partagé à 20k.
Les erreurs de validation sont corrigibles ; stockage en erreur, troncature et stop sont terminaux.
Un stop durant la publication attend l'écriture : fichier valide éventuellement conservé, référence signalée,
mais délégation `INTERRUPTED`, pas acceptée. Pas de connexion Minecraft ni de changement des prompts existants.

Essais réels Qwen3.5:9b (4096 tokens de sortie) :

- `1791201126960_16836` : maison 5×5, mauvais nombre de lignes, correction inefficace puis limite de sortie au troisième appel. Aucun fichier accepté.
- `1791201240250_10416` : après clarification des dimensions dans le schéma/exemple, grille à la bonne taille mais conflit de porte ; limite de sortie au deuxième appel. Aucun fichier accepté.
- `1791201406081_49760` : plateforme acceptée/sauvegardée/relue en un appel, référence `bp_1bf4dd51-9893-4ea9-adfb-4706e2c6cd62`.
  **Limite sémantique : deux couches produites pour une seule demandée.** Le format est valide, pas le respect de toutes les consignes.

Le validateur ne devient pas un juge de la demande naturelle. Fiabiliser le prompt/dessin avant de conclure
à une capacité de conception de maisons ; l'expérience isolée permet justement d'itérer sans modifier le monde.

### Lot 5 — Intégration dans le workflow existant

- [x] Ajouter `ask_architect` au coordinator et l'état de construction de la demande.
- [x] Transmettre référence, matériaux et contraintes au planner puis à l'actionneur.
- [x] Exposer `build` et `lookup_material` aux bons rôles ; vérifier que le coordinator n'acquiert pas de capacité physique.
- [x] Adapter légèrement les prompts concernés, sans réécrire les parties personnelles de Quentin.
- [x] Tester la conservation de la référence après compression/replanning, et sa gestion lors d'une nouvelle demande.
- [x] Tester « dessine une maison » sans construction, et « construis une maison » avec délégations dans le bon ordre.
- [x] Adapter les labels de l'inspecteur et la documentation courante.

Sortie : maison de référence avec matériaux fournis via le vrai workflow ; toutes les preuves d'exécution restent inspectables.

Livré le 2026-10-05 : `WorkflowAgent` délègue à l'Architect, `ConstructionContext` conserve le rapport
validé hors historique, les queries partagent `lookup_material`. Le coordinator ne peut pas construire ;
l'actionneur refuse un build sans référence active ou sur un ancien dessin. Changer de blueprint invalide
la checklist et ses rapports, sans toucher aux blocs existants. Échec/stop ne sélectionnent aucun nouveau dessin.

Vérifications : `npm.cmd test` — 455 tests réussis. `npm.cmd run smoke:build-workflow` réussi dans
Minecraft 1.21.11 : dessin sans effet, nouvelle demande, délégations complètes, maison de 81 poses
(55 planches + 25 cobblestone + une porte) en environ 37 s pour la capability, puis vérification indépendante
des 100 cellules et de l'inventaire. Checklist cochée, zone nettoyée et bots de test déconnectés.
Trace : `logs/trace_1791206349780_15172.jsonl`. Le client LLM est scripté, tous les autres composants sont réels.
Le prompt Architect n'a pas été modifié : l'amélioration de la conception Qwen reste à Quentin.
Ce test ne prouve pas que Qwen choisit ces délégations ni qu'il sait s'approvisionner seul.

### Lot 6 — Campagnes de bout en bout et approvisionnement

**Reporté le 10 octobre 2026 à la demande de Quentin.** Conserver les travaux et cases restantes ci-dessous ;
ne pas lancer la campagne de conception/approvisionnement LLM dans le cadre du lot 7.

- [x] Étendre l'observation E2E, auparavant limitée à 64 cellules/nom seul.
- [x] Ajouter une limite explicite adaptée au volume borné et les propriétés utiles des blocs pour les portes ; vérifier l'ensemble du volume, pas un échantillon.
- [x] Faire l'observation finale après arrêt des producteurs et `physicalIdle`, avec délai et cellules inconnues traitées explicitement.
- [x] Ajouter `build_small_shelter` : blueprint fixe, matériaux fournis, sans LLM constructeur.
- [ ] Ajouter un scénario Architect + build avec stock suffisant et contraintes de dessin modestes.
- [ ] Ajouter ensuite collecte/craft : bois accessible, ressources et stations contrôlées, puis maison avec porte.
- [x] Vérifier indépendamment du rapport du Builder : blocs attendus, air intérieur, porte, absence de modifications interdites dans le volume observé et état final du bot.
- [x] Archiver le blueprint effectivement accepté et les résultats détaillés dans le rapport de campagne.
- [ ] Commencer par un essai ciblé, puis cinq répétitions pour mesurer fiabilité, durée et nombre d'appels LLM.

Sortie : la suite distingue erreur de conception, prérequis, construction, timeout et conformité finale. Pas de nouveau scénario LLM volontairement impossible ; les prérequis manquants sont testés unitairement ou sans LLM.

Première tranche livrée le 2026-10-05 : observation explicite jusqu'à 4096 cellules, propriétés de porte,
barrière `settle`, vérification finale indépendante et store Blueprint propre à chaque essai.
`npm.cmd test` : **468 tests réussis**, compilation et typechecks inclus (13 nouveaux depuis le lot 5).
`build_small_shelter` utilise la maison fixe 5×5×4 avec porte, en survival avec stock fourni et zéro appel LLM.
Campagne ciblée `campaign_1791209143577_7aa94fb8` : **réussite en 38,16 s**, 729 cellules contrôlées,
aucun écart/inconnu, consommation de 55 planches, 25 cobblestone et une porte. Observation finale
après settlement confirmée ; blueprint accepté lié au rapport. Terrain remis à plat et bots déconnectés.
Un seul essai réel à ce stade, pas encore cinq répétitions. Le prompt Architect reste inchangé.
Restent la campagne avec conception LLM, l'approvisionnement et les répétitions : **lot 6 partiel et reporté**, pas terminé.

### Lot 7 — Accès temporaires et nettoyage, après stabilisation

- [x] Implémenter une stratégie limitée d'échafaudage en terre, avec stock et emprise bornés.
- [x] Suivre les blocs temporaires posés et protéger tous les blocs définitifs.
- [x] Tester reprise, annulation et nettoyage incomplet sans destruction du terrain d'origine.
- [x] Ajouter un scénario dont l'accès nécessite réellement les blocs temporaires.

Sortie : le bot peut accéder à une construction plus exigeante et annoncer honnêtement le nettoyage restant. Ce lot n'est pas requis pour valider la première petite maison accessible depuis le sol.

Livré le 2026-10-10 : `BuildScaffolding` construit de courts escaliers extérieurs en terre dans la marge
existante de deux blocs, jusqu'à trois blocs de haut et 24 blocs temporaires suivis. Les matériaux du
blueprint restent réservés. Le Builder ne récolte pas la terre et n'en crée pas ; un manque retourne
`MISSING_SCAFFOLD_MATERIALS`. La navigation reste sans casse ni pose automatique du pathfinder.

Chaque pose temporaire est enregistrée avant envoi, puis confirmée. Le nettoyage retire uniquement
les blocs suivis, encore identiques, depuis le sol et du haut vers le bas. Un stop n'engage aucun nettoyage
automatique ; rappeler `build` avec le même blueprint, origine, dimension et runtime reprend le suivi.
Un bloc modifié ou non confirmé reste intact avec une erreur structurée et les positions restantes.
Limites : suivi en mémoire de la session, pas après redémarrage ; pas de récupération garantie des drops ;
un remplacement externe par exactement le même état de bloc n'est pas distinguable par observation.

Vérifications : **506 tests réussis**, compilation et typechecks inclus. Régressions sur réservation de terre,
reprise, annulation pendant une pose en vol et pendant le nettoyage, blocs modifiés/incertains,
nettoyage incomplet et oracle indépendant. `build_with_scaffolding` est disponible dans la suite E2E
avec une colonne fixe de cinq blocs, stock fourni et zéro appel LLM ; campagne non lancée ici.

`npm.cmd run smoke:scaffolding` réussi sur Minecraft 1.21.11 : arrêt après deux blocs définitifs et un
bloc temporaire, reprise en 10,8 s, cinq blocs définitifs vérifiés, **six blocs de terre temporaires posés
et retirés**, puis rappel idempotent. Trace : `logs/trace_1791639349757_30064.jsonl`.
Fixture retirée, sol de test restauré et bots de test déconnectés. Aucun appel LLM ni campagne du lot 6.

## 11. Vérification et définition de « terminé »

Pour chaque lot de code, lancer `npm.cmd test` et ajouter les régressions ciblées. Les tests unitaires utilisent des doubles, sans Minecraft, Ollama ou GPU.
Les essais Minecraft et LLM restent séparés, explicites et limités à une arène de test ; leur reset est effectué par le controller OP, jamais par le bot constructeur.

La première version complète correspond aux lots 1 à 6 :

- [x] L'Architect corrige une soumission invalide puis rend une référence fiable (test avec faux LLM ; fiabilité du modèle réel non acquise).
- [ ] Les besoins sont calculés, conservés et communiqués sans recompter le dessin par le LLM.
- [ ] Le planner organise l'approvisionnement, l'actionneur appelle `build`, le Builder ne récolte pas lui-même.
- [x] Une petite maison avec porte est construite sans commandes administrateur par le bot.
- [x] Le code vérifie réellement les cellules ; le test peut entrer et ressortir.
- [ ] Une erreur ou un stop ne produit ni faux succès ni actions tardives non suivies.
- [ ] Les fichiers, appels, erreurs et résultats permettent de reproduire et diagnostiquer un essai.
- [ ] Les anciens scénarios et outils conservent leur comportement.

## 12. Journal de suivi

- 2026-10-05 : plan rédigé après lecture des frontières agents/exécution, de `goto`/`place`, des noms Minecraft et du lanceur E2E. Aucun lot de code commencé.
- 2026-10-05, lot 1 livré : `src/building/{Blueprint,BuildingConfig,BlueprintValidator,BlueprintStore}.ts`, `src/world/MaterialCatalog.ts`, schéma de nom partagé et fixtures versionnées.
  53 nouveaux tests : compilation/axes/matériaux, suggestions, erreurs bornées, stockage atomique sans écrasement, corruption, références et versions.
  `npm.cmd test` : build, typecheck tests/scripts et 383 tests unitaires réussis. Aucun appel Minecraft/Ollama ni changement des prompts.
  Limites : blocs pleins explicitement listés seulement ; portes refusées ; pas d'Architect, de `build` ou de tool de recherche exposé. Prochain lot : 2.

- 2026-10-05, lot 2 livré : `Builder`, port `BuildOperations`, géométrie/retour au sol, capability `build`, confirmation serveur et arrêt/reprise.
  411 tests réussis et smoke réel de l'abri de 80 blocs ; sans LLM. Détails en section 10, lot 2.
- 2026-10-05, lot 3 livré : `BlueprintDoors`, `BuildDoor`, `PlaceBuildDoor`, comparaison des deux moitiés, adaptations ciblées de `goto` et du curseur `use_block`.
  429 tests réussis et smoke réel quatre orientations + maison avec passage vérifié. Détails en section 10, lot 3.
  Limites : `oak_door` isolée, fermée/non alimentée, terrain plat, pas de réparation destructive ni échafaudages. Prochain lot : 4, Architect isolé.

- 2026-10-05, lot 4 livré : boucle Architect isolée, deux tools hors jeu, prompt séparé, feedback du validateur,
  rapport compact, budget d'entrée/compaction, arrêt attendu, logs et smoke LLM optionnel.
  `npm.cmd test` : 448 tests réussis ; 18 nouveaux tests Architect et un test de persistance palette + porte.
  Régression de stockage corrigée : une facture peut dépasser 16 items distincts quand une porte s'ajoute à la palette.
  Essais réels et limites de conception détaillés ci-dessus. Aucun serveur/bot Minecraft lancé pour ce lot.
  Commit de sauvegarde préalable demandé : `167199b` (`architecture lot 3`), poussé sur `refactor-redo`.
  Prochain lot : 5 ; ne pas confondre succès technique d'une soumission et respect sémantique de la demande.

- 2026-10-05, lot 5 livré : `ask_architect`, sélection de blueprint par demande, contexte partagé,
  recherche de noms partagée, garde des références de build, journal numéroté et labels d'inspecteur.
  455 tests réussis et smoke Minecraft du workflow avec client LLM scripté ; voir le bilan ci-dessus.
  Commit de sauvegarde préalable : `ba7a5cb` (`architecture lot 4`), poussé sur `refactor-redo`.
  Prochain lot : 6 ; aucun réglage du prompt Architect ni campagne Qwen effectué dans ce lot.

À compléter après chaque lot : date, tâches cochées, fichiers principaux, vérifications réalisées, limitations restantes et prochaine étape.

- 2026-10-05, lot 6 commencé : socle E2E de construction, scénario physique fixe sans LLM, oracle indépendant,
  stockage isolé et preuves de vérification dans le rapport. Voir le bilan et les cases restantes ci-dessus.
  Commit de sauvegarde préalable : `a8ff625` (`architecture lot 5`), poussé sur `refactor-redo`.

- 2026-10-10, lot 6 reporté à la demande de Quentin ; aucune campagne LLM lancée.
  Lot 7 livré : escaliers temporaires bornés, suivi par chantier, nettoyage conservateur sous le même Executor,
  scénario fixe et smoke physique avec arrêt/reprise. 506 tests réussis et six blocs temporaires retirés en jeu.
  Les prompts personnels et le protocole Architect restent inchangés. Aucun commit/push demandé pour ce lot.
  À reprendre sur demande : essais LLM du lot 6 et activation du protocole Architect par couches dans le bot.
