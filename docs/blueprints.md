# Blueprints — bibliothèque hors ligne

Le lot 1 fournit le format, la validation, les suggestions de noms, le calcul des matériaux et le stockage.
Il ne connecte aucun bot, ne contacte aucun LLM et ne modifie pas Minecraft. Aucun nouveau tool n'est encore exposé aux agents.
L'Architect, `submit_blueprint`, `lookup_material` côté agent et `build` restent dans les lots suivants du [plan](plans/blueprint-builder.md).

## Composants

- `src/world/MaterialCatalog.ts` reçoit un registre `minecraft-data` ou Mineflayer et capture les noms de sa version.
- `src/building/Blueprint.ts` définit le schéma strict et les données compilées.
- `src/building/BlueprintValidator.ts` valide un objet inconnu et produit cellules, placements et facture d'items.
- `src/building/BlueprintStore.ts` enregistre et relit les blueprints acceptés.
- `src/building/BuildingConfig.ts` contient les limites et la liste explicite des blocs pleins admis.

Exemple d'utilisation dans un script, sans démarrer Minecraft :

```typescript
import minecraftData from "minecraft-data";
import { MaterialCatalog } from "./src/world/MaterialCatalog";
import { BlueprintValidator } from "./src/building/BlueprintValidator";
import { BlueprintStore } from "./src/building/BlueprintStore";

const catalog = new MaterialCatalog(minecraftData("1.21.11"));
const validator = new BlueprintValidator(catalog);
const store = new BlueprintStore(validator); // data/blueprints, relatif au cwd du programme

catalog.search("oak_plate"); // exact: null ; suggestions seulement, pas de substitution
const input = {
  name: "two_blocks",
  description: "Two oak planks with one required empty cell.",
  width: 3,
  depth: 1,
  palette: { A: "oak_planks" },
  layers: [["AA."]],
  dependencies: { doors: [] },
};
const checked = validator.validate(input);
// Dans une fonction async :
// const saved = await store.save(input);
// if (saved.ok) console.log(await store.load(saved.value.id));
```

Pour le futur runtime connecté, injecter `bot.registry` au lieu de choisir une version indépendante.
Le catalogue ne promet ni disponibilité en inventaire, ni recette, ni existence de ressources dans le monde.

## Format et repère

- `layers[y][z][x]` : couches du bas vers le haut, lignes vers le sud (+Z), colonnes vers l'est (+X).
- `width` et `depth` sont des entiers positifs ; la hauteur est le nombre de couches.
- Chaque ligne a exactement `width` caractères, chaque couche exactement `depth` lignes.
- Une lettre majuscule ASCII désigne un bloc de `palette`.
- `.` représente de l'air **requis** ; `_` représente une cellule ignorée. Les deux ne coûtent aucun item.
- Les positions des cellules et opérations compilées sont locales et entières ; elles ne sont pas des coordonnées monde.
- Le résultat `operations` est une liste géométrique dans l'ordre Y/Z/X, pas une preuve de constructibilité ni un planning de navigation.

Limites : largeur/profondeur 8, hauteur 5, palette 16 entrées, dépendances portes 16, fichier 65 536 octets.
Les chaînes, tableaux, coordonnées et champs supplémentaires sont validés sans conversion implicite.
Les erreurs détaillées sont limitées à 20 ; `totalIssues` indique leur nombre total.

La palette accepte les planches listées dans `BuildingConfig.ts`, cobblestone, stone, dirt et glass, seulement si ces blocs et leurs items existent dans le registre injecté.
Un bloc reconnu n'est pas automatiquement accepté : sable, bûches orientables, portes dans la palette, liquides, etc. sont refusés.
Le préfixe `minecraft:` est normalisé ; les autres namespaces, catégories et fautes ne deviennent jamais des correspondances exactes.

## Portes : réservées, pas encore prises en charge

`dependencies.doors` possède déjà un schéma de position locale, item et orientation cardinale.
Mais toute dépendance de porte provoque actuellement `UNSUPPORTED_DEPENDENCY`. Elle ne peut pas être enregistrée comme blueprint accepté.
La validation d'emprise, le développement en deux moitiés, le comptage d'un seul item et la pose appartiennent au lot 3.

Fixtures :

- `tests/fixtures/blueprints/small-oak-shelter.json` : accepté, 5×5×4, 80 placements, 20 cellules d'air requis ; **55 oak_planks + 25 cobblestone**.
- `tests/fixtures/blueprints/small-oak-house.json` : exemple futur avec porte, accepté par le schéma de forme mais rejeté par la validation fonctionnelle actuelle.

