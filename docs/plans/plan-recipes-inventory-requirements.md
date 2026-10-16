# Recettes du plan et critères de réussite sur inventaire

Date : 16 octobre 2026.

Statut : lots 1 à 5 implémentés et validés hors ligne. `npm.cmd test` : 672 tests réussis.
Lot 6 préparé, mais validation en jeu différée à la demande de Quentin. Aucun lancement de Minecraft ou du LLM.

## Objectif

Conserver les recettes nécessaires avec le plan, transmettre une étape sans reformulation du coordinateur,
clarifier que l'inventaire observé est celui du bot et introduire des critères d'inventaire évalués par le code.
Le critère de réussite en langage naturel reste obligatoire. Les checks numériques le complètent,
sans le remplacer ni prouver à eux seuls que la demande utilisateur a été satisfaite.

Cette évolution remplace la proposition de validation groupée de plusieurs étapes. Elle ne crée pas de
nouvel agent, ne réécrit pas les capabilities et ne modifie pas l'Architect ni le Builder.

## État avant implémentation et points de raccordement

- `WorkflowState.ts` définit chaque étape par `title` et `successCriteria`, puis ajoute numéro et statut.
- `PlannerAgent.ts` accepte le plan par `submit_plan`. Son retour contient les références consultées dans
  `recipeCoverage`, pas les fiches. Ce suivi ne distingue pas les recettes choisies des simples consultations.
- `WorkflowAgent.ts` stocke les étapes et transmet à l'actionneur le plan complet, l'étape et les rapports.
  Il transmet aussi `run_step.instruction`, rédigé par le coordinateur.
- `ActionContextBuilder.ts` injecte ce contexte dans le système et cette instruction dans un message user.
- `complete_step` exige actuellement un rapport réussi pour la même étape et le même plan. La réussite
  sémantique n'est pas évaluée automatiquement.
- `RecipeLibrary`, `RecipeTools` et `RecipeRenderer` fournissent déjà les fiches validées et leur rendu.
- `InventoryAdapter` agrège les stacks. `ServerInventoryConfirmation` sait demander une observation serveur
  complète et bornée pour Java 1.21.11. Le journal existant conserve des inventaires avant/après les appels,
  mais ne constitue pas un évaluateur de l'inventaire courant.

## Contrat implémenté

### Recettes associées à chaque étape

Ajouter `recipes` aux étapes, liste facultative de références `{ item, variant }`, vide par défaut.
Le planner choisit explicitement les variantes documentées qui fondent son plan ; il ne recopie pas les fiches.
À `submit_plan`, le code résout les références, vérifie qu'elles sont valides et ont été consultées avec succès,
puis conserve un instantané dédupliqué des recettes sélectionnées avec le plan accepté.

Une référence invalide ou non consultée renvoie du feedback au planner sans remplacer le plan précédent.
Une recette absente de la bibliothèque n'interdit pas une étape : références vides, incertitude conservée,
pas de fiche inventée. Les consultations inutilisées restent dans les traces, pas dans le contexte actif.

Rendu court, généré par le code à partir des ingrédients et rendements validés :

```text
Recipes — quantities per craft:
oak_planks (variant 1): 1 oak_log -> 4 oak_planks; inventory 2x2.
stick (variant 1): 2 oak_planks -> 4 stick; inventory 2x2.
wooden_axe (variant 1): 3 oak_planks + 2 stick -> 1 wooden_axe; crafting table 3x3.
```

Le coordinateur voit les recettes retenues une fois dans le contexte système du plan. L'actionneur voit
les recettes de son étape, ainsi que le plan complet pour comprendre les réserves nécessaires aux suivantes.
Les grilles complètes restent disponibles via `read_recipe` pour le planner et l'actionneur, pas le coordinateur.
Ne pas recopier les mêmes fiches complètes dans l'historique et le contexte système.

Les quantités de recette sont des quantités par craft ; la quantité à produire et les lots entiers restent
la responsabilité du planner. Une référence de recette ne force pas actuellement Mineflayer à utiliser cette
variante : les capabilities choisissent une recette réalisable. Ne pas présenter cette documentation comme
une garantie d'ingrédients exacts consommés ; une contrainte stricte de variante demandera un contrat dédié.

### Délégation sans reformulation

Remplacer `run_step({ step, instruction })` par `run_step({ step })`.
Le code transmet l'étape originale, son critère, les recettes, l'objectif utilisateur, le plan complet,
les rapports précédents et le monde courant. Générer un message user stable : `Execute step 5 of the current plan.`
Ne pas demander au coordinateur de réécrire des recettes, quantités ou séquences de capabilities.

