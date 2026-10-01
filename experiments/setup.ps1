param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$taskVenvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$taskPipCache = Join-Path $PSScriptRoot '.cache\pip'
if (-not (Test-Path -LiteralPath $taskVenvPython)) {
    & $Python -m venv (Join-Path $PSScriptRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated Python environment.' }
}
& $taskVenvPython -m pip install --cache-dir $taskPipCache 'torch==2.11.0' --index-url https://download.pytorch.org/whl/cu128 --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed.' }
& $taskVenvPython -m pip install --cache-dir $taskPipCache -r (Join-Path $PSScriptRoot 'requirements.txt') --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
& $taskVenvPython (Join-Path $PSScriptRoot 'download_model.py')
if ($LASTEXITCODE -ne 0) { throw 'Model download failed. Re-run setup.ps1 to resume.' }
& $taskVenvPython (Join-Path $PSScriptRoot 'register_kernel.py')
if ($LASTEXITCODE -ne 0) { throw 'Jupyter kernel registration failed.' }
& $taskVenvPython -m pip freeze | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'requirements.lock.txt') -Encoding utf8
Write-Host 'Ready. Open Dev.ipynb in Anaconda Jupyter and select Minecraft experiments - Jev 0.8B.'
