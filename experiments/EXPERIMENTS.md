# Premières expériences Jev

Tout reste dans `experiments`. Aucun fichier du projet Minecraft parent n'est
modifié ou importé. Les notebooks ne se connectent pas au serveur de jeu.
Le modèle est `guoan1/jev-qwen35-08b`, chargé hors ligne avec les révisions déjà
épinglées dans la sandbox. Le CPU est forcé pour les deux expériences.

## Ouvrir les notebooks

Depuis Jupyter Anaconda, choisir **Minecraft experiments - Jev 0.8B**.

- `Wood_Agent.ipynb` : modifier le quota et l'inventaire, exécuter une récolte
  simulée, lire les probabilités à chaque transition, comparer à une règle fixe,
  et sonder les erreurs d'arrêt du modèle.
- `CPU_Benchmark.ipynb` : consulter les mesures enregistrées ou mettre
  `RUN_BENCHMARK = True` pour tester de nouveau la taille du texte, le nombre
  de candidats et le nombre de threads. Les tableaux indiquent le matériel et
  le réglage utilisés ; ne pas comparer des résultats de machines différentes
  sans conserver ces informations.

Chaque notebook charge son modèle une fois. Les dernières cellules libèrent
le modèle. Un redémarrage du kernel permet de repartir de zéro.

## Ce que signifie « agent avec Jev seulement »

Jev est le seul modèle de décision. Les outils et les règles du monde restent
du code : chercher un arbre, approcher, couper une bûche, ramasser et attendre.
Le modèle classe les transitions proposées ; il ne crée pas de nouvelles actions
et ne produit pas de plan ou de code. Les valeurs numériques de la consigne sont
fournies par l'expérimentateur, sans interpréteur génératif.

Le graphe masque les actions dont les préconditions ne sont pas satisfaites.
Par exemple, couper exige un arbre à portée et ramasser exige des objets proches.
L'arrêt est une vérification d'inventaire, exécutée avant chaque appel et après
chaque action. Jev n'a pas besoin de confirmer un comptage que le code peut faire.

Le mode strict ne propose pas `wait` quand aucun événement ne peut faire évoluer
le monde : toutes les actions de cette simulation sont atomiques. Avec
`include_wait=True`, on peut observer les blocages dus à l'attente. Si une seule
action est admissible, `skip_single_choice=True` l'exécute sans appel modèle.
La trace indique explicitement `sole_legal_action` ou `jev`. Ces transitions
forcées ne démontrent aucune compétence du modèle.

`collect_new` signifie ramasser N bûches supplémentaires. `inventory_total`
signifie atteindre N bûches en tout. Les planches et les objets au sol ne comptent
pas. `LOG_ITEMS` définit les espèces acceptées ; ce prototype utilise du chêne.

Le mode non masqué laisse Jev voir toutes les actions, mais l'exécuteur continue
de refuser les actions impossibles et l'arrêt prématuré. Les tests d'arrêt à 0,
9, 10 et 11 bûches sont diagnostiques : leurs choix ne sont pas exécutés.

La simulation est un monde en une dimension avec des skills atomiques. Elle ne
mesure ni les mobs, ni la physique de Minecraft, ni le pathfinding ou la latence
du serveur. Une réussite ici ne prouve pas que le bot réel fonctionne. Pour
passer au jeu, un adaptateur séparé devra implémenter observation et exécution
sans importer les actions du projet parent.

Le premier essai avec attente libre s'est bloqué sans ramasser de bûches.
L'ajout des arbres visibles à l'observation n'a pas suffi ; le modèle préférait
encore attendre, en JSON comme en texte court. Le notebook conserve ce contrôle
en plus du mode strict. Sur cette tâche simple, le graphe et l'exigence
déterministe peuvent assurer l'essentiel du comportement. Il faut comparer les
résultats à la règle fixe pour évaluer l'intérêt réel du modèle.

## Coût des requêtes