Conserver les instructions de `ask_planner` et `ask_architect` pour objectifs, contraintes et feedback.
Un changement d'objectif d'étape passe par un nouveau plan. Une adaptation d'exécution repose sur les
observations et rapports déjà transmis, sans recréer un champ libre de substitution dans `run_step`.

### Un champ texte pour les checks

Conserver `successCriteria` en langage naturel et ajouter un seul champ texte `checks`, facultatif et vide
par défaut. Le JSON extérieur de `submit_plan` reste inchangé dans son principe ; aucune structure
imbriquée de conditions n'est demandée au modèle. Exemple de contenu du champ :

```text
inventory_count(oak_planks) >= 3
inventory_count(stick) >= 2
```

Règles fixes :

- Une comparaison par ligne ; toutes les lignes doivent être vraies.
- Seule fonction autorisée : `inventory_count(item)`.
- Comparaisons autorisées : `>=`, `==`, `<=`.
- `item` est un nom exact du registre Minecraft connecté, sans guillemets ni préfixe de namespace.
- Le nombre est un entier sûr, non négatif, écrit en décimal.
- Un champ vide signifie « aucune vérification déterministe définie », pas « étape réussie ».
- Au plus 8 lignes non vides et 2 000 caractères par champ, limites centralisées dans la configuration.

Les quantités agrègent les slots de stockage et la barre rapide. Elles n'incluent pas coffre, drops,
curseur, grille de craft, armure ou seconde main. `inventory_count` mesure le stock actuel : il ne mesure
pas un gain et ne prouve pas comment les items ont été obtenus.

Exemple complet d'étape :

```json
{
  "title": "Have at least 4 sticks available",
  "successCriteria": "The bot inventory contains at least 4 stick items.",
  "recipes": [{ "item": "stick", "variant": 1 }],
  "checks": "inventory_count(stick) >= 4"
}
```

Le planner écrit les lignes dans `submit_plan` et corrige sa soumission après feedback. Il n'a pas à
sélectionner un mode de validation. Pas de tool pour fabriquer chaque opérateur et pas de store séparé
de critères : ils appartiennent à l'étape. Son numéro dans le plan courant suffit pour les évaluer.

### Parser et lectures internes autorisées

À `submit_plan`, analyser intégralement chaque ligne non vide avec une grammaire fermée. Autoriser
les espaces autour des éléments et les fins de ligne Windows/Unix ; ne pas réinterpréter une syntaxe
incorrecte. Vérifier fonction, opérateur, nom d'item, entier et limites avant toute acceptation du plan.
Rejeter le texte supplémentaire, commentaires, calculs, appels imbriqués, OR/AND explicites et accès aux
propriétés. Aucun `eval`, `Function`, moteur de scripts ou accès dynamique à une méthode par nom fourni.

Une seule ligne invalide fait refuser la soumission entière, sans effacer ni modifier le plan précédent.
Le feedback précise étape, ligne, expression reçue, erreur et exemple autorisé :

```text
Invalid checks — step 4, line 2:
inventory_total(stick) >= 4
Unknown function "inventory_total". Allowed: inventory_count(item).
Example: inventory_count(stick) >= 4
Plan not accepted. Previous plan unchanged.
```

Le parser produit une petite représentation typée interne, conservée avec le texte original et le plan.
Les objets techniques restent côté application : le LLM reçoit les checks textuels lisibles, pas un nouvel
arbre JSON. Les traces peuvent conserver les deux pour le diagnostic.

Lors de `evaluate_step`, le code relie la fonction reconnue à une lecture interne explicitement autorisée.
Pour cette version, `inventory_count` lit les totaux d'un inventaire confirmé fourni par le runtime.
Ce lecteur n'est pas un tool ajouté au catalogue du LLM et n'appelle pas une capability. Un dispatch
explicite suffit : pas de framework de plugins. Aucun nom arbitraire ne peut atteindre les APIs du jeu.
Le parser n'interroge pas l'inventaire ; seul l'évaluateur obtient une observation, une fois pour tous les checks.

Un check autorisé n'est pas nécessairement réalisable ni pertinent pour l'objectif. Le parser ne résout
pas Minecraft : il valide le contrat et les contradictions simples sur un même item, sans planifier à la place du modèle.

### Évaluer et compléter

