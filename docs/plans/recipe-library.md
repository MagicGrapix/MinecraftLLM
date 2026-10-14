# Bibliothèque de recettes et planner conversationnel

Date : 14 octobre 2026.

Statut : **lots 1 à 4 implémentés et validés hors ligne**. Essai LLM et campagne Minecraft non lancés.
Les items de validation réelle restent ouverts.
Cocher chaque tâche après implémentation et vérification. Renseigner le journal en fin de document.

## Objectif

Permettre au planner de consulter des fiches recettes compactes, puis de produire un plan fondé sur
leurs ingrédients, rendements et stations. Les fiches sont éditables, avec un fichier par objet.
Le planner possède une conversation privée comme les autres agents : consigne, observations,
appels de tools, résultats, puis retour explicite au coordinateur.

Cas de référence : « craft an axe and then build a small wood shelter using the axe to collect wood faster ».
La session `1791990167778_15904` a exposé deux erreurs : hache prévue dans une grille 2x2 et seulement
deux planches prévues au lieu de trois. La correction a nécessité une nouvelle planification et une collecte supplémentaire.

## Décisions retenues

- Un fichier JSON par objet dans `recipes/`, pouvant contenir plusieurs variantes.
- Un rendu texte lisible par le modèle : `[A] [A] [ ]`, légende et quantités, résultat et station.
- Des ingrédients avec des noms Minecraft explicites ; aucune catégorie inventée comme `any_wood`.
- La quantité indiquée en sortie correspond à **une exécution** de recette.
- Une recette se consulte même avec un inventaire vide et sans table de crafting placée.
- Une fiche absente signifie « connaissance absente de cette bibliothèque », pas « objet impossible à obtenir ».
- Les fiches documentent le crafting ; les capabilities existantes continuent d'exécuter et de vérifier les crafts.
- Les tools de recettes sont accessibles au planner et à l'actionneur. Le coordinateur reçoit le plan final.
- Le planner a un contexte neuf par délégation et conserve tous ses échanges pendant cette délégation,
  sous les règles de budget/compaction existantes. Il termine avec `submit_plan`.
- Aucun enchaînement de phases imposées : il peut lire, comparer, continuer sa discussion, puis soumettre.
- Les tools, feedbacks et prompts destinés aux agents restent en anglais.
- Première version : crafting 2x2/3x3, avec ou sans forme imposée. Les autres procédés et recettes spéciales
  non représentables correctement sont déclarés non pris en charge, jamais transformés en fausse grille.

## Points d'intégration vérifiés avant implémentation

- `src/agent/WorkflowAgent.ts::askPlanner` réalise actuellement un appel structuré unique.
- `prompts/planner.md` dit actuellement « single-shot » et interdit les tools.
- `src/agent/ArchitectAgent.ts` fournit déjà une conversation privée, des appels/résultats natifs,
  du feedback texte lisible, un budget de contexte, une annulation et un retour terminal.
- `src/agent/ToolCatalogBuilder.ts` et `AgentToolBridge.ts` exposent déjà `list_skills` / `load_skill`
  à l'actionneur. Leur existence ne rend pas le planner conversationnel.
- `src/capabilities/Craft.ts` utilise `bot.recipesAll`. Cette méthode filtre les recettes nécessitant
  une table si aucune table n'est fournie. Ne pas la réutiliser telle quelle pour lire les connaissances.
- Les données de recettes utilisées par Mineflayer existent déjà dans les dépendances installées.
  Les consulter par un adaptateur indépendant de la présence physique d'une table et du stock du bot.
- `MaterialCatalog` fournit déjà la validation des noms et des suggestions ; réutiliser la logique utile.

## Format visible par l'agent

```text
wooden_axe x1
Grid: 3x3 | Station: crafting_table

A = oak_planks x3
B = stick x2

[A] [A] [ ]
[A] [B] [ ]
[ ] [B] [ ]
```