## Résultats et erreurs

Les méthodes `validate`, `save` et `load` utilisent la forme `TaskResult` existante : `ok/value` ou `ok/error`.
Cette réutilisation d'enveloppe n'exécute pas de capability.

`validate` retourne en succès le blueprint normalisé, la version Minecraft, la hauteur, toutes les cellules,
les opérations de blocs pleins et les matériaux agrégés par nom d'item. Il ne modifie pas l'objet fourni.
Un dessin sans bloc à placer est refusé. Un dessin peut être valide sans être accessible ou habitable.

En échec, `code` vaut `INVALID_ARGUMENT`, `facts.reason` vaut `INVALID_BLUEPRINT` et `facts.issues` contient des erreurs localisées :

- `INVALID_SHAPE` : mauvais type, dimension, caractère ou champ.
- `UNKNOWN_SYMBOL` : lettre absente de la palette, avec position locale.
- `UNKNOWN_BLOCK` : nom inexistant, avec alternatives proposées.
- `UNSUPPORTED_BLOCK` : bloc reconnu mais comportement non pris en charge.
- `MISSING_PLACEMENT_ITEM` : bloc autorisé sans item correspondant dans cette version.
- `UNSUPPORTED_DEPENDENCY` : porte non prise en charge actuellement.
- `EMPTY_BLUEPRINT` : rien à construire.

`MaterialCatalog.resolve(kind, name)` ne fait que la correspondance exacte avec normalisation du préfixe.
`search(query, kind = "block")` accepte 1 à 128 caractères après trim ; un argument hors limites lève `RangeError`.
La recherche suggère au plus cinq noms, classés par égalité, préfixe/sous-chaîne, mots et proximité orthographique avec ordre stable en cas d'égalité.
La normalisation de casse/espaces sert uniquement à suggérer, jamais à transformer un nom erroné en correspondance exacte.

## Persistance

`save` valide avant de créer le répertoire. Chaque sauvegarde reçoit un nouvel ID `bp_<uuid>` généré en code.
Le nom donné au dessin n'est jamais utilisé comme chemin. Une nouvelle version est un nouveau fichier ; il n'existe pas d'opération d'écrasement.

L'écriture utilise un fichier temporaire exclusif dans le même répertoire, un flush, puis la publication atomique par lien physique.
Ce choix évite le remplacement que permettrait un `rename` sur une référence existante. Une collision échoue sans toucher le fichier publié.
Le système de fichiers doit accepter les liens physiques (testé sur le volume Windows local du projet) ; pas de repli vers une écriture non atomique.
Le temporaire est nettoyé ensuite ; un crash peut laisser un `.tmp` inutilisé, jamais chargé comme blueprint.

Le fichier contient `id`, `formatVersion`, `minecraftVersion`, `blueprint` et `materials`. Les cellules et opérations sont recalculables et ne sont pas dupliquées sur disque.
`load` vérifie l'ID, lit au plus limite+1 octets, contrôle l'enveloppe/version, revalide le dessin et compare la facture sauvegardée au calcul frais.
Un fichier corrompu reste intact pour inspection. Un changement de version Minecraft exige une nouvelle soumission explicite.
Le répertoire est choisi par l'application ; les fichiers ne sont ni une preuve de permission de construire, ni une mémoire LLM rechargée automatiquement.

Erreurs de stockage :

- `INVALID_ARGUMENT`, raison `INVALID_BLUEPRINT_ID` ou `INVALID_BLUEPRINT_FILE` : mauvaise référence ou fichier invalide.
- `TARGET_NOT_FOUND` : référence valide mais absente.
- `WORLD_CHANGED`, raison `BLUEPRINT_VERSION_MISMATCH` : version Minecraft différente.
- `INTERNAL_ERROR`, raison `BLUEPRINT_IO_ERROR` : erreur de système de fichiers, dont collision d'ID.
- Les erreurs de revalidation du dessin conservent le feedback détaillé `INVALID_BLUEPRINT`.

Les fichiers générés sous `data/blueprints/` sont ignorés par Git ; les fixtures manuelles restent versionnées.

## Vérification

```powershell
node -r ts-node/register --test tests/unit/building/BlueprintValidator.test.ts tests/unit/building/BlueprintStore.test.ts tests/unit/world/MaterialCatalog.test.ts
npm.cmd test
```

Ces tests chargent les données locales de Minecraft et utilisent des répertoires temporaires pour le stockage. Aucun serveur Minecraft ni appel Ollama/LLM.