Exposer `evaluate_step({ step })` au coordinateur et à l'actionneur. L'actionneur peut seulement évaluer
l'étape de sa délégation ; le coordinateur peut consulter toute étape du plan courant.
Cet outil observe et calcule, sans cocher de case, sans capability, sans LLM supplémentaire.

Exemple de feedback texte transmis au modèle :

```text
Step 5 — not satisfied.
oak_planks: 3 >= 3 — true
stick: 1 >= 2 — false
Checks only; review the success criterion and action evidence before completing the step.
```

Conserver un résultat structuré interne et dans les traces : verdict, valeurs mesurées par ligne et raisons
d'indisponibilité. Ne pas doubler le feedback avec ce JSON dans la conversation du modèle.
Le verdict porte seulement sur les checks : `true`, `false` ou `null` si inconnus.
Si le champ est vide, retourner « No deterministic checks defined » avec une raison interne explicite
`NO_DETERMINISTIC_REQUIREMENTS`, jamais une réussite par défaut. Une indisponibilité porte une autre raison explicite et ne devient pas un zéro.
Un mauvais index est une erreur d'argument. Une condition non satisfaite est une évaluation réussie,
pas une erreur d'exécution du tool. Une déconnexion/expiration est une observation indisponible.

Le fournisseur de preuves vérifie connexion, validité de l'état joueur et absence d'opération physique
encore en cours, puis obtient un inventaire serveur confirmé via l'adaptateur existant. Attente bornée et
annulable, aucun nouvel envoi d'action physique. Pas de fermeture automatique d'un coffre : si la fenêtre
empêche la confirmation, renvoyer une indisponibilité explicite ; l'actionneur peut choisir `close_container`.
Le calcul pur reçoit un seul snapshot cohérent pour toutes les conditions.

`complete_step` réévalue les conditions sur une observation fraîche avant de cocher : un ancien résultat
`evaluate_step: true` n'est pas un jeton d'autorisation réutilisable après consommation des items.

- Checks présents : toutes les conditions doivent passer ; faux ou inconnu empêchent de cocher.
- Checks absents : aucune garantie numérique supplémentaire ; conserver la vérification existante.
- Dans les deux cas, conserver le dernier rapport réussi de la même étape/version comme précondition,
  et l'examen du critère naturel par le coordinateur. Un check vrai ne contourne pas ce garde-fou.

Une étape déjà satisfaite peut être constatée par l'actionneur sans rejouer une action physique inutile,
mais elle garde son rapport de vérification. Retirer cette précondition de rapport n'est pas inclus ici.

Ne pas permettre à l'actionneur de cocher le plan. Conserver un seul appel natif par tour et
`complete_step({ step })` pour une seule étape. Aucun batch ni nouvelle boucle d'orchestration.
Une case cochée enregistre une réussite au moment de sa validation ; elle n'impose pas de conserver
éternellement les matériaux intermédiaires consommés par les étapes suivantes.

## Limites à expliquer aux agents

Un prédicat déterministe peut être mal choisi par le planner. Vérifier une expression ne prouve pas
qu'elle traduit la demande utilisateur. Le coordinateur compare toujours le plan et la demande ; il ne
doit pas réduire « fabriquer » à « posséder » lorsque la méthode fait partie de la demande.

Valider forme, noms, nombres et contradictions simples pour un même item ; ne pas construire
un solveur de faisabilité Minecraft. Un critère faux ne déclenche ni boucle automatique ni nouvelle
collecte : le modèle décide d'agir, de demander un plan corrigé ou de rapporter le blocage.
Ne jamais retirer silencieusement une ligne invalide ni remplacer un champ invalide par un champ vide.

Pour « collecter trois nouvelles bûches » ou « fabriquer une hache », le stock seul n'est pas une preuve
suffisante. Conserver cette exigence dans `successCriteria` et vérifier les TaskResults et les observations
avant/après déjà disponibles, notamment le diff d'inventaire. Aucun calcul automatique de gain lié à
l'étape ni nouvelle baseline n'est ajouté dans ce lot ; ne pas le laisser croire dans les prompts.

Ajouter sobrement aux prompts concernés :

```text
Inventory observations refer to the bot, not the player.
Crafting an item does not give it to the player.
```

Tous les schémas, descriptions, feedbacks et ajouts de prompts pour les agents restent en anglais.
Conserver les sections de prompts personnelles non concernées.

## Lot 1 Recettes liées aux étapes