La grille affichée correspond à la station minimale 2x2 ou 3x3. Le motif peut occuper moins de cases.
Pour une recette sans forme imposée, afficher `Placement: any order` et les ingrédients, sans inventer
de positions obligatoires. Les quantités des recettes avec forme sont dérivées des cases, pas maintenues
une seconde fois dans la légende. Conserver les rendements et éventuels restes réels ; une recette avec
un mécanisme non supporté doit donner un diagnostic explicite.

## Lot 1 — Fichiers, lecture et validation

- [x] Définir un schéma minimal par objet : nom de sortie, version Minecraft ciblée et variantes.
  Chaque variante contient rendement, type, station, palette et motif, ou liste d'ingrédients sans forme.
- [x] Utiliser des noms de fichier tels que `recipes/wooden_axe.json` et `recipes/stick.json`.
  Le nom de l'objet doit correspondre au fichier ; le tool reçoit un nom d'objet, jamais un chemin libre.
- [x] Créer un petit `src/recipes/` avec types/schéma, bibliothèque et validation ; pas de base générique
  commune aux skills et à la mémoire à ce stade.
- [x] Valider la syntaxe JSON, les noms d'items, les cellules/palettes, les dimensions, les rendements
  positifs et la cohérence de la station. Une fiche invalide produit une erreur avec fichier et champ.
- [x] Recouper les fiches initiales avec le catalogue de recettes de la version ciblée : ingrédients,
  disposition, rendement et besoin de table. Une validation de forme seule ne prouve pas une vraie recette.
- [x] Garder distincts : fiche absente, fichier invalide, nom Minecraft inconnu, recette non reconnue
  dans le catalogue ciblé et format de recette non supporté. Aucun de ces cas ne devient silencieusement
  « impossible à obtenir ». Les datapacks serveur ne sont pas automatiquement connus de ce catalogue.
- [x] Charger une bibliothèque stable au démarrage ; après édition manuelle, redémarrer pour recharger
  dans cette première version. Pas de watcher ni de nouvel argument d'environnement nécessaire.
- [x] Préparer les premières fiches depuis les données disponibles et les vérifier : `oak_planks`,
  `stick`, `crafting_table`, `wooden_axe`, `wooden_pickaxe`, `wooden_sword`, `stone_pickaxe`, `furnace`.
  La couverture initiale est annoncée comme partielle.
- [x] Pour les variantes, enregistrer des recettes concrètes valides. Ne pas présenter toutes les
  combinaisons possibles ni fusionner des ingrédients en alternatives sans en avoir vérifié l'équivalence.

Acceptation : la fiche de hache contient trois planches, deux sticks, un résultat et une table 3x3 ;
elle reste lisible lorsque le bot n'a aucun ingrédient et aucune table. Une grille aux bons ingrédients
mais à la mauvaise disposition est détectée comme non conforme au catalogue ciblé.

## Lot 2 — Recherche, lecture et rendu compact

- [x] Ajouter `search_recipes({ query })` : classement simple par nom exact, mots et correspondances
  approchées. Retourner uniquement les objets documentés, avec nom et bref aperçu, cinq résultats par défaut.
- [x] Ajouter `read_recipe({ item, variant? })` : lire une fiche exacte ; numéro de variante optionnel,
  indexé à partir de 1. Afficher la première par défaut et un bref index des autres variantes disponibles.
- [x] Produire la grille avec brackets et cases vides `[ ]`, sans recopier le JSON de stockage au modèle.
- [x] Afficher résultat par craft, station et légende avec quantités calculées. Une recette qui produit
  quatre sticks doit clairement afficher `stick x4`.
- [x] Borner la taille des résultats et distinguer un résultat incomplet d'une absence de résultat.
  Les constantes restent dans la configuration du projet. Ne pas tronquer une grille au milieu d'une ligne.