Une question `choice` avec K actions crée K entrées candidates, regroupées dans
un batch. L'état est répété pour chacune. `noul` utilise une seule entrée.
Plusieurs questions sont évaluées successivement par le client de cette sandbox.
Les tokens totaux comptés par `meta.input_tokens` sont donc la somme de ces
entrées, et non la longueur d'un unique contexte partagé.

Le compilateur du runtime accepte de 1 à 255 candidats pour `choice`, et de 2
à 10 niveaux pour `score`. Ce sont des limites de validation, pas des tailles
que ce benchmark recommande : il mesure 2, 4 et 8 candidats. La mémoire et le
temps de calcul restent à considérer pour augmenter ces nombres.

La limite de ce checkpoint est **768 tokens par entrée candidate formatée** :
état, question, description de l'action et chat template compris. Le runtime
refuse les entrées trop longues sans les tronquer. La limite du Qwen de base
ne doit pas être assimilée à une capacité validée de cette variante Jev.

Le benchmark mesure des requêtes séquentielles, après une chauffe par cas,
sur CPU float32. La médiane inclut compilation, tokenisation, forward et réponse ;
le chargement et les actions du monde sont séparés. `requêtes/s` est l'inverse
de cette médiane, pas une mesure de concurrence. Le remplissage des longues
entrées est synthétique : ces mesures de vitesse ne valident pas leur qualité.
Quelques répétitions ne suffisent pas pour estimer des percentiles extrêmes.
Le champ de chargement du modèle exclut les imports Python et la première
inférence ; il ne représente pas le démarrage complet d'une application.

## Reproduire et vérifier

Dans PowerShell, depuis `experiments` :

```powershell
.\.venv\Scripts\python.exe -m unittest test_wood_agent -v
.\.venv\Scripts\python.exe -u run_experiments.py --repetitions 5
```

Les résultats JSON, les CSV et les notebooks exécutés vont dans `runs`, déjà
ignoré par Git. `cpu_benchmark_latest.json` fournit la dernière matrice mesurée.
Les fichiers horodatés conservent les anciennes mesures. Les traces d'épisodes
conservent les probabilités, les actions, l'inventaire et les échecs observés.

Source du format et de la limite :
[fiche de guoan1/jev-qwen35-08b](https://huggingface.co/guoan1/jev-qwen35-08b).

## Résultats observés le 2 octobre 2026

Sur un **AMD Ryzen 7 9800X3D, 8 threads, CPU float32**, après chauffe et avec
cinq répétitions par cas : oui/non de 128 tokens à 324 ms ; 4 candidats de
128 tokens à 1 150 ms ; 4 candidats de 256 tokens à 2 301 ms ; 8 candidats de
768 tokens à 13 705 ms. Les requêtes longues et les candidats supplémentaires
augmentent nettement le coût. Les mesures concernent le runtime actuel avec
les implémentations PyTorch de repli des couches DeltaNet.

Le mode strict a obtenu 10 nouvelles bûches en 22 étapes, dont 10 appels Jev
et 12 transitions forcées, pour environ 11,1 s d'inférence. Avec 3 bûches au
départ et une demande de 10 nouvelles bûches, il s'est arrêté à 13. Avec 10
bûches déjà présentes et un objectif de 10 au total, aucun appel modèle n'a eu
lieu. Avec seulement 2 bûches disponibles pour une demande de 3, il s'est arrêté
en échec `no_resources` à 2 bûches.

L'attente libre reste un échec à 0 bûche après 6 décisions. Dans les sondes
d'arrêt, le modèle ne choisit pas `stop` à 10 ou 11 bûches et sa probabilité
oui/non d'atteinte de l'objectif reste inférieure à 0,04 sur ces deux états.
Ces quelques cas ne constituent pas une évaluation générale du modèle, mais
ils montrent pourquoi le comptage et l'arrêt doivent rester déterministes ici.

La réussite du mode strict ne démontre pas une planification autonome : le
graphe contraint fortement la tâche. La règle fixe résout aussi cette simulation,
sans coût d'inférence. Les deux parcours et les probabilités restent consultables.