- [x] Étendre le schéma du plan avec les références de recettes, validées contre les lectures réussies du planner.
- [x] Résoudre et copier les recettes à la soumission ; dédupliquer dans `WorkflowState` et remplacer
  atomiquement étapes/recettes/rapports. Une soumission invalide conserve tout l'ancien plan.
- [x] Ajouter le rendu court au coordinateur et le sous-ensemble de l'étape à l'actionneur.
- [x] Garder `recipeCoverage` comme diagnostic de traces, pas comme une pseudo-fiche opaque dans le prompt.
- [x] Borner les références : au plus 4 par étape, 16 recettes uniques par plan, sans troncature silencieuse.
- [x] Garder les grilles détaillées derrière `read_recipe` et le budget d'entrée partagé à 20k.
- [x] Tester variantes, références invalides/non consultées, déduplication, replanification et contexte.

Fichiers principaux : `WorkflowState.ts`, `PlannerAgent.ts`, `RecipeTools.ts`, `RecipeRenderer.ts`,
`WorkflowAgent.ts`, `ActionTypes.ts`, `ActionContextBuilder.ts`, `TaskContextFormatter.ts`.

## Lot 2 Délégation et prompts ciblés

- [x] Retirer `instruction` du schéma `run_step` et de `ActionDelegation` ; générer le court message d'activation.
- [x] Garder objectif, plan, étape, rapports et recettes inchangés pendant leur transmission.
- [x] Adapter les validations d'entrée de `ActionAgent`, les doubles de test et tous les appelants.
- [x] Clarifier les inventaires dans les prompts et supprimer les consignes qui demandent la reformulation.
- [x] Garder `ask_planner.instruction` et `ask_architect.instruction`.
- [x] Tester que la délégation ne peut plus injecter une autre recette ni perdre les contraintes du plan.

## Lot 3 Checks textuels et parser strict

- [x] Ajouter le champ texte `checks` à `submit_plan` ; conserver `successCriteria` obligatoire et documenter
  une condition par ligne, la fonction autorisée, les comparaisons et les limites.
- [x] Créer `StepChecks.ts` pour le parser fermé et sa représentation typée interne ; ni modes ni objets
  de conditions à générer par le modèle. Conserver le texte lisible dans les contextes d'agents.
- [x] Valider toutes les lignes à la soumission, noms compris ; retourner un feedback précis par étape/ligne
  et conserver atomiquement l'ancien plan si une recette ou un check est invalide.
- [x] Relier `inventory_count` par code explicite à une lecture interne autorisée, absente du catalogue LLM.
  Séparer parsing, acquisition du snapshot et calcul ; aucun appel physique durant ces opérations.
- [x] Créer un évaluateur pur `StepCheckEvaluator.ts`, sans dépendance au LLM ni aux agents.
- [x] Réutiliser les totaux d'inventaire et adapter `ServerInventoryConfirmation` derrière un lecteur injecté
  de preuves connues/inconnues ; préserver les confirmations déjà utilisées par craft et collecte.
- [x] Tester espaces/fins de ligne, champ vide, plusieurs lignes, limites, fonctions/opérateurs inconnus,
  texte supplémentaire, noms invalides, nombres invalides et contradictions simples.
- [x] Tester stock vide connu, observation inconnue, plusieurs stacks, comparaisons, toutes les lignes
  nécessaires et snapshot unique ; vérifier qu'aucun texte arbitraire ne peut exécuter du code.

## Lot 4 Évaluation exposée aux agents et complétion protégée

- [x] Exposer `evaluate_step` par le workflow et le bridge actionneur avec le même service injecté,
  sans ajouter une dépendance globale au workflow dans les queries du monde.
- [x] Protéger le périmètre de délégation et les références au plan courant ; rejeter les retours obsolètes
  après arrêt, remplacement du plan ou changement de demande.
- [x] Faire réévaluer les checks présents par `complete_step` avant toute mutation, sans réutiliser un ancien vrai.
- [x] Conserver les rapports requis et l'examen du critère naturel ; un check vrai seul ne coche rien.
  Si le stock suffit déjà, l'actionneur peut vérifier et rendre son rapport sans refaire le craft.
- [x] Montrer critères lisibles, preuves et résultat dans les traces et le rendu debug existant, sans nouvelle page.
  Une condition fausse n'est pas un crash ; une erreur du tool reste présentée comme erreur.
- [x] Adapter les prompts : consulter les critères si utile, ne pas surcollecter après échec partiel,
  conserver les ressources prévues pour les étapes suivantes, demander un nouveau plan en cas d'incohérence.

