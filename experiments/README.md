# Sandbox Jev

Ouvrir `Dev.ipynb` depuis Jupyter Notebook ou JupyterLab lancé avec Anaconda.
Sélectionner le kernel **Minecraft experiments - Jev 0.8B**. S'il n'apparaît pas,
actualiser la page ou relancer Jupyter.

Le notebook charge le modèle une fois, puis permet de modifier librement les
états, les questions et les options : classification `choice`, oui/non `noul`,
et score sur une échelle `score`. Les exemples sont saisis à la main.

Le calcul est local, sans clé TypeSafe. Les téléchargements ont lieu pendant
le setup ; les inférences du notebook utilisent les fichiers en cache hors ligne.
Le modèle ne contrôle pas le bot Minecraft.

## Installation et lancement

Le setup installe les dépendances dans `experiments/.venv`, sans modifier
l'environnement Anaconda de base. Le kernel enregistré permet à Jupyter Anaconda
d'utiliser cet environnement isolé.

Pour refaire le setup depuis PowerShell, dans ce dossier :

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Alternative pour lancer JupyterLab directement avec cet environnement :

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

## Modèle et limites

- Adaptateur : [guoan1/jev-qwen35-08b](https://huggingface.co/guoan1/jev-qwen35-08b),
  révision `62986e6dce924fff167dea9d7469b01f9e7e7ff2`.
- Base : Qwen/Qwen3.5-0.8B-Base, révision
  `dc7cdfe2ee4154fa7e30f5b51ca41bfa40174e68`.
- L'implémentation de l'auteur, incluse avec le checkpoint, est utilisée pour
  construire les entrées et convertir les scores en probabilités.
- Limite : **768 tokens par prompt de candidat**, comprenant l'état, la question,
  la description de ce candidat et le formatage. Une entrée trop longue lève
  une erreur ; elle n'est pas tronquée silencieusement.
- `DEVICE = "auto"` choisit le GPU si CUDA est disponible et au moins 4 Gio sont
  libres, sinon le CPU. Le CPU est plus lent ; choisir explicitement `"cuda:0"`
  permet de tester le GPU après avoir libéré de la mémoire.
- Le modèle communautaire n'est pas le Jev officiel de TypeSafe. Sa qualité et
  ses probabilités doivent être évaluées sur vos propres exemples, notamment
  en français. Le champ `confidence` ne représente pas une garantie de justesse.

Les poids, caches, environnements et sorties d'essais sont ignorés par Git via
le `.gitignore` local. `requirements.lock.txt` décrit les versions installées.

## Vérification du setup — 1 octobre 2026

Toutes les cellules de `Dev.ipynb` ont été exécutées hors ligne sur la RTX 5080.
Le notebook exécuté est conservé dans `runs/Dev.executed.ipynb`.
Le kernel est visible depuis le Jupyter de l'installation Anaconda existante.
Un appel oui/non sur CPU a également réussi.

Ces vérifications confirment le fonctionnement de la sandbox, pas la qualité
générale du modèle. Dans l'exemple Minecraft avec peu de vie et un zombie proche,
le modèle reconnaît le danger et le risque élevé, mais choisit de continuer
à récolter. Garder ce cas pour explorer la cohérence des décisions.