- [x] Pour un nom approché, suggérer des noms ; ne pas choisir silencieusement un autre objet.
- [x] En cas d'absence, retourner le message :
  `No recipe found in the current recipe library. This does not mean the item cannot be crafted or obtained.`
- [x] Partager une même implémentation des tools entre planner et actionneur, avec des listes explicites
  par rôle. Éviter d'ajouter ces tools à toutes les queries du coordinateur par effet de bord.
- [x] Conserver les résultats structurés dans les traces et fournir la fiche en texte lisible dans
  la conversation, comme le feedback de dessin de l'Architect. Ne pas doubler le contenu dans l'historique.

Acceptation : `search_recipes("axe")` permet de trouver la hache documentée ; `read_recipe` produit
exactement une fiche lisible. Une fiche de sticks explicite le rendement quatre ; une fiche absente
n'est jamais présentée comme la preuve d'un craft impossible.

## Lot 3 — Planner avec sa propre conversation

- [x] Extraire la délégation dans un `PlannerAgent` focalisé, en s'appuyant sur les mécanismes des agents
  existants : `MessageHistory`, `ContextCompactor`, `completeWithinBudget`, validation des arguments et logs.
- [x] Initialiser la conversation privée avec le prompt planner, la discussion utilisateur pertinente,
  la délégation et les snapshots tâche/monde/blueprint déjà disponibles.
- [x] Garder la discussion et les résultats des tools pendant la délégation. Une nouvelle délégation
  repart avec un contexte neuf alimenté par les informations du coordinateur.
- [x] Exposer `search_recipes`, `read_recipe` et `submit_plan`. L'actionneur reste responsable des capabilities.
- [x] Autoriser une note opérationnelle concise avec un seul appel natif par réponse. Aucune phase
  obligatoire de recherche ou de review ; le planner décide de la consultation utile.
- [x] Faire de `submit_plan({ steps })` la sortie terminale, en réutilisant `PlannerResultSchema`.
  Un plan invalide renvoie un feedback dans la même conversation, puis le planner peut le corriger.
- [x] Remplacer la checklist du coordinateur seulement après soumission valide. Les recherches et lectures
  intermédiaires ne remplacent pas le plan courant ; une interruption/erreur conserve ce plan.
- [x] Appliquer le budget d'entrée partagé de 20k tokens estimés, la sortie configurée, `AbortSignal`
  et les retries existants. Prévoir une limite de boucle dans la configuration du code
  (valeur initiale proposée : 16 tours, à mesurer), sans ajouter cette information au prompt.
- [x] Enregistrer chaque appel planner et ses tools dans l'inspecteur et le journal global, sans capture
  d'inventaire pour ces consultations. Réutiliser les numéros d'action et les cartes existants.
- [x] Retourner au coordinateur le plan validé et un petit état de couverture des recettes consultées,
  sans recopier toutes les fiches ni la conversation privée. Rendre visibles les connaissances manquantes.
- [x] Conserver aux délégations actionneur les contraintes utiles du plan : quantités, rendement retenu,
  station et recette choisie si nécessaire. L'actionneur peut relire la fiche pour une correction.

Acceptation : une délégation peut faire recherche → lecture → autre lecture → `submit_plan`, avec
les résultats présents dans les appels suivants. Une soumission invalide est corrigée ; le stop
interrompt la boucle ; seul un plan valide remplace la checklist.

## Lot 4 — Prompts, intégration et vérification

- [x] Modifier précisément `prompts/planner.md` : retirer « single-shot », l'interdiction de tools et
  l'ancienne sortie JSON libre ; décrire la conversation, les tools de consultation et `submit_plan`.
- [x] Demander de vérifier les recettes documentées avant de fixer quantités/stations. Si une fiche
  manque, conserver l'incertitude ; ne pas affirmer que l'objet est impossible ni multiplier les lectures identiques.
- [x] Calculer les lots entiers et tenir compte du stock initial et de la fabrication des stations.
  Par exemple, sept planches demandées peuvent nécessiter deux bûches et produire huit planches.