## Lot 5 Régressions et documentation

- [x] Tests faux LLM : plan avec recettes/critères, correction d'une soumission invalide, délégation
  non reformulée, consultation depuis les deux rôles et maintien du budget de contexte.
- [x] Tests complétion : faux/inconnu refusés, résultat ancien vrai devenu faux, preuve par mauvais index,
  check vrai sans rapport, rapport périmé, champ vide et nouvelle demande.
- [x] Vérifier le feedback texte compact, les détails internes dans les traces, le rejet des expressions non
  autorisées avant lecture de l'inventaire et l'absence des lecteurs internes parmi les tools LLM.
- [x] Vérifier que les observations/diffs et garanties de gain existantes de collecte ne changent pas ;
  `inventory_count` ne doit jamais être décrit comme une preuve de nouvelle collecte ou de fabrication.
- [x] Tests lifecycle : action encore en terminaison, fenêtre ouverte, déconnexion/respawn,
  timeout et annulation ne produisent jamais un inventaire vide ni une réussite.
- [x] Tester que craft et collecte gardent leurs garanties de confirmation serveur.
- [x] Actualiser `docs/architecture.md`, `docs/agent-workflow.md`, `docs/contracts.md`, `docs/tools.md`,
  `docs/recipes.md` et les fixtures/smokes concernés avec le comportement réellement livré.
- [x] Exécuter `npm.cmd test` après intégration ; aucune dépendance nouvelle prévue.

## Lot 6 Validation en jeu après accord

Différé : validation hors ligne uniquement demandée le 16 octobre 2026.
Quatre scénarios sont prêts : `checks_axe_from_empty`, `checks_existing_stock`, `checks_new_axe`
et `checks_additional_logs`. Leurs oracles indépendants sont testés hors ligne ; les scénarios
n'ont pas été exécutés en jeu. Les contradictions sont couvertes par le parser et les tests avec faux LLM,
pas par une nouvelle tâche impossible imposée au bot.

- [ ] Hache depuis inventaire vide : recettes correctes, stock suffisant, vraie fabrication observée,
  aucune instruction de recette réécrite et réponse finale distinguant bot/joueur.
- [ ] Stock déjà présent : objectif de possession satisfait sans craft inutile ; demande de fabrication
  nouvelle non validée par les anciennes unités.
- [ ] Collecte additionnelle avec un stock initial : vérifier que le rapport et les preuves existantes,
  pas le seul check de stock, justifient les nouveaux items. Aucun prédicat de gain n'est supposé disponible.
- [ ] Critère contradictoire ou irréaliste : feedback ou blocage explicite, aucun faux succès ni boucle automatique.
- [x] Conserver les oracles indépendants des scénarios : le test ne doit pas utiliser comme vérité
  uniquement le critère que le planner a lui-même inventé.

## Hors périmètre

Pas de critères de gain (`inventory_gain`), de baselines d'étape, de modes de validation, de critères de
blocs/position, de langage logique général, d'éditeur visuel, d'agent vérificateur, de validation multi-étapes
ou de preuve automatique de causalité. Les plans restent en mémoire pour la demande,
avec leur copie dans les logs ; pas de base de données, de Git pour l'état du monde ni de migration persistante.

## Suivi

- 16 octobre 2026 : plan proposé. Ordre recommandé : lots 1 et 2, puis lots 3 et 4 ensemble,
  puis régressions et essai en jeu. L'évaluateur n'est pas livré tant que la complétion peut le contourner.
- 16 octobre 2026 : plan simplifié après discussion. Les conditions deviennent un texte `checks`,
  parsé et relié à des lectures internes autorisées ; seul `inventory_count` est prévu au départ.
  Les modes, objets de conditions imbriqués et baselines de gain sont retirés. Le critère naturel et
  les préconditions de rapport sont conservés. Implémentation en attente d'une prochaine instruction.
- 16 octobre 2026 : lots 1 à 5 livrés. Recettes figées avec le plan, délégation sans reformulation,
  checks textuels fermés, lecture serveur confirmée et évaluation partagée. `complete_step` refuse
  faux/inconnu et conserve sa précondition de rapport réussi. Le debug distingue évaluation et complétion.
  Compilation, vérification des types et 672 tests hors ligne réussis. Aucun nouveau paquet installé.
  Lot 6 : scénarios préparés, essais Minecraft/LLM reportés sur demande explicite.
