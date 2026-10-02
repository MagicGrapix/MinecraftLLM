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