- [x] Donner à l'actionneur une consigne ciblée pour consulter les fiches lorsqu'il rencontre un doute
  de recette ou un échec de crafting. Préserver les autres modifications personnelles des prompts.
- [x] Maintenir la responsabilité du coordinateur : objectif, contraintes et faits au planner,
  sans imposer sa propre recette. Ne pas ajouter de nouvelle procédure générale aux skills existants.
- [x] Tester bibliothèque et rendu : hache, sticks, planches, table, variantes, recette sans forme,
  nom inconnu, fiche manquante/invalide, réponse bornée et chemin de fichier non autorisé.
- [x] Tester la validation catalogue, indépendante de l'inventaire et de la présence d'une table.
  Distinguer compatibilité au catalogue de la version et confirmation physique par le serveur.
- [x] Tester le planner avec un faux client LLM : plusieurs consultations, contexte conservé,
  correction d'arguments/plan, dépassement de budget, plafond de boucle, annulation et retour au coordinateur.
- [x] Vérifier que la consultation n'appelle pas une capability et ne modifie ni monde ni inventaire.
- [x] Tester la continuité des logs : ordre des calls, numéros partagés, outils et résultats visibles,
  affichage de la fiche avec brackets et absence de faux succès sur une erreur.
- [x] Actualiser `docs/architecture.md`, `docs/agent-workflow.md`, `docs/tools.md` et les instructions
  d'ajout/édition de recettes. Expliquer quelles limites sont vérifiées automatiquement.
- [x] Exécuter `npm.cmd test` après intégration.
- [x] Préparer un essai planner isolé de la même demande hache + abri : `npm.cmd run smoke:planner`,
  fixture dédiée, vrai prompt/catalogue, aucun accès Minecraft, rapport JSON et traces de session.
- [ ] Lancer cet essai avec le vrai LLM et examiner son plan avant une nouvelle campagne réelle.
  Un essai LLM vérifie un comportement observé, pas une garantie générale.
- [ ] Lors de la validation Minecraft décidée ensemble, contrôler indépendamment hache, matériaux et
  abri, et comparer nombre d'appels, erreurs de recette et durée avec la session de référence.

## Suite possible, hors première version

- [ ] Éditeur de recettes dans la UI existante : recherche, formulaire/grille, aperçu de fiche,
  validation avant sauvegarde et rechargement explicite. Réutiliser le même schéma et le même renderer.
- [ ] Acquisition de nouvelles fiches par le bot : propositions distinctes des recettes vérifiées ;
  un texte plausible ne suffit pas à valider une nouvelle recette.
- [ ] Recherche sémantique des skills, apprentissage, mémoire et support d'autres procédés de fabrication.

Ces éléments sont des pistes, pas des prérequis des lots 1 à 4. La première version vise les erreurs
de connaissance des recettes ; elle ne corrige pas les refus de pose ni le nettoyage de scaffolding.

## Journal de livraison

- 14 octobre 2026 : plan créé après inspection des agents, skills et moteur de crafting existants.
  Demande confirmée : le planner a sa propre conversation et rend la main par un tool terminal,
  selon le même fonctionnement que les autres agents. Aucun code modifié, aucun test ou LLM lancé.
- 14 octobre 2026 : lots 1–4 livrés. Huit fiches vérifiées contre minecraft-data 1.21.11,
  tools de recherche/lecture partagés, planner privé natif avec submit_plan, feedback lisible,
  numérotation partagée, compression et annulation. Prompts et docs actualisés ; aucune nouvelle dépendance.
  `npm.cmd test` : compilation, typage tests/scripts et 628 tests réussis (0 échec).
  Tests lancés hors sandbox après des EPERM sur les renommages atomiques temporaires ; faux LLM uniquement.
  Le smoke LLM isolé est prêt mais non exécuté. Aucun serveur, bot ou modèle en cours n'a été redémarré.

