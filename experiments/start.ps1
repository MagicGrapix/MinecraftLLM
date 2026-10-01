$ErrorActionPreference = 'Stop'
$taskPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$taskEnvPrefix = Join-Path $PSScriptRoot '.venv'
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'Run setup.ps1 first.' }
$env:JUPYTER_CONFIG_DIR = Join-Path $PSScriptRoot '.cache\jupyter-config'
$env:JUPYTER_DATA_DIR = Join-Path $PSScriptRoot '.cache\jupyter-data'
$env:JUPYTER_RUNTIME_DIR = Join-Path $PSScriptRoot '.cache\jupyter-runtime'
$env:IPYTHONDIR = Join-Path $PSScriptRoot '.cache\ipython'
$env:HF_HOME = Join-Path $PSScriptRoot '.cache\huggingface'
$env:HF_HUB_CACHE = Join-Path $PSScriptRoot '.cache\huggingface\hub'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:PYTHONNOUSERSITE = '1'
# Let the standalone launcher use the same named kernel as Anaconda.
& $taskPython -m ipykernel install --prefix $taskEnvPrefix --name minecraft-jev --display-name 'Minecraft experiments - Jev 0.8B'
if ($LASTEXITCODE -ne 0) { throw 'Could not register the local Jupyter kernel.' }
& $taskPython -m jupyterlab (Join-Path $PSScriptRoot 'Dev.ipynb') --ServerApp.ip=127.0.0.1 --ServerApp.root_dir=$PSScriptRoot
