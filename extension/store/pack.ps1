# Build a Chrome Web Store upload zip from extension/chrome.
# Output: extension/store/clocked-chrome-store.zip
# Also refreshes extension/clocked-chrome.zip (stable sideload / GitHub release name).
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$src = Join-Path $repoRoot 'extension\chrome'
$stage = Join-Path $repoRoot 'extension\store\_stage'
$storeZip = Join-Path $repoRoot 'extension\store\clocked-chrome-store.zip'
$stableZip = Join-Path $repoRoot 'extension\clocked-chrome.zip'

if (-not (Test-Path (Join-Path $src 'manifest.json'))) {
    throw "Missing extension source: $src"
}

Write-Host "Packing store zip from $src" -ForegroundColor Cyan
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

foreach ($f in @('manifest.json', 'background.js', 'options.html', 'options.js', 'popup.html', 'popup.js')) {
    Copy-Item (Join-Path $src $f) (Join-Path $stage $f)
}
Copy-Item (Join-Path $src 'icons') (Join-Path $stage 'icons') -Recurse

if (Test-Path $storeZip) { Remove-Item $storeZip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $storeZip -Force
Copy-Item $storeZip $stableZip -Force
Remove-Item $stage -Recurse -Force

Write-Host "Store upload: $storeZip" -ForegroundColor Green
Write-Host "Stable sideload: $stableZip" -ForegroundColor Green
Get-Item $storeZip | Format-List FullName, Length, LastWriteTime
